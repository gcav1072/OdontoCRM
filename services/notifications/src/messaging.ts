import {
  DEFAULT_MESSAGE_TEMPLATES,
  NOTIFICATION_MAX_ATTEMPTS,
  buildIcsEvent,
  icsFilename,
  renderMessage,
  type AppointmentSummary,
  type Channel,
  type MessageTemplate,
  type NotificationFilters,
  type NotificationRecord,
  type Paginated,
} from '@odontocrm/contracts';
import { NotFoundError } from '@odontocrm/kernel';
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

import type { NotificationsConfig } from './config.js';
import { retryDelays } from './config.js';
import type { NotificationsDb } from './db/client.js';
import {
  icsArtifacts,
  messageTemplates,
  notifications,
  patientChannels,
  type IcsArtifactRow,
  type MessageTemplateRow,
  type NotificationRow,
} from './db/schema.js';
import { icsSha256 } from './ics-hash.js';
import type { TelegramTransport } from './telegram.js';

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

export const maskChatId = (chatId: string): string =>
  chatId.length <= 4 ? '••••' : `${chatId.slice(0, 2)}••••${chatId.slice(-2)}`;

export const findChannel = async (
  db: NotificationsDb,
  patientId: string,
): Promise<{ chatId: string; telegramUsername: string | null } | null> => {
  const rows = await db
    .select()
    .from(patientChannels)
    .where(
      and(
        eq(patientChannels.patientId, patientId),
        eq(patientChannels.channel, 'telegram'),
        eq(patientChannels.isBlocked, false),
        isNotNull(patientChannels.chatId),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (row === undefined || row.chatId === null) return null;
  return { chatId: row.chatId, telegramUsername: row.telegramUsername };
};

export const channelByChatId = async (
  db: NotificationsDb,
  chatId: string,
): Promise<{ patientId: string; isBlocked: boolean } | null> => {
  const rows = await db
    .select()
    .from(patientChannels)
    .where(and(eq(patientChannels.chatId, chatId), eq(patientChannels.channel, 'telegram')))
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : { patientId: row.patientId, isBlocked: row.isBlocked };
};

/**
 * Genera un enlace de vinculación para un paciente que aún no tiene Telegram: la
 * fila queda **pendiente** (sin chat) con su código y su caducidad, y al abrir el
 * enlace el chat se asocia al paciente.
 */
export const createLinkCode = async (
  db: NotificationsDb,
  input: { patientId: string; code: string; expiresAt: Date },
): Promise<void> => {
  // Un solo enlace pendiente por paciente: el anterior deja de servir.
  await db
    .delete(patientChannels)
    .where(and(eq(patientChannels.patientId, input.patientId), isNull(patientChannels.chatId)));

  await db.insert(patientChannels).values({
    patientId: input.patientId,
    channel: 'telegram',
    chatId: null,
    linkCode: input.code,
    linkCodeExpiresAt: input.expiresAt,
  });
};

/** Canales vinculados (con chat) de un paciente o de todos, para la bandeja. */
export const listChannels = async (
  db: NotificationsDb,
  patientId?: string,
): Promise<
  {
    patientId: string;
    chatId: string;
    telegramUsername: string | null;
    linkedAt: Date;
    isBlocked: boolean;
  }[]
> => {
  const conditions = [isNotNull(patientChannels.chatId)];
  if (patientId !== undefined) conditions.push(eq(patientChannels.patientId, patientId));

  const rows = await db
    .select()
    .from(patientChannels)
    .where(and(...conditions))
    .orderBy(desc(patientChannels.linkedAt))
    .limit(100);

  return rows.flatMap((row) =>
    row.chatId === null
      ? []
      : [
          {
            patientId: row.patientId,
            chatId: row.chatId,
            telegramUsername: row.telegramUsername,
            linkedAt: row.linkedAt,
            isBlocked: row.isBlocked,
          },
        ],
  );
};

export const linkChat = async (
  db: NotificationsDb,
  input: { patientId: string; chatId: string; telegramUsername: string | null; viaCode?: string },
): Promise<void> => {
  if (input.viaCode !== undefined) {
    // La fila pendiente del código desaparece: el chat real ocupa su lugar.
    await db.delete(patientChannels).where(eq(patientChannels.linkCode, input.viaCode));
  }

  await db
    .insert(patientChannels)
    .values({
      patientId: input.patientId,
      channel: 'telegram',
      chatId: input.chatId,
      telegramUsername: input.telegramUsername,
      linkedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [patientChannels.channel, patientChannels.chatId],
      set: {
        patientId: input.patientId,
        telegramUsername: input.telegramUsername,
        isBlocked: false,
        linkedAt: new Date(),
        updatedAt: new Date(),
      },
    });
};

export const unlinkPatient = async (db: NotificationsDb, patientId: string): Promise<void> => {
  await db
    .update(patientChannels)
    .set({ isBlocked: true, updatedAt: new Date() })
    .where(eq(patientChannels.patientId, patientId));
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
  channel?: Channel;
  payload: Record<string, unknown>;
  /** Clave de idempotencia: la misma cita no genera dos avisos del mismo tipo. */
  dedupeKey: string;
  /** Texto ya redactado (si no viene, se arma con la plantilla de la base). */
  text?: string;
  /** Adjunto `.ics` para los avisos de cita. */
  attachIcs?: boolean;
  /** Intentos permitidos antes de darlo por fallido (por defecto, los del plan). */
  maxAttempts?: number;
}

/**
 * Encola un aviso. Si ya existe uno con la misma clave de deduplicación, devuelve
 * `null` en vez de duplicarlo: es la idempotencia por cita y canal que pide el plan
 * (un evento repetido no vuelve a escribir al paciente).
 */
export const enqueue = async (
  db: NotificationsDb,
  input: EnqueueInput,
): Promise<NotificationRecord | null> => {
  const channel = input.channel ?? 'telegram';
  const linked = channel === 'telegram' ? await findChannel(db, input.patientId) : null;
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
      recipient: linked?.chatId ?? null,
      // Sin Telegram vinculado no hay a quién escribir: queda como aviso manual.
      status: linked === null ? 'skipped_no_channel' : 'queued',
      maxAttempts: input.maxAttempts ?? NOTIFICATION_MAX_ATTEMPTS,
      nextAttemptAt: new Date(),
      payload: { ...input.payload, text, attachIcs: input.attachIcs ?? false },
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

/** Reintento manual desde la bandeja: vuelve a la cola ahora mismo. */
export const retryNotification = async (
  db: NotificationsDb,
  id: string,
  reason: string | undefined,
): Promise<NotificationRecord> => {
  const current = await db.select().from(notifications).where(eq(notifications.id, id)).limit(1);
  const row = current[0];
  if (row === undefined) throw new NotFoundError('El aviso no existe');

  const linked = row.recipient === null ? await findChannel(db, row.patientId) : null;
  const rows = await db
    .update(notifications)
    .set({
      status: linked === null && row.recipient === null ? 'skipped_no_channel' : 'queued',
      attempts: 0,
      // Un reintento manual vuelve a permitir la cadena completa de reintentos.
      maxAttempts: NOTIFICATION_MAX_ATTEMPTS,
      lastError: null,
      nextAttemptAt: new Date(),
      recipient: row.recipient ?? linked?.chatId ?? null,
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

export interface GeneratedIcs {
  filename: string;
  content: string;
  sha256: string;
  sequence: number;
}

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
  if (found !== undefined) {
    return {
      filename: found.filename,
      content: found.content,
      sha256: found.sha256,
      sequence: found.sequence,
    };
  }

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
      `Consultorio: ${config.CLINIC_NAME}`,
    location: config.CLINIC_ADDRESS,
    organizerName: config.CLINIC_NAME,
    organizerEmail: config.CLINIC_EMAIL,
    attendeeName: appointment.patientName,
  });

  const filename = icsFilename(appointment.ticket, appointment.id);
  const sha256 = icsSha256(content);

  await db
    .insert(icsArtifacts)
    .values({
      appointmentId: appointment.id,
      sequence: appointment.icsSequence,
      filename,
      content,
      sha256,
    })
    .onConflictDoNothing({ target: [icsArtifacts.appointmentId, icsArtifacts.sequence] });

  return { filename, content, sha256, sequence: appointment.icsSequence };
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
}

const textOf = (row: NotificationRow): string =>
  typeof row.payload['text'] === 'string' ? row.payload['text'] : '';

/**
 * Toma los avisos que toca enviar y los manda por Telegram.
 *
 * Los fallos no se pierden: cada intento cuenta y el siguiente se programa con
 * retroceso exponencial (1 m, 5 m, 15 m, 1 h, 6 h). Los avisos de cita llevan el
 * `.ics` adjunto como documento `cita-<ticket>.ics`.
 */
export const processQueue = async (
  db: NotificationsDb,
  transport: TelegramTransport,
  config: NotificationsConfig,
  options: {
    limit?: number;
    now?: Date;
    appointmentLoader?: (id: string) => Promise<AppointmentSummary | null>;
    /** Se llama por cada aviso resuelto: sirve para dejar rastro en la auditoría. */
    onResult?: (info: {
      id: string;
      patientId: string;
      appointmentId: string | null;
      templateKey: string;
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

  for (const row of pending) {
    const claimed = await db
      .update(notifications)
      .set({ status: 'sending', updatedAt: new Date() })
      .where(and(eq(notifications.id, row.id), eq(notifications.status, 'queued')))
      .returning({ id: notifications.id });

    // Otro proceso se lo llevó entre la lectura y el update: se salta.
    if (claimed.length === 0) continue;

    const recipient = row.recipient ?? (await findChannel(db, row.patientId))?.chatId ?? null;
    if (recipient === null) {
      await db
        .update(notifications)
        .set({ status: 'skipped_no_channel', recipient: null, updatedAt: new Date() })
        .where(eq(notifications.id, row.id));
      continue;
    }

    try {
      const text = textOf(row);
      let messageId: string;

      const attachIcs = row.payload['attachIcs'] === true && row.appointmentId !== null;
      if (attachIcs && row.appointmentId !== null) {
        const appointment = await options.appointmentLoader?.(row.appointmentId);
        if (appointment !== null && appointment !== undefined) {
          const ics = await ensureIcsArtifact(db, config, appointment);
          const attachment = await transport.sendDocument(
            recipient,
            {
              filename: ics.filename,
              content: Buffer.from(ics.content, 'utf8'),
              mime: 'text/calendar; charset=utf-8; method=PUBLISH',
            },
            text,
          );
          messageId = attachment.messageId;
        } else {
          const message = await transport.sendMessage(recipient, text);
          messageId = message.messageId;
        }
      } else {
        const message = await transport.sendMessage(recipient, text);
        messageId = message.messageId;
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
          updatedAt: new Date(),
        })
        .where(eq(notifications.id, row.id));
      sent += 1;

      await options.onResult?.({
        id: row.id,
        patientId: row.patientId,
        appointmentId: row.appointmentId,
        templateKey: row.templateKey,
        ok: true,
        providerMessageId: messageId,
      });
    } catch (error) {
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
        ok: false,
        error: message,
      });
    }
  }

  return { processed: pending.length, sent, failed };
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
