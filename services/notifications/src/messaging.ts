import {
  DEFAULT_MESSAGE_TEMPLATES,
  DOCUMENT_CAPTION_MAX_CHARS,
  ICS_FORMAT_VERSION,
  NOTIFICATION_MAX_ATTEMPTS,
  buildIcsEvent,
  icsFilename,
  icsFormatVersionOf,
  numberedOptions,
  renderMessage,
  type AppointmentSummary,
  type Channel,
  type ChannelId,
  type DocumentNotificationKind,
  type MessageTemplate,
  type NotificationFilters,
  type NotificationRecord,
  type OutboundButton,
  type OutboundDocument,
  type Paginated,
} from '@odontocrm/contracts';
import { ConflictError, NotFoundError } from '@odontocrm/kernel';
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';

import type { AdapterRegistry } from './canales/adaptador.js';
import { CanalNoDisponibleError, CanalSaturadoError } from './canales/whatsapp/limitador.js';
import type { NotificationsConfig } from './config.js';
import { retryDelays } from './config.js';
import type { NotificationsDb } from './db/client.js';
import {
  botConversations,
  icsArtifacts,
  messageTemplates,
  notifications,
  patientChannels,
  type IcsArtifactRow,
  type MessageTemplateRow,
  type NotificationRow,
  type PatientChannelRow,
} from './db/schema.js';
import { icsSha256 } from './ics-hash.js';

/* ── Plantillas ────────────────────────────────────────────────────────────── */

export const toMessageTemplate = (row: MessageTemplateRow): MessageTemplate => ({
  key: row.key,
  channel: row.channel as Channel,
  subject: row.subject,
  body: row.body,
  isActive: row.isActive,
  updatedAt: row.updatedAt.toISOString(),
});

export const listTemplates = async (db: NotificationsDb): Promise<MessageTemplate[]> => {
  const rows = await db.select().from(messageTemplates).orderBy(asc(messageTemplates.key));
  return rows.map(toMessageTemplate);
};

const templateByKey = async (
  db: NotificationsDb,
  key: string,
): Promise<MessageTemplateRow | null> => {
  const rows = await db
    .select()
    .from(messageTemplates)
    .where(eq(messageTemplates.key, key))
    .limit(1);
  return rows[0] ?? null;
};

export const updateTemplate = async (
  db: NotificationsDb,
  key: string,
  input: { subject?: string | null | undefined; body: string; isActive?: boolean | undefined },
): Promise<MessageTemplate> => {
  const current = await templateByKey(db, key);
  if (current === null) throw new NotFoundError(`La plantilla «${key}» no existe`);

  const rows = await db
    .update(messageTemplates)
    .set({
      body: input.body,
      ...(input.subject === undefined ? {} : { subject: input.subject }),
      ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
      updatedAt: new Date(),
    })
    .where(eq(messageTemplates.key, key))
    .returning();

  const updated = rows[0];
  if (updated === undefined) throw new NotFoundError(`La plantilla «${key}» no existe`);
  return toMessageTemplate(updated);
};

export const resetTemplate = async (db: NotificationsDb, key: string): Promise<MessageTemplate> => {
  const fallback = DEFAULT_MESSAGE_TEMPLATES.find((template) => template.key === key);
  if (fallback === undefined)
    throw new NotFoundError(`La plantilla «${key}» no tiene texto por defecto`);

  await db
    .insert(messageTemplates)
    .values({ key, channel: 'telegram', subject: fallback.subject, body: fallback.body })
    .onConflictDoUpdate({
      target: messageTemplates.key,
      set: {
        subject: fallback.subject,
        body: fallback.body,
        isActive: true,
        updatedAt: new Date(),
      },
    });

  const row = await templateByKey(db, key);
  if (row === null) throw new NotFoundError(`La plantilla «${key}» no existe`);
  return toMessageTemplate(row);
};

/** Cuerpo de una plantilla, con respaldo en el catálogo si aún no está sembrada. */
export const templateBody = async (db: NotificationsDb, key: string): Promise<string> => {
  const row = await templateByKey(db, key);
  if (row !== null && row.isActive) return row.body;
  return DEFAULT_MESSAGE_TEMPLATES.find((template) => template.key === key)?.body ?? '';
};

export const renderMessageFor = async (
  db: NotificationsDb,
  key: string,
  values: Readonly<Record<string, string | null>>,
): Promise<string> => renderMessage(await templateBody(db, key), values);

/** Siembra las plantillas del catálogo que falten (idempotente, al arrancar). */
export const ensureDefaultTemplates = async (db: NotificationsDb): Promise<number> => {
  let created = 0;
  for (const template of DEFAULT_MESSAGE_TEMPLATES) {
    const rows = await db
      .insert(messageTemplates)
      .values({
        key: template.key,
        channel: template.channel,
        subject: template.subject,
        body: template.body,
      })
      .onConflictDoNothing({ target: messageTemplates.key })
      .returning({ key: messageTemplates.key });
    created += rows.length;
  }
  return created;
};

/* ── Canales del paciente ──────────────────────────────────────────────────── */

/**
 * Fecha de hoy (`AAAA-MM-DD`) en la zona del consultorio. No vale
 * `toISOString()`: entre las 20:00 y la medianoche de Caracas (UTC−4) ya es el día
 * siguiente en UTC, y la agenda habla de días locales.
 */
export const todayInClinic = (now: Date = new Date()): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Caracas' }).format(now);

const ATTENDED_CHANNELS: readonly ChannelId[] = ['telegram', 'whatsapp'];

const isAttended = (canal: string): canal is ChannelId =>
  (ATTENDED_CHANNELS as readonly string[]).includes(canal);

export const maskDireccion = (direccion: string): string =>
  direccion.length <= 4 ? '••••' : `${direccion.slice(0, 2)}••••${direccion.slice(-2)}`;

export interface LinkedChannel {
  /** Id de la fila en `patient_channels` (v1.2: desvinculación y principal por vínculo). */
  id: string;
  patientId: string;
  canal: ChannelId;
  direccion: string;
  isPrimary: boolean;
  lastInboundAt: Date | null;
}

/**
 * Orden de preferencia del canal cuando no se pide uno concreto (D16: WhatsApp es el
 * canal principal). Se usa dentro del `ORDER BY` para desempatar antes de mirar la
 * actividad.
 */
const channelRank = (): SQL =>
  sql`case when ${patientChannels.channel} = 'whatsapp' then 0 when ${patientChannels.channel} = 'telegram' then 1 else 2 end`;

/**
 * **Selección determinista del chat** al que se escribe (v1.2, §4.3 del plan).
 *
 * Un paciente puede tener varios vínculos —dos WhatsApp, WhatsApp y Telegram—, así
 * que elegir «el primero que salga» haría que el destino familiar cambiara solo. El
 * orden es:
 *
 *  1. `isPrimary DESC`: el chat que la secretaría marcó como principal.
 *  2. Preferencia de canal (`whatsapp` > `telegram`) **solo si no se pidió canal**.
 *  3. `lastInboundAt DESC NULLS LAST`: el que el paciente usó de último.
 *  4. `linkedAt DESC`: el más reciente, como último desempate.
 *
 * Los recordatorios y avisos rutinarios salen **una sola vez** al principal/más
 * reciente, protegiendo el tope diario de Baileys; cualquier chat vinculado puede
 * consultar `estado`, `confirmar`, `cancelar` y recibir documentos cuando se elige
 * explícitamente su vínculo.
 */
export const findChannel = async (
  db: NotificationsDb,
  patientId: string,
  canal?: Channel,
): Promise<LinkedChannel | null> => {
  const rows = await db
    .select()
    .from(patientChannels)
    .where(
      and(
        eq(patientChannels.patientId, patientId),
        eq(patientChannels.isBlocked, false),
        isNotNull(patientChannels.direccion),
        ...(canal === undefined ? [] : [eq(patientChannels.channel, canal)]),
      ),
    )
    .orderBy(
      desc(patientChannels.isPrimary),
      ...(canal === undefined ? [channelRank()] : []),
      sql`${patientChannels.lastInboundAt} desc nulls last`,
      desc(patientChannels.linkedAt),
    );

  const usable = rows.filter(
    (row): row is typeof row & { direccion: string } =>
      row.direccion !== null && isAttended(row.channel),
  );
  const preferred = usable[0] ?? null;
  if (preferred === null) return null;

  return {
    id: preferred.id,
    patientId: preferred.patientId,
    canal: preferred.channel as ChannelId,
    direccion: preferred.direccion,
    isPrimary: preferred.isPrimary,
    lastInboundAt: preferred.lastInboundAt,
  };
};

/**
 * El vínculo concreto por su id (v1.2): es lo que el disparador manual de documentos
 * usa cuando la interfaz elige un chat entre varios. `null` si no existe, está
 * bloqueado o ya no tiene dirección.
 */
export const findChannelById = async (
  db: NotificationsDb,
  channelId: string,
): Promise<LinkedChannel | null> => {
  const rows = await db
    .select()
    .from(patientChannels)
    .where(eq(patientChannels.id, channelId))
    .limit(1);
  const row = rows[0];
  if (row === undefined || row.isBlocked || row.direccion === null) return null;
  if (!isAttended(row.channel)) return null;
  return {
    id: row.id,
    patientId: row.patientId,
    canal: row.channel as ChannelId,
    direccion: row.direccion,
    isPrimary: row.isPrimary,
    lastInboundAt: row.lastInboundAt,
  };
};

/** Marca de actividad del chat: cada mensaje entrante del paciente la actualiza. */
export const touchInbound = async (
  db: NotificationsDb,
  canal: ChannelId,
  direccion: string,
  now: Date = new Date(),
): Promise<void> => {
  await db
    .update(patientChannels)
    .set({ lastInboundAt: now, updatedAt: now })
    .where(and(eq(patientChannels.channel, canal), eq(patientChannels.direccion, direccion)));
};

/**
 * Deja **un solo** chat principal por paciente (v1.2). Va en transacción porque el
 * índice único parcial `uq_patient_channels_primary` no admite dos a la vez: primero
 * se limpia el anterior y después se marca el nuevo.
 */
export const setPrimaryChannel = async (
  db: NotificationsDb,
  channelId: string,
): Promise<PatientChannelRow> => {
  const rows = await db
    .select()
    .from(patientChannels)
    .where(eq(patientChannels.id, channelId))
    .limit(1);
  const row = rows[0];
  if (row === undefined) throw new NotFoundError('Ese vínculo ya no existe');
  if (row.direccion === null) {
    throw new ConflictError('Un enlace pendiente de vincular no puede ser el chat principal');
  }
  if (row.isBlocked) throw new ConflictError('Un vínculo bloqueado no puede ser el chat principal');

  const updated = await db.transaction(async (tx) => {
    await tx
      .update(patientChannels)
      .set({ isPrimary: false, updatedAt: new Date() })
      .where(
        and(eq(patientChannels.patientId, row.patientId), eq(patientChannels.isPrimary, true)),
      );
    const marcados = await tx
      .update(patientChannels)
      .set({ isPrimary: true, updatedAt: new Date() })
      .where(eq(patientChannels.id, channelId))
      .returning();
    return marcados[0];
  });

  if (updated === undefined) throw new NotFoundError('Ese vínculo ya no existe');
  return updated;
};

/** Si el paciente no tiene principal, el vínculo recién creado pasa a serlo. */
const ensurePrimary = async (
  db: NotificationsDb,
  patientId: string,
  channelId: string,
): Promise<void> => {
  const existing = await db
    .select({ id: patientChannels.id })
    .from(patientChannels)
    .where(and(eq(patientChannels.patientId, patientId), eq(patientChannels.isPrimary, true)))
    .limit(1);
  if (existing.length > 0) return;
  await db
    .update(patientChannels)
    .set({ isPrimary: true, updatedAt: new Date() })
    .where(eq(patientChannels.id, channelId))
    .catch(() => undefined);
};

/**
 * Canal vinculado a una dirección concreta (para avisos y pruebas).
 *
 * Una fila `is_blocked` **no** cuenta como vínculo: es el estado que dejaban las
 * desvinculaciones antiguas y el cambio de número del bot. Si se devolviera, el
 * asistente seguiría confirmando o cancelando citas de la ficha anterior.
 */
export const channelByDireccion = async (
  db: NotificationsDb,
  canal: ChannelId,
  direccion: string,
): Promise<{ patientId: string } | null> => {
  const rows = await db
    .select()
    .from(patientChannels)
    .where(and(eq(patientChannels.channel, canal), eq(patientChannels.direccion, direccion)))
    .limit(1);
  const row = rows[0];
  return row === undefined || row.isBlocked ? null : { patientId: row.patientId };
};

/**
 * Genera un enlace de vinculación para un paciente que aún no tiene canal: la
 * fila queda **pendiente** (sin dirección) con su código y su caducidad, y al
 * abrir el enlace la dirección se asocia al paciente.
 */
export const createLinkCode = async (
  db: NotificationsDb,
  input: { patientId: string; code: string; expiresAt: Date; canal?: Channel },
): Promise<void> => {
  // Un solo enlace pendiente por paciente: el anterior deja de servir.
  await db
    .delete(patientChannels)
    .where(and(eq(patientChannels.patientId, input.patientId), isNull(patientChannels.direccion)));

  await db.insert(patientChannels).values({
    patientId: input.patientId,
    channel: input.canal ?? 'telegram',
    direccion: null,
    linkCode: input.code,
    linkCodeExpiresAt: input.expiresAt,
  });
};

/** Canales vinculados (con dirección) de un paciente o de todos, para la bandeja. */
export const listChannels = async (
  db: NotificationsDb,
  patientId?: string,
): Promise<
  {
    id: string;
    patientId: string;
    canal: ChannelId;
    direccion: string;
    usuario: string | null;
    linkedAt: Date;
    lastInboundAt: Date | null;
    isPrimary: boolean;
    isBlocked: boolean;
  }[]
> => {
  const conditions = [isNotNull(patientChannels.direccion)];
  if (patientId !== undefined) conditions.push(eq(patientChannels.patientId, patientId));

  const rows = await db
    .select()
    .from(patientChannels)
    .where(and(...conditions))
    .orderBy(desc(patientChannels.isPrimary), desc(patientChannels.linkedAt))
    .limit(100);

  return rows.flatMap((row) =>
    row.direccion === null || !isAttended(row.channel)
      ? []
      : [
          {
            id: row.id,
            patientId: row.patientId,
            canal: row.channel as ChannelId,
            direccion: row.direccion,
            usuario: row.usuario,
            linkedAt: row.linkedAt,
            lastInboundAt: row.lastInboundAt,
            isPrimary: row.isPrimary,
            isBlocked: row.isBlocked,
          },
        ],
  );
};

/** Vincula una dirección (chat de Telegram o número de WhatsApp) con el paciente. */
export const linkChat = async (
  db: NotificationsDb,
  input: {
    patientId: string;
    canal: ChannelId;
    direccion: string;
    usuario?: string | null;
    viaCode?: string;
  },
): Promise<void> => {
  if (input.viaCode !== undefined) {
    // La fila pendiente del código desaparece: la dirección real ocupa su lugar.
    await db.delete(patientChannels).where(eq(patientChannels.linkCode, input.viaCode));
  }

  // ¿La dirección ya estaba vinculada? Si cambia de paciente no puede heredar ser la
  // principal del anterior (el índice parcial no admitiría dos principales).
  const previous = await db
    .select({ patientId: patientChannels.patientId })
    .from(patientChannels)
    .where(
      and(eq(patientChannels.channel, input.canal), eq(patientChannels.direccion, input.direccion)),
    )
    .limit(1);
  const mismoPaciente = previous[0]?.patientId === input.patientId;

  const rows = await db
    .insert(patientChannels)
    .values({
      patientId: input.patientId,
      channel: input.canal,
      direccion: input.direccion,
      usuario: input.usuario ?? null,
      linkedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [patientChannels.channel, patientChannels.direccion],
      set: {
        patientId: input.patientId,
        usuario: input.usuario ?? null,
        isBlocked: false,
        linkedAt: new Date(),
        updatedAt: new Date(),
        ...(mismoPaciente ? {} : { isPrimary: false }),
      },
    })
    .returning({ id: patientChannels.id });

  const vinculado = rows[0];
  // El primer chat del paciente queda como principal: los avisos tienen destino.
  if (vinculado !== undefined) await ensurePrimary(db, input.patientId, vinculado.id);
};

/**
 * Desvincula a un paciente. Con `canal` se quita **solo** ese vínculo: un
 * paciente con Telegram y WhatsApp puede perder uno sin perder el otro.
 *
 * No basta con marcar `is_blocked` (lo que hacía antes): el chat seguía ligado
 * al paciente en `patient_channels` y la conversación guardada en
 * `bot_conversations` conservaba `patientId`, `state` y `lastTicket`. Al
 * escribir otra vez, el bot retomaba la ficha anterior en vez de empezar de
 * cero. Aquí se borran las dos cosas: la próxima vez que ese chat escriba se
 * crea una conversación nueva y puede registrarse como otro paciente.
 */
export const unlinkPatient = async (
  db: NotificationsDb,
  patientId: string,
  canal?: Channel,
): Promise<void> => {
  const where = and(
    eq(patientChannels.patientId, patientId),
    ...(canal === undefined ? [] : [eq(patientChannels.channel, canal)]),
  );
  const rows = await db
    .select({ channel: patientChannels.channel, direccion: patientChannels.direccion })
    .from(patientChannels)
    .where(where);

  await db.transaction(async (tx) => {
    await tx.delete(patientChannels).where(where);
    for (const row of rows) {
      if (row.direccion === null) continue;
      await tx
        .delete(botConversations)
        .where(
          and(
            eq(botConversations.canal, row.channel),
            eq(botConversations.direccion, row.direccion),
          ),
        );
    }
  });
};

/**
 * Reinicia la conversación de un chat **sin borrarla**: estado `inicio`, borrador
 * vacío y sin paciente ni ticket. Se usa al desvincular un chat individual (v1.2):
 * así el mismo chat puede empezar a registrar a otra persona en el acto. Se
 * actualiza en vez de borrar para que el asistente, que acaba de desvincular y sigue
 * en el mismo turno, pueda continuar el flujo y guardar los pasos siguientes.
 */
const resetConversation = async (
  db: NotificationsDb,
  canal: string,
  direccion: string,
): Promise<void> => {
  await db
    .update(botConversations)
    .set({
      state: 'inicio',
      draft: {},
      patientId: null,
      lastTicket: null,
      opciones: {},
      updatedAt: new Date(),
    })
    .where(and(eq(botConversations.canal, canal), eq(botConversations.direccion, direccion)));
};

/**
 * Desvincula **un chat concreto** por su dirección (v1.2, §5.2 del plan).
 *
 * Es la operación del flujo «otro paciente en el mismo chat»: borra solo la fila
 * `(channel, direccion)` de `patient_channels`. Si el paciente tenía además otro
 * chat (su Telegram y su WhatsApp, por ejemplo), **no se toca**. La conversación de
 * ese chat se reinicia para que pueda registrar a otra persona.
 */
export const unlinkChatByDireccion = async (
  db: NotificationsDb,
  canal: ChannelId,
  direccion: string,
): Promise<void> => {
  await db
    .delete(patientChannels)
    .where(and(eq(patientChannels.channel, canal), eq(patientChannels.direccion, direccion)));
  await resetConversation(db, canal, direccion);
};

/** Desvincula **un vínculo concreto** por su `patient_channels.id` (v1.2). */
export const unlinkChannelById = async (db: NotificationsDb, channelId: string): Promise<void> => {
  const rows = await db
    .select()
    .from(patientChannels)
    .where(eq(patientChannels.id, channelId))
    .limit(1);
  const row = rows[0];
  if (row === undefined) throw new NotFoundError('Ese vínculo ya no existe');

  await db.delete(patientChannels).where(eq(patientChannels.id, channelId));
  if (row.direccion !== null) {
    await resetConversation(db, row.channel, row.direccion);
  }
};

/* ── Cola de envíos ────────────────────────────────────────────────────────── */

const toRecord = (row: NotificationRow): NotificationRecord => ({
  id: row.id,
  patientId: row.patientId,
  patientName: row.patientName,
  appointmentId: row.appointmentId,
  templateKey: row.templateKey,
  channel: row.channel as Channel,
  recipient: row.recipient,
  status: row.status as NotificationRecord['status'],
  attempts: row.attempts,
  maxAttempts: row.maxAttempts,
  lastError: row.lastError,
  providerMessageId: row.providerMessageId,
  sentAt: row.sentAt?.toISOString() ?? null,
  nextAttemptAt: row.nextAttemptAt.toISOString(),
  manualNote: row.manualNote,
  contactedAt: row.contactedAt?.toISOString() ?? null,
  contactedBy: row.contactedBy,
  payload: row.payload,
  createdAt: row.createdAt.toISOString(),
});

export interface EnqueueInput {
  patientId: string;
  patientName: string | null;
  appointmentId?: string | null;
  templateKey: string;
  /** Canal pedido; si el paciente está vinculado por otro, se usa el que tenga. */
  channel?: Channel;
  payload: Record<string, unknown>;
  /** Clave de idempotencia: la misma cita no genera dos avisos del mismo tipo. */
  dedupeKey: string;
  /** Texto ya redactado (si no viene, se arma con la plantilla de la base). */
  text?: string;
  /** Adjunto `.ics` para los avisos de cita. */
  attachIcs?: boolean;
  /**
   * Documento digital a enviar como adjunto PDF (Req 5). **Sin bytes**: la fila solo
   * guarda qué documento es; el PDF se descarga de `clinical`/`billing` al procesar
   * la cola y no se duplica en la base de notificaciones.
   */
  document?: DocumentPayload;
  /**
   * `true` si el aviso invita a confirmar o cancelar la cita: en los canales sin
   * botones se adjuntan opciones numeradas (`1) Confirmar asistencia`, `2) Cancelar`)
   * y se guardan en `bot_conversations.opciones` si el chat está en `inicio`.
   */
  offerAppointmentActions?: boolean;
  /** Intentos permitidos antes de darlo por fallido (por defecto, los del plan). */
  maxAttempts?: number;
}

/** Documento digital encolado: identifica el archivo sin traer sus bytes a la base. */
export interface DocumentPayload {
  kind: DocumentNotificationKind;
  entityId: string;
  /** Nombre corto para la bandeja («Récipe #000123», «Factura A-000012»…). */
  label: string;
  /** Nombre de archivo con el que viaja el PDF (sin ruta). */
  filename: string;
}

/**
 * Encola un aviso. Si ya existe uno con la misma clave de deduplicación, devuelve
 * `null` en vez de duplicarlo: es la idempotencia por cita y canal que pide el plan
 * (un evento repetido no vuelve a escribir al paciente).
 *
 * El destino se resuelve por **canal y dirección**: se respeta el canal pedido y,
 * si el paciente no está vinculado por ese pero sí por otro, se usa el que tenga.
 */
export const enqueue = async (
  db: NotificationsDb,
  input: EnqueueInput,
): Promise<NotificationRecord | null> => {
  const linked =
    (input.channel === undefined
      ? await findChannel(db, input.patientId)
      : ((await findChannel(db, input.patientId, input.channel)) ??
        (await findChannel(db, input.patientId)))) ?? null;
  const channel = linked?.canal ?? input.channel ?? 'telegram';
  const text =
    input.text ??
    renderMessage(
      await templateBody(db, input.templateKey),
      (input.payload['variables'] as Record<string, string> | undefined) ?? {},
    );

  const rows = await db
    .insert(notifications)
    .values({
      patientId: input.patientId,
      patientName: input.patientName,
      appointmentId: input.appointmentId ?? null,
      templateKey: input.templateKey,
      channel,
      recipient: linked?.direccion ?? null,
      // Sin canal vinculado no hay a quién escribir: queda como aviso manual.
      status: linked === null ? 'skipped_no_channel' : 'queued',
      maxAttempts: input.maxAttempts ?? NOTIFICATION_MAX_ATTEMPTS,
      nextAttemptAt: new Date(),
      payload: {
        ...input.payload,
        text,
        attachIcs: input.attachIcs ?? false,
        ...(input.document === undefined ? {} : { document: input.document }),
        ...(input.offerAppointmentActions === true ? { offerActions: true } : {}),
      },
      dedupeKey: input.dedupeKey,
    })
    .onConflictDoNothing({ target: notifications.dedupeKey })
    .returning();

  const row = rows[0];
  return row === undefined ? null : toRecord(row);
};

export const listNotifications = async (
  db: NotificationsDb,
  filters: NotificationFilters,
): Promise<Paginated<NotificationRecord>> => {
  const conditions: SQL[] = [];
  if (filters.status !== undefined) conditions.push(eq(notifications.status, filters.status));
  if (filters.channel !== undefined) conditions.push(eq(notifications.channel, filters.channel));
  if (filters.from !== undefined) {
    conditions.push(gte(notifications.createdAt, new Date(`${filters.from}T00:00:00-04:00`)));
  }
  if (filters.to !== undefined) {
    conditions.push(lte(notifications.createdAt, new Date(`${filters.to}T23:59:59-04:00`)));
  }
  if (filters.search !== undefined && filters.search.trim() !== '') {
    const pattern = `%${filters.search.trim().replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
    const combined = or(
      sql`coalesce(${notifications.patientName}, '') ilike ${pattern} escape '\\'`,
      sql`coalesce(${notifications.recipient}, '') like ${`%${filters.search.trim()}%`}`,
    );
    if (combined !== undefined) conditions.push(combined);
  }

  const where = conditions.length === 0 ? undefined : and(...conditions);
  const offset = (filters.page - 1) * filters.pageSize;

  const [rows, totals] = await Promise.all([
    db
      .select()
      .from(notifications)
      .where(where)
      .orderBy(desc(notifications.createdAt))
      .limit(filters.pageSize)
      .offset(offset),
    db.select({ value: count() }).from(notifications).where(where),
  ]);

  const total = totals[0]?.value ?? 0;
  return {
    items: rows.map(toRecord),
    total,
    page: filters.page,
    pageSize: filters.pageSize,
    totalPages: Math.max(1, Math.ceil(total / filters.pageSize)),
  };
};

export const getNotification = async (
  db: NotificationsDb,
  id: string,
): Promise<NotificationRecord> => {
  const rows = await db.select().from(notifications).where(eq(notifications.id, id)).limit(1);
  const row = rows[0];
  if (row === undefined) throw new NotFoundError('El aviso no existe');
  return toRecord(row);
};

/** Aviso por su clave de deduplicación: sirve para saber si ya salió o quedó a medias. */
export const notificationByDedupe = async (
  db: NotificationsDb,
  dedupeKey: string,
): Promise<NotificationRecord | null> => {
  const rows = await db
    .select()
    .from(notifications)
    .where(eq(notifications.dedupeKey, dedupeKey))
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : toRecord(row);
};

/** Reintento manual desde la bandeja: vuelve a la cola ahora mismo. */
export const retryNotification = async (
  db: NotificationsDb,
  id: string,
  reason: string | undefined,
): Promise<NotificationRecord> => {
  const current = await db.select().from(notifications).where(eq(notifications.id, id)).limit(1);
  const row = current[0];
  if (row === undefined) throw new NotFoundError('El aviso no existe');

  const linked =
    row.recipient === null
      ? ((await findChannel(db, row.patientId, row.channel as Channel)) ??
        (await findChannel(db, row.patientId)))
      : null;
  const rows = await db
    .update(notifications)
    .set({
      status: linked === null && row.recipient === null ? 'skipped_no_channel' : 'queued',
      attempts: 0,
      // Un reintento manual vuelve a permitir la cadena completa de reintentos.
      maxAttempts: NOTIFICATION_MAX_ATTEMPTS,
      lastError: null,
      nextAttemptAt: new Date(),
      recipient: row.recipient ?? linked?.direccion ?? null,
      ...(linked === null ? {} : { channel: linked.canal }),
      updatedAt: new Date(),
      payload: { ...row.payload, retryReason: reason ?? 'reintento manual' },
    })
    .where(eq(notifications.id, id))
    .returning();

  const updated = rows[0];
  if (updated === undefined) throw new NotFoundError('El aviso no existe');
  return toRecord(updated);
};

/** Marca un aviso manual como hecho: lo llamó la secretaría. */
export const markContacted = async (
  db: NotificationsDb,
  id: string,
  note: string,
  actorId: string | null,
): Promise<NotificationRecord> => {
  const rows = await db
    .update(notifications)
    .set({
      manualNote: note,
      contactedAt: new Date(),
      contactedBy: actorId,
      updatedAt: new Date(),
    })
    .where(eq(notifications.id, id))
    .returning();

  const updated = rows[0];
  if (updated === undefined) throw new NotFoundError('El aviso no existe');
  return toRecord(updated);
};

export const notificationCounts = async (
  db: NotificationsDb,
): Promise<{ queued: number; sent: number; failed: number; manualPending: number }> => {
  const rows = await db
    .select({ status: notifications.status, value: sql<number>`count(1)::int` })
    .from(notifications)
    .groupBy(notifications.status);

  const byStatus = new Map(rows.map((row) => [row.status, row.value]));
  return {
    queued: (byStatus.get('queued') ?? 0) + (byStatus.get('sending') ?? 0),
    sent: byStatus.get('sent') ?? 0,
    failed: byStatus.get('failed') ?? 0,
    manualPending: byStatus.get('skipped_no_channel') ?? 0,
  };
};

/* ── `.ics` ────────────────────────────────────────────────────────────────── */

/**
 * El consultorio aún no tiene nombre ni dirección: no se puede componer el `.ics` ni
 * el texto del aviso. Quien la reciba debe **diferir** la generación, no inventar datos.
 */
export class ClinicNotConfiguredError extends Error {
  constructor() {
    super('El consultorio aún no está configurado (falta el nombre o la dirección)');
    this.name = 'ClinicNotConfiguredError';
  }
}

/** ¿El consultorio ya tiene nombre y dirección con los que componer avisos y `.ics`? */
export const clinicReady = (config: {
  CLINIC_NAME?: string | undefined;
  CLINIC_ADDRESS?: string | undefined;
}): boolean => config.CLINIC_NAME !== undefined && config.CLINIC_ADDRESS !== undefined;

/**
 * ¿Este aviso necesita datos del consultorio para poder salir? Los de cita los llevan
 * en el texto (`lugar`) y en el `.ics` (`LOCATION`); hasta que el titular los complete,
 * se quedan en la cola sin gastar intentos.
 */
const rowNeedsClinic = (row: NotificationRow): boolean =>
  row.payload['needsClinic'] === true || row.payload['attachIcs'] === true;

/** Cuánto espera un aviso a que el consultorio esté configurado antes de reintentar. */
const CLINIC_DEFER_MS = 5 * 60_000;

export interface GeneratedIcs {
  filename: string;
  content: string;
  sha256: string;
  sequence: number;
}

/** Compone el `.ics` (y su huella) con los datos de la cita y del consultorio. */
const composeIcs = (config: NotificationsConfig, appointment: AppointmentSummary): GeneratedIcs => {
  // El `.ics` lleva el nombre y el lugar del consultorio: sin ellos no se compone. El
  // servidor reintenta solo cuando el titular complete el registro.
  if (!clinicReady(config)) throw new ClinicNotConfiguredError();

  const content = buildIcsEvent({
    uid: appointment.id,
    sequence: appointment.icsSequence,
    start: new Date(`${appointment.date}T${appointment.startTime}:00-04:00`),
    end: new Date(`${appointment.date}T${appointment.endTime}:00-04:00`),
    summary: `Cita odontológica · ${appointment.ticket ?? 'sin ticket'}`,
    description:
      `Paciente: ${appointment.patientName}\n` +
      `Ticket: ${appointment.ticket ?? '—'}\n` +
      `Motivo: consulta odontológica\n` +
      `Consultorio: ${config.CLINIC_NAME ?? ''}`,
    location: config.CLINIC_ADDRESS ?? '',
    organizerName: config.CLINIC_NAME ?? '',
    organizerEmail: config.CLINIC_EMAIL ?? 'noreply@odontocrm.local',
    attendeeName: appointment.patientName,
  });

  return {
    filename: icsFilename(appointment.ticket, appointment.id),
    content,
    sha256: icsSha256(content),
    sequence: appointment.icsSequence,
  };
};

export const ensureIcsArtifact = async (
  db: NotificationsDb,
  config: NotificationsConfig,
  appointment: AppointmentSummary,
): Promise<GeneratedIcs> => {
  const existing = await db
    .select()
    .from(icsArtifacts)
    .where(
      and(
        eq(icsArtifacts.appointmentId, appointment.id),
        eq(icsArtifacts.sequence, appointment.icsSequence),
      ),
    )
    .limit(1);
  const found: IcsArtifactRow | undefined = existing[0];

  // El artefacto ya compuesto se reutiliza —es reproducible y auditable—, pero **no** si
  // lo compuso una versión anterior del generador: el formato cambió (los parámetros
  // `CN=` sin entrecomillar hacían que el calendario «no abriera» en el celular) y el
  // archivo guardado seguiría saliendo mal en cada reenvío. Se rehace y se actualiza la
  // **misma** fila: el número de secuencia no cambia, porque el evento es el mismo.
  if (found !== undefined && icsFormatVersionOf(found.content) >= ICS_FORMAT_VERSION) {
    return {
      filename: found.filename,
      content: found.content,
      sha256: found.sha256,
      sequence: found.sequence,
    };
  }

  const generado = composeIcs(config, appointment);

  if (found !== undefined) {
    await db
      .update(icsArtifacts)
      .set({
        filename: generado.filename,
        content: generado.content,
        sha256: generado.sha256,
        generatedAt: new Date(),
      })
      .where(
        and(
          eq(icsArtifacts.appointmentId, appointment.id),
          eq(icsArtifacts.sequence, appointment.icsSequence),
        ),
      );
    return generado;
  }

  await db
    .insert(icsArtifacts)
    .values({
      appointmentId: appointment.id,
      sequence: appointment.icsSequence,
      filename: generado.filename,
      content: generado.content,
      sha256: generado.sha256,
    })
    .onConflictDoNothing({ target: [icsArtifacts.appointmentId, icsArtifacts.sequence] });

  return generado;
};

export const findIcsArtifact = async (
  db: NotificationsDb,
  appointmentId: string,
): Promise<IcsArtifactRow | null> => {
  const rows = await db
    .select()
    .from(icsArtifacts)
    .where(eq(icsArtifacts.appointmentId, appointmentId))
    .orderBy(desc(icsArtifacts.sequence))
    .limit(1);
  return rows[0] ?? null;
};

/* ── Procesador de la cola ─────────────────────────────────────────────────── */

export interface ProcessResult {
  processed: number;
  sent: number;
  failed: number;
  /** Avisos que esperan a que el consultorio esté configurado (no gastan intentos). */
  deferred: number;
}

const textOf = (row: NotificationRow): string =>
  typeof row.payload['text'] === 'string' ? row.payload['text'] : '';

/**
 * El texto con el que se envía el aviso. Si depende del consultorio, se **re-renderiza
 * en el momento de enviar** con el nombre y la dirección actuales (el aviso pudo
 * encolarse antes de que el titular completara el registro, o el consultorio cambió su
 * dirección entre el encolado y el envío).
 */
const textFor = async (
  db: NotificationsDb,
  row: NotificationRow,
  config: NotificationsConfig,
): Promise<string> => {
  if (row.payload['needsClinic'] !== true) return textOf(row);
  const variables =
    typeof row.payload['variables'] === 'object' && row.payload['variables'] !== null
      ? (row.payload['variables'] as Record<string, string | null>)
      : {};
  return renderMessageFor(db, row.templateKey, {
    ...variables,
    clinica: config.CLINIC_NAME ?? '',
    lugar: config.CLINIC_ADDRESS ?? '',
  });
};

/**
 * Un documento encolado que **ya no se puede enviar** (anulado, borrado o sin PDF).
 * Si es `definitivo`, el aviso se marca fallido en el acto: reintentarlo durante una
 * hora no va a resucitar un récipe anulado, y la bandeja debe decirlo ya.
 */
export class DocumentoNoDisponibleError extends Error {
  constructor(
    message: string,
    readonly definitivo = true,
  ) {
    super(message);
    this.name = 'DocumentoNoDisponibleError';
  }
}

const readDocumentPayload = (raw: unknown): DocumentPayload | null => {
  if (typeof raw !== 'object' || raw === null) return null;
  const candidate = raw as Partial<DocumentPayload>;
  if (
    (candidate.kind !== 'prescription' &&
      candidate.kind !== 'invoice' &&
      candidate.kind !== 'receipt') ||
    typeof candidate.entityId !== 'string' ||
    typeof candidate.filename !== 'string'
  ) {
    return null;
  }
  return {
    kind: candidate.kind,
    entityId: candidate.entityId,
    label: typeof candidate.label === 'string' ? candidate.label : candidate.filename,
    filename: candidate.filename,
  };
};

/** Pie de foto seguro para Baileys: como mucho 1024 caracteres (Req 5). */
const captionFor = (text: string): string =>
  text.length <= DOCUMENT_CAPTION_MAX_CHARS
    ? text
    : `${text.slice(0, DOCUMENT_CAPTION_MAX_CHARS - 1)}…`;

/**
 * Las **tres acciones** del paciente sobre su cita (v1.2.2, ADR 0077): confirmar,
 * posponer (el ticket vuelve a la lista de espera) o cancelar la cita
 * definitivamente. Van en el **código** y no en la plantilla a propósito: el
 * consultorio puede editar el texto sin quedarse sin los botones.
 *
 * `cancelar_definitiva:<uuid>` mide 56 bytes: cabe en los 64 de `callback_data`
 * de Telegram. Son **tres justos**, el máximo de WhatsApp Cloud API (con cuatro,
 * el adaptador mandaría el texto sin opciones).
 */
export const appointmentActionButtons = (appointmentId: string): OutboundButton[] => [
  { etiqueta: 'Confirmar', accion: `confirmar_cita:${appointmentId}` },
  { etiqueta: 'Posponer', accion: `posponer_cita:${appointmentId}` },
  { etiqueta: 'Cancelar cita', accion: `cancelar_definitiva:${appointmentId}` },
];

/**
 * Opciones numeradas en los avisos proactivos para canales **sin botones** (v1.2,
 * §2.3.4): el paciente de Baileys no tiene botones que pulsar, así que el aviso de
 * cita termina en «1) Confirmar asistencia / 2) Posponer… / 3) Cancelar…» y el mapa
 * se guarda en `bot_conversations.opciones` para entender su «1».
 *
 * **No se pisa una conversación a medio formulario**: si el paciente está rellenando
 * el alta, sobrescribir sus opciones rompería el paso en curso. En ese caso el texto
 * ya invita a escribir «confirmar», «posponer» o «cancelar».
 */
const withAppointmentOptions = async (
  db: NotificationsDb,
  row: NotificationRow,
  recipient: string,
  texto: string,
  adapter: { capacidades: { botones: boolean } },
): Promise<string> => {
  if (adapter.capacidades.botones) return texto;
  if (row.payload['offerActions'] !== true || row.appointmentId === null) return texto;

  const existente = await db
    .select({ state: botConversations.state })
    .from(botConversations)
    .where(and(eq(botConversations.canal, row.channel), eq(botConversations.direccion, recipient)))
    .limit(1);
  const estado = existente[0]?.state ?? 'inicio';
  if (estado !== 'inicio') return texto;

  const numeradas = numberedOptions([
    { etiqueta: 'Confirmar asistencia', accion: `confirmar_cita:${row.appointmentId}` },
    { etiqueta: 'Posponer (elegir otro día)', accion: `posponer_cita:${row.appointmentId}` },
    {
      etiqueta: 'Cancelar la cita definitivamente',
      accion: `cancelar_definitiva:${row.appointmentId}`,
    },
  ]);
  const opciones = Object.fromEntries(numeradas.acciones);

  await db
    .insert(botConversations)
    .values({
      canal: row.channel,
      direccion: recipient,
      state: 'inicio',
      draft: {},
      opciones,
      windowStartedAt: new Date(),
    })
    .onConflictDoNothing({ target: [botConversations.canal, botConversations.direccion] });
  await db
    .update(botConversations)
    .set({ opciones, updatedAt: new Date() })
    .where(
      and(
        eq(botConversations.canal, row.channel),
        eq(botConversations.direccion, recipient),
        eq(botConversations.state, 'inicio'),
      ),
    );

  return `${texto}\n\n${numeradas.texto}`;
};

/**
 * Toma los avisos que toca enviar y los manda **por el adaptador de su canal**
 * (ADR 0029): el mismo aviso sale por Telegram o por WhatsApp sin cambiar la cola.
 *
 * Los fallos no se pierden: cada intento cuenta y el siguiente se programa con
 * retroceso exponencial (1 m, 5 m, 15 m, 1 h, 6 h). Los avisos de cita llevan el
 * `.ics` adjunto como documento `cita-<ticket>.ics`.
 */
export const processQueue = async (
  db: NotificationsDb,
  canales: AdapterRegistry,
  config: NotificationsConfig,
  options: {
    limit?: number;
    now?: Date;
    appointmentLoader?: (id: string) => Promise<AppointmentSummary | null>;
    /**
     * Descarga el PDF del documento encolado (Req 5). Lo inyecta el arranque con los
     * clientes internos de `clinical`/`billing`; sin él, los avisos con documento
     * fallan con un error claro en vez de salir sin adjunto.
     */
    documentLoader?: (document: DocumentPayload) => Promise<OutboundDocument>;
    /** Se llama por cada aviso resuelto: sirve para dejar rastro en la auditoría. */
    onResult?: (info: {
      id: string;
      patientId: string;
      appointmentId: string | null;
      templateKey: string;
      channel: string;
      ok: boolean;
      error?: string;
      providerMessageId?: string;
    }) => Promise<void> | void;
  } = {},
): Promise<ProcessResult> => {
  const now = options.now ?? new Date();
  const limit = options.limit ?? config.QUEUE_BATCH_SIZE;

  const pending = await db
    .select()
    .from(notifications)
    .where(and(eq(notifications.status, 'queued'), lte(notifications.nextAttemptAt, now)))
    .orderBy(asc(notifications.nextAttemptAt))
    .limit(limit);

  let sent = 0;
  let failed = 0;
  let deferred = 0;

  for (const row of pending) {
    // Si el consultorio aún no está configurado, los avisos que lo necesitan esperan en
    // la cola **sin gastar intentos**: se reintentan solos cuando el titular lo complete.
    if (rowNeedsClinic(row) && !clinicReady(config)) {
      await db
        .update(notifications)
        .set({
          status: 'queued',
          lastError: 'consultorio sin configurar',
          nextAttemptAt: new Date(now.getTime() + CLINIC_DEFER_MS),
          updatedAt: new Date(),
        })
        .where(and(eq(notifications.id, row.id), eq(notifications.status, 'queued')));
      deferred += 1;
      continue;
    }

    const claimed = await db
      .update(notifications)
      .set({ status: 'sending', updatedAt: new Date() })
      .where(and(eq(notifications.id, row.id), eq(notifications.status, 'queued')))
      .returning({ id: notifications.id });

    // Otro proceso se lo llevó entre la lectura y el update: se salta.
    if (claimed.length === 0) continue;

    const adapter = canales.get(row.channel);
    const recipient =
      row.recipient ??
      (await findChannel(db, row.patientId, row.channel as Channel))?.direccion ??
      null;

    // Sin adaptador (canal de oficina) o sin dirección no hay a quién escribir.
    if (recipient === null || adapter === null) {
      await db
        .update(notifications)
        .set({ status: 'skipped_no_channel', recipient: null, updatedAt: new Date() })
        .where(eq(notifications.id, row.id));
      continue;
    }

    try {
      const text = await textFor(db, row, config);
      let messageId: string;

      const documentPayload = readDocumentPayload(row.payload['document']);
      const attachIcs = row.payload['attachIcs'] === true && row.appointmentId !== null;
      const appointment =
        attachIcs && row.appointmentId !== null
          ? ((await options.appointmentLoader?.(row.appointmentId)) ?? null)
          : null;

      if (documentPayload !== null) {
        // Req 5: el PDF **no** vive en la base de notificaciones. Se descarga de
        // clinical/billing en el momento de enviar y viaja en un solo mensaje con
        // el texto como pie de foto (límite de 1024 caracteres en Baileys).
        const loader = options.documentLoader;
        if (loader === undefined) {
          throw new DocumentoNoDisponibleError(
            'No hay cargador de documentos configurado en el servicio de notificaciones',
          );
        }
        const documento = await loader(documentPayload);
        const message = await adapter.enviar({
          direccion: recipient,
          texto: captionFor(text),
          documento,
        });
        messageId = message.idMensaje;
      } else if (attachIcs && appointment !== null) {
        const ics = await ensureIcsArtifact(db, config, appointment);

        /**
         * El aviso de cita sale en **dos mensajes** (ADR 0052). El motivo es del
         * adaptador de Telegram: cuando el saliente lleva documento, `enviar` manda
         * el archivo con el texto como **pie de foto** y **descarta los botones**; el
         * `.ics` viaja así desde la Fase 4. Para que el paciente pueda confirmar con
         * un toque, el texto y su botón van primero y el calendario después —con un
         * pie corto, para que las dos burbujas se entiendan—. Los canales sin
         * botones (Baileys) reciben el mismo texto con las opciones **numeradas**
         * del núcleo (v1.2), que es lo que entiende al responder «1».
         */
        if (adapter.capacidades.botones) {
          await adapter.enviar({
            direccion: recipient,
            texto: text,
            // Tres botones: confirmar, posponer o cancelar la cita definitivamente
            // (v1.2.2, ADR 0077; antes eran dos y «cancelar» era posponer). Van en el
            // **código** y no en la plantilla a propósito: el consultorio puede editar
            // el texto sin quedarse sin los botones. Solo llegan a los canales que
            // declaran `botones: true` (Telegram y Cloud API); Baileys usa el texto
            // con las opciones numeradas del núcleo.
            botones: appointmentActionButtons(appointment.id),
          });
        } else {
          await adapter.enviar({
            direccion: recipient,
            texto: await withAppointmentOptions(db, row, recipient, text, adapter),
          });
        }

        const attachment = await adapter.enviar({
          direccion: recipient,
          texto: 'Tu calendario',
          documento: {
            nombre: ics.filename,
            contenido: Buffer.from(ics.content, 'utf8'),
            // El tipo **canónico** del documento. Antes viajaba con parámetros
            // (`text/calendar; charset=utf-8; method=PUBLISH`): Telegram y WhatsApp usan
            // esa cadena como `mime_type` del archivo y el teléfono decide con ella qué
            // aplicación ofrece; un tipo con parámetros deja de reconocerse como
            // calendario y el `.ics` «no abre». El `METHOD` no hace falta aquí: viaja
            // **dentro** del archivo, que es quien lo lee.
            mime: 'text/calendar',
          },
        });
        messageId = attachment.idMensaje;
      } else {
        /**
         * Aviso sin `.ics` (el recordatorio automático, por ejemplo). Si ofrece las
         * acciones de la cita y el canal tiene botones, estas viajan aquí: sin este
         * ramal el recordatorio de Telegram solo tendría texto (v1.2.2, ADR 0077).
         */
        const ofrecerAcciones = row.payload['offerActions'] === true;
        const citaId = row.appointmentId;
        const message = await adapter.enviar({
          direccion: recipient,
          texto: await withAppointmentOptions(db, row, recipient, text, adapter),
          ...(ofrecerAcciones && citaId !== null && adapter.capacidades.botones
            ? { botones: appointmentActionButtons(citaId) }
            : {}),
        });
        messageId = message.idMensaje;
      }

      await db
        .update(notifications)
        .set({
          status: 'sent',
          recipient,
          providerMessageId: messageId,
          sentAt: new Date(),
          attempts: row.attempts + 1,
          lastError: null,
          // Se guarda el texto ya re-renderizado: la bandeja y la auditoría muestran
          // el mismo lugar que recibió el paciente.
          payload: { ...row.payload, text },
          updatedAt: new Date(),
        })
        .where(eq(notifications.id, row.id));
      sent += 1;

      await options.onResult?.({
        id: row.id,
        patientId: row.patientId,
        appointmentId: row.appointmentId,
        templateKey: row.templateKey,
        channel: row.channel,
        ok: true,
        providerMessageId: messageId,
      });
    } catch (error) {
      /**
       * **Documento anulado o inexistente** (Req 5): no se reintenta. Un récipe que se
       * anuló entre el encolado y el envío no vuelve; el aviso queda fallido con su
       * motivo para que la bandeja lo enseñe y la secretaría decida.
       */
      if (error instanceof DocumentoNoDisponibleError && error.definitivo) {
        const message = error.message.slice(0, 300);
        await db
          .update(notifications)
          .set({
            status: 'failed',
            attempts: row.maxAttempts,
            lastError: message,
            updatedAt: new Date(),
          })
          .where(eq(notifications.id, row.id));
        failed += 1;
        await options.onResult?.({
          id: row.id,
          patientId: row.patientId,
          appointmentId: row.appointmentId,
          templateKey: row.templateKey,
          channel: row.channel,
          ok: false,
          error: message,
        });
        continue;
      }

      /**
       * **Diferimiento sin gastar intentos** (D9, igual que «consultorio sin
       * configurar»): si WhatsApp no está conectado o se alcanzó el tope diario,
       * el aviso vuelve a la cola para cuando el canal esté disponible. No es un
       * fallo del aviso y no debe agotar sus reintentos.
       */
      if (error instanceof CanalNoDisponibleError || error instanceof CanalSaturadoError) {
        await db
          .update(notifications)
          .set({
            status: 'queued',
            lastError: error.message.slice(0, 300),
            nextAttemptAt: error.reintentarEn,
            updatedAt: new Date(),
          })
          .where(and(eq(notifications.id, row.id), eq(notifications.status, 'sending')));
        deferred += 1;
        continue;
      }

      const attempts = row.attempts + 1;
      const delays = retryDelays(config);
      const exhausted = attempts >= row.maxAttempts;
      const delaySeconds = delays[Math.min(attempts - 1, delays.length - 1)] ?? 60;
      const message =
        error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);

      await db
        .update(notifications)
        .set({
          status: exhausted ? 'failed' : 'queued',
          attempts,
          lastError: message,
          nextAttemptAt: new Date(now.getTime() + delaySeconds * 1000),
          updatedAt: new Date(),
        })
        .where(eq(notifications.id, row.id));
      failed += 1;

      await options.onResult?.({
        id: row.id,
        patientId: row.patientId,
        appointmentId: row.appointmentId,
        templateKey: row.templateKey,
        channel: row.channel,
        ok: false,
        error: message,
      });
    }
  }

  return { processed: pending.length, sent, failed, deferred };
};

export const queueSnapshot = async (db: NotificationsDb): Promise<{ pending: number }> => {
  const rows = await db
    .select({ value: count() })
    .from(notifications)
    .where(eq(notifications.status, 'queued'));
  return { pending: rows[0]?.value ?? 0 };
};

/** Avisos manuales pendientes (los que hay que llamar por teléfono). */
export const manualPending = async (db: NotificationsDb): Promise<NotificationRecord[]> => {
  const rows = await db
    .select()
    .from(notifications)
    .where(and(eq(notifications.status, 'skipped_no_channel'), isNull(notifications.contactedAt)))
    .orderBy(desc(notifications.createdAt))
    .limit(50);
  return rows.map(toRecord);
};
