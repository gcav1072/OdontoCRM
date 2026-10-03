import {
  BOT_STEP_LABELS,
  botDraftSchema,
  cleanText,
  formatTicket,
  isMinor,
  maskDocument,
  normalizeBotName,
  normalizeDocNumber,
  normalizePhone,
  parseBotDate,
  parseTicket,
  validateDocument,
  type AppointmentStatus,
  type BotDraft,
  type DocType,
  type RequestSummary,
} from '@odontocrm/contracts';
import { and, eq, gt } from 'drizzle-orm';

import type { NotificationsConfig } from './config.js';
import type { NotificationsDb } from './db/client.js';
import { botConversations, patientChannels, type BotConversationRow } from './db/schema.js';
import type { InternalClients } from './internal-client.js';
import { linkChat, renderMessageFor } from './messaging.js';
import type { InlineButton, TelegramTransport, TelegramUpdate } from './telegram.js';

export interface BotServices {
  db: NotificationsDb;
  config: NotificationsConfig;
  transport: TelegramTransport;
  clients: InternalClients;
}

const STATE_LABEL: Readonly<Record<string, string>> = {
  ...BOT_STEP_LABELS,
  inicio: 'Inicio',
  representante: 'Representante',
  esperando_confirmacion: 'Confirmación',
  listo: 'Listo',
};

export const stateLabel = (state: string): string => STATE_LABEL[state] ?? state;

const emptyDraft = (): BotDraft => botDraftSchema.parse({});

const toDraft = (row: BotConversationRow): BotDraft => botDraftSchema.parse(row.draft);

/** Paciente ya registrado: lo mínimo para reutilizar sus datos (caso duplicado). */
interface PatientLike {
  id: string;
  fullName: string;
  docType: string;
  docNumber: string;
  phone: string;
  birthDate: string;
  sex: string;
}

/** Documento con los datos del paciente ya registrado (para el caso duplicado). */
const draftFromPatient = (patient: PatientLike): BotDraft =>
  botDraftSchema.parse({
    fullName: patient.fullName,
    docType: patient.docType,
    docNumber: patient.docNumber,
    phone: patient.phone,
    birthDate: patient.birthDate,
    sex: patient.sex,
  });

/* ── Conversación ──────────────────────────────────────────────────────────── */

export const loadConversation = async (
  db: NotificationsDb,
  chatId: string,
  telegramUsername: string | null,
): Promise<BotConversationRow> => {
  const rows = await db
    .select()
    .from(botConversations)
    .where(eq(botConversations.chatId, chatId))
    .limit(1);
  const existing = rows[0];
  if (existing !== undefined) return existing;

  const inserted = await db
    .insert(botConversations)
    .values({ chatId, state: 'inicio', draft: {}, telegramUsername })
    .onConflictDoNothing({ target: botConversations.chatId })
    .returning();

  const created = inserted[0];
  if (created !== undefined) return created;

  const again = await db
    .select()
    .from(botConversations)
    .where(eq(botConversations.chatId, chatId))
    .limit(1);
  if (again[0] === undefined) throw new Error('No se pudo cargar la conversación');
  return again[0];
};

const saveConversation = async (
  db: NotificationsDb,
  chatId: string,
  patch: {
    state?: string;
    draft?: BotDraft;
    patientId?: string | null;
    lastTicket?: number | null;
  },
): Promise<void> => {
  await db
    .update(botConversations)
    .set({
      ...(patch.state === undefined ? {} : { state: patch.state }),
      ...(patch.draft === undefined ? {} : { draft: patch.draft }),
      ...(patch.patientId === undefined ? {} : { patientId: patch.patientId }),
      ...(patch.lastTicket === undefined ? {} : { lastTicket: patch.lastTicket }),
      updatedAt: new Date(),
    })
    .where(eq(botConversations.chatId, chatId));
};

/** Anti-flood: devuelve `true` si hay que ignorar el mensaje. */
export const isFlooding = async (
  services: BotServices,
  conversation: BotConversationRow,
): Promise<boolean> => {
  const now = new Date();
  const windowMs = services.config.ANTI_FLOOD_WINDOW_SECONDS * 1000;
  const started = conversation.windowStartedAt.getTime();
  const withinWindow = now.getTime() - started < windowMs;

  const count = withinWindow ? conversation.messageCount + 1 : 1;
  const windowStartedAt = withinWindow ? conversation.windowStartedAt : now;

  await services.db
    .update(botConversations)
    .set({ messageCount: count, windowStartedAt, updatedAt: now })
    .where(eq(botConversations.chatId, conversation.chatId));

  return count > services.config.ANTI_FLOOD_MAX_MESSAGES;
};

/* ── Respuestas ────────────────────────────────────────────────────────────── */

const reply = async (
  services: BotServices,
  chatId: string,
  key: string,
  values: Readonly<Record<string, string | null>> = {},
  buttons?: readonly InlineButton[],
): Promise<void> => {
  const text = await renderMessageFor(services.db, key, {
    clinica: services.config.CLINIC_NAME,
    lugar: services.config.CLINIC_ADDRESS,
    ...values,
  });
  await services.transport.sendMessage(chatId, text, buttons === undefined ? {} : { buttons });
};

const askStep = async (
  services: BotServices,
  chatId: string,
  step: 'nombre' | 'documento' | 'telefono' | 'nacimiento' | 'sexo' | 'motivo',
  values: Readonly<Record<string, string | null>> = {},
): Promise<void> => {
  const buttons: readonly InlineButton[] | undefined =
    step === 'documento'
      ? (['V', 'E', 'P', 'SC'] as const).map((type) => ({ text: type, data: `doc:${type}` }))
      : step === 'sexo'
        ? [
            { text: 'M', data: 'sexo:M' },
            { text: 'F', data: 'sexo:F' },
            { text: 'O', data: 'sexo:O' },
          ]
        : undefined;
  await reply(services, chatId, `pedir_${step}`, values, buttons);
};

const summaryOf = (draft: BotDraft): string => {
  const lines = [
    `Nombre: ${draft.fullName ?? '—'}`,
    `Documento: ${draft.docType ?? ''}-${draft.docNumber ?? ''}`,
    `Teléfono: ${draft.phone ?? '—'}`,
    `Fecha de nacimiento: ${draft.birthDate === null ? '—' : draft.birthDate.split('-').reverse().join('/')}`,
    `Sexo: ${draft.sex ?? '—'}`,
    `Motivo: ${draft.reason ?? '—'}`,
  ];
  if (draft.guardianName !== null) {
    lines.push(`Representante: ${draft.guardianName}`);
  }
  return lines.join('\n');
};

const DOC_TYPE_LABEL: Readonly<Record<DocType, string>> = {
  V: 'Venezolano',
  E: 'Extranjero',
  P: 'Pasaporte',
  SC: 'Menor sin cédula',
};

/* ── Comandos ──────────────────────────────────────────────────────────────── */

const estadoDe = (status: AppointmentStatus): string => {
  const labels: Partial<Record<AppointmentStatus, string>> = {
    en_espera_cita: 'EN ESPERA DE CITA',
    programada: 'PROGRAMADA',
    notificada: 'CONFIRMADA Y AVISADA',
    en_sala_espera: 'EN SALA DE ESPERA',
    llamado: 'LLAMADO',
    en_consulta: 'EN CONSULTA',
    atendido: 'ATENDIDO',
    no_asistio: 'NO ASISTIÓ',
    cancelada: 'CANCELADA',
    reprogramada: 'REPROGRAMADA',
  };
  return labels[status] ?? status;
};

const describeRequest = (request: RequestSummary): string =>
  request.appointmentDate === null
    ? 'Todavía estamos buscándole fecha y hora; te avisaremos por aquí.'
    : `Tu cita es el ${request.appointmentDate.split('-').reverse().join('/')} a las ${request.appointmentTime ?? ''}.`;

const showStatus = async (
  services: BotServices,
  chatId: string,
  ticket: string | null,
): Promise<void> => {
  if (ticket === null) {
    await reply(services, chatId, 'sin_solicitud');
    return;
  }

  const parsed = parseTicket(ticket);
  if (parsed === null) {
    await reply(services, chatId, 'sin_solicitud');
    return;
  }

  const found = await services.clients.findRequestByTicket(parsed.value);
  if (found === null) {
    await reply(services, chatId, 'sin_solicitud');
    return;
  }

  await reply(services, chatId, 'estado_solicitud', {
    ticket: found.ticket,
    estado: estadoDe(found.status),
    cita: describeRequest(found),
  });
};

const cancelRequest = async (
  services: BotServices,
  chatId: string,
  ticket: string | null,
): Promise<void> => {
  if (ticket === null) {
    await reply(services, chatId, 'sin_solicitud');
    return;
  }
  const parsed = parseTicket(ticket);
  const found = parsed === null ? null : await services.clients.findRequestByTicket(parsed.value);

  if (found === null) {
    await reply(services, chatId, 'sin_solicitud');
    return;
  }

  if (found.status === 'cancelada') {
    await reply(services, chatId, 'estado_solicitud', {
      ticket: found.ticket,
      estado: estadoDe(found.status),
      cita: 'Ya estaba anulada.',
    });
    return;
  }

  if (found.status !== 'en_espera_cita') {
    await reply(services, chatId, 'estado_solicitud', {
      ticket: found.ticket,
      estado: estadoDe(found.status),
      cita: 'Esta solicitud ya tiene cita asignada: llama al consultorio para cambiarla.',
    });
    return;
  }

  const cancelled = await services.clients.cancelRequest(
    found.id,
    'el paciente la anuló por Telegram',
  );
  await reply(services, chatId, 'estado_solicitud', {
    ticket: cancelled.ticket,
    estado: estadoDe(cancelled.status),
    cita: 'Tu solicitud quedó anulada. Cuando quieras otra, escríbeme /nueva.',
  });
};

/* ── Pasos del asistente ───────────────────────────────────────────────────── */

const handleName = async (
  services: BotServices,
  chatId: string,
  draft: BotDraft,
  text: string,
): Promise<void> => {
  const name = normalizeBotName(text);
  if (!name.ok) {
    await services.transport.sendMessage(chatId, name.message ?? 'Escribe tu nombre completo.');
    await askStep(services, chatId, 'nombre');
    return;
  }

  const next = { ...draft, fullName: name.value };
  await saveConversation(services.db, chatId, { state: 'documento', draft: next });
  await askStep(services, chatId, 'documento');
};

const handleDocument = async (
  services: BotServices,
  chatId: string,
  draft: BotDraft,
  text: string,
): Promise<void> => {
  // Acepta «V-12345678», «v 12.345.678» o solo el número (con el tipo ya elegido).
  const cleaned = text.normalize('NFKC').trim().toUpperCase();
  const match = /^(?<type>V|E|P|SC)?[\s.\-/]*(?<number>[A-Z0-9.\-\s]+)$/.exec(cleaned);
  const type = (match?.groups?.['type'] as DocType | undefined) ?? draft.docType ?? null;
  const number = normalizeDocNumber(match?.groups?.['number'] ?? cleaned);

  if (type === null) {
    await services.transport.sendMessage(
      chatId,
      'Primero elige el tipo de documento con los botones (V, E, P o SC).',
    );
    await askStep(services, chatId, 'documento');
    return;
  }

  const validation = validateDocument(type, number);
  if (!validation.ok) {
    await services.transport.sendMessage(chatId, validation.message ?? 'Revisa el documento.');
    await askStep(services, chatId, 'documento');
    return;
  }

  const next = { ...draft, docType: type, docNumber: number };

  // ¿Ya existe? El plan pide confirmar con los datos enmascarados antes de seguir.
  const existing = await services.clients.findPatientByDocument(type, number);
  if (existing !== null) {
    await saveConversation(services.db, chatId, {
      state: 'confirmacion',
      draft: { ...draftFromPatient(existing), reason: null },
      patientId: existing.id,
    });
    await reply(
      services,
      chatId,
      'documento_duplicado',
      {
        paciente: existing.fullName,
        documento: maskDocument(existing.docType, existing.docNumber),
      },
      [
        { text: 'Sí, soy yo', data: 'duplicado:si' },
        { text: 'No, corregir', data: 'duplicado:no' },
      ],
    );
    return;
  }

  await saveConversation(services.db, chatId, { state: 'telefono', draft: next });
  await askStep(services, chatId, 'telefono');
};

const handlePhone = async (
  services: BotServices,
  chatId: string,
  draft: BotDraft,
  text: string,
): Promise<void> => {
  const phone = normalizePhone(text);
  if (!/^\+58\d{10}$/.test(phone)) {
    await services.transport.sendMessage(
      chatId,
      'Ese teléfono no me sirve: escríbelo con 11 dígitos, por ejemplo 0412-1234567.',
    );
    await askStep(services, chatId, 'telefono');
    return;
  }

  await saveConversation(services.db, chatId, { state: 'nacimiento', draft: { ...draft, phone } });
  await askStep(services, chatId, 'nacimiento');
};

const handleBirthDate = async (
  services: BotServices,
  chatId: string,
  draft: BotDraft,
  text: string,
): Promise<void> => {
  const parsed = parseBotDate(text);
  if (!parsed.ok || parsed.value === undefined) {
    await services.transport.sendMessage(chatId, parsed.message ?? 'Revisa la fecha.');
    await askStep(services, chatId, 'nacimiento');
    return;
  }

  const next = { ...draft, birthDate: parsed.value };
  if (isMinor(parsed.value)) {
    await saveConversation(services.db, chatId, { state: 'representante', draft: next });
    await reply(services, chatId, 'pedir_representante', { paciente: next.fullName });
    return;
  }

  await saveConversation(services.db, chatId, { state: 'sexo', draft: next });
  await askStep(services, chatId, 'sexo');
};

const handleGuardian = async (
  services: BotServices,
  chatId: string,
  draft: BotDraft,
  text: string,
): Promise<void> => {
  const name = normalizeBotName(text);
  if (!name.ok) {
    await services.transport.sendMessage(
      chatId,
      name.message ?? 'Escribe el nombre del representante.',
    );
    await reply(services, chatId, 'pedir_representante', { paciente: draft.fullName });
    return;
  }

  await saveConversation(services.db, chatId, {
    state: 'sexo',
    draft: { ...draft, guardianName: name.value },
  });
  await askStep(services, chatId, 'sexo');
};

const handleReason = async (
  services: BotServices,
  chatId: string,
  draft: BotDraft,
  text: string,
): Promise<void> => {
  const reason = cleanText(text);
  if (reason.length < 5 || reason.length > 500) {
    await services.transport.sendMessage(
      chatId,
      'Cuéntame un poco más (entre 5 y 500 caracteres) para que el consultorio sepa qué necesitas.',
    );
    await askStep(services, chatId, 'motivo');
    return;
  }

  const next = { ...draft, reason };
  await saveConversation(services.db, chatId, { state: 'confirmacion', draft: next });
  await reply(services, chatId, 'confirmar', { resumen: summaryOf(next) }, [
    { text: 'Confirmar', data: 'confirmar:si' },
    { text: 'Corregir', data: 'confirmar:no' },
  ]);
};

/** Crea (o reutiliza) el paciente y su solicitud, y responde con el ticket. */
const finalize = async (
  services: BotServices,
  chatId: string,
  draft: BotDraft,
  patientId: string | null,
): Promise<void> => {
  if (
    draft.fullName === null ||
    draft.docType === null ||
    draft.docNumber === null ||
    draft.phone === null ||
    draft.birthDate === null ||
    draft.sex === null ||
    draft.reason === null
  ) {
    await services.transport.sendMessage(
      chatId,
      'Me falta algún dato. Escribamos la solicitud otra vez.',
    );
    await saveConversation(services.db, chatId, { state: 'nombre', draft: emptyDraft() });
    await askStep(services, chatId, 'nombre');
    return;
  }

  const sex = draft.sex as 'M' | 'F' | 'O';

  const patient =
    patientId === null
      ? await services.clients.upsertPatient({
          docType: draft.docType,
          docNumber: draft.docNumber,
          fullName: draft.fullName,
          birthDate: draft.birthDate,
          sex,
          phone: draft.phone,
          guardian:
            draft.guardianName === null
              ? undefined
              : { fullName: draft.guardianName, relationship: 'Representante', phone: draft.phone },
          channel: 'telegram',
          reason: 'alta desde el bot de Telegram',
        })
      : {
          created: false,
          patient: {
            id: patientId,
            fullName: draft.fullName,
            document: `${draft.docType}-${draft.docNumber}`,
          },
        };

  const summary = await services.clients.createRequest({
    patientId: patient.patient.id,
    patientName: draft.fullName,
    patientDocument: `${draft.docType}-${draft.docNumber}`,
    patientPhone: draft.phone,
    channel: 'telegram',
    reason: draft.reason,
    notes: `Solicitud tomada por el bot (chat ${chatId})`,
  });

  await saveConversation(services.db, chatId, {
    state: 'inicio',
    draft: emptyDraft(),
    patientId: patient.patient.id,
    lastTicket: summary.ticketNumber,
  });

  // El chat queda vinculado al paciente: sus avisos de cita ya tienen destino.
  await linkChat(services.db, {
    patientId: patient.patient.id,
    chatId,
    telegramUsername: null,
  });

  await reply(services, chatId, 'solicitud_recibida', {
    paciente: draft.fullName,
    ticket: summary.ticket,
  });
};

/* ── Entrada de actualizaciones ───────────────────────────────────────────── */

const commandOf = (text: string): { command: string; argument: string } | null => {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  const [rawCommand = '', ...rest] = trimmed.split(/\s+/);
  const command = rawCommand.slice(1).split('@')[0]?.toLowerCase() ?? '';
  return { command, argument: rest.join(' ').trim() };
};

/**
 * Procesa una actualización de Telegram.
 *
 * Todo el guion del plan §7 está aquí: comandos, vinculación por deep link, pasos
 * con validación, confirmación final y anti-flood. Es **idempotente** por
 * `update_id` (lo garantiza el poller) y la conversación se puede retomar en
 * cualquier momento porque el estado vive en la base.
 */
export const handleUpdate = async (
  services: BotServices,
  update: TelegramUpdate,
): Promise<{ chatId: string; handled: boolean; action?: string }> => {
  const callback = update.callback_query;
  const message = update.message;
  const chatIdRaw = callback?.message?.chat.id ?? message?.chat.id;
  if (chatIdRaw === undefined) return { chatId: '', handled: false };

  const chatId = String(chatIdRaw);
  const username = callback?.from?.username ?? message?.from?.username ?? null;
  const incoming = callback?.data ?? message?.text ?? '';
  if (incoming.trim() === '') return { chatId, handled: false };

  const conversation = await loadConversation(services.db, chatId, username);
  if (await isFlooding(services, conversation)) {
    return { chatId, handled: false, action: 'anti_flood' };
  }

  if (callback !== undefined) {
    await services.transport.answerCallbackQuery(callback.id).catch(() => undefined);
  }

  const draft = toDraft(conversation);
  const command = callback === undefined ? commandOf(incoming) : null;

  // Botones: tipo de documento, sexo y confirmaciones.
  if (callback !== undefined) {
    const [kind = '', value = ''] = incoming.split(':');

    if (kind === 'doc') {
      const type = value as DocType;
      await saveConversation(services.db, chatId, { draft: { ...draft, docType: type } });
      await services.transport.sendMessage(
        chatId,
        `${DOC_TYPE_LABEL[type] ?? type}: escríbeme el número (por ejemplo ${
          type === 'V' ? '12345678' : type === 'P' ? 'A123456' : '0042'
        }).`,
      );
      return { chatId, handled: true, action: 'documento_tipo' };
    }

    if (kind === 'sexo') {
      if (!['M', 'F', 'O'].includes(value)) return { chatId, handled: false };
      const next = { ...draft, sex: value };
      await saveConversation(services.db, chatId, { state: 'motivo', draft: next });
      await askStep(services, chatId, 'motivo');
      return { chatId, handled: true, action: 'sexo' };
    }

    if (kind === 'duplicado') {
      if (value === 'si') {
        await saveConversation(services.db, chatId, {
          state: 'motivo',
          draft,
          patientId: conversation.patientId,
        });
        await askStep(services, chatId, 'motivo');
        return { chatId, handled: true, action: 'duplicado_si' };
      }
      await saveConversation(services.db, chatId, {
        state: 'nombre',
        draft: emptyDraft(),
        patientId: null,
      });
      await askStep(services, chatId, 'nombre');
      return { chatId, handled: true, action: 'duplicado_no' };
    }

    if (kind === 'confirmar') {
      if (value === 'si') {
        await finalize(services, chatId, draft, conversation.patientId);
        return { chatId, handled: true, action: 'solicitud_creada' };
      }
      await saveConversation(services.db, chatId, { state: 'nombre', draft: emptyDraft() });
      await askStep(services, chatId, 'nombre');
      return { chatId, handled: true, action: 'corregir' };
    }

    return { chatId, handled: false };
  }

  // Comandos.
  if (command !== null) {
    switch (command.command) {
      case 'start': {
        if (command.argument !== '') {
          const linked = await linkByCode(services, chatId, command.argument, username);
          return { chatId, handled: true, action: linked ? 'vinculado' : 'codigo_invalido' };
        }
        await saveConversation(services.db, chatId, { state: 'inicio', draft: emptyDraft() });
        await reply(services, chatId, 'bienvenida');
        return { chatId, handled: true, action: 'start' };
      }
      case 'ayuda':
      case 'help': {
        await reply(services, chatId, 'ayuda');
        return { chatId, handled: true, action: 'ayuda' };
      }
      case 'estado': {
        const ticket =
          command.argument !== ''
            ? command.argument
            : conversation.lastTicket === null
              ? null
              : formatTicket(conversation.lastTicket).value;
        await showStatus(services, chatId, ticket);
        return { chatId, handled: true, action: 'estado' };
      }
      case 'mi_ticket': {
        const ticket =
          conversation.lastTicket === null ? null : formatTicket(conversation.lastTicket).value;
        await showStatus(services, chatId, ticket);
        return { chatId, handled: true, action: 'mi_ticket' };
      }
      case 'cancelar': {
        const ticket =
          command.argument !== ''
            ? command.argument
            : conversation.lastTicket === null
              ? null
              : formatTicket(conversation.lastTicket).value;
        await cancelRequest(services, chatId, ticket);
        return { chatId, handled: true, action: 'cancelar' };
      }
      case 'nueva': {
        const blocked = await hasActiveRequest(services, conversation);
        if (blocked !== null) {
          await reply(services, chatId, 'solicitud_en_curso', { ticket: blocked });
          return { chatId, handled: true, action: 'solicitud_en_curso' };
        }
        await saveConversation(services.db, chatId, { state: 'nombre', draft: emptyDraft() });
        await askStep(services, chatId, 'nombre');
        return { chatId, handled: true, action: 'nueva' };
      }
      default: {
        await reply(services, chatId, 'ayuda');
        return { chatId, handled: true, action: 'comando_desconocido' };
      }
    }
  }

  // Texto libre: si parece un ticket, se consulta su estado; si no, sigue el paso.
  const maybeTicket = parseTicket(incoming);
  if (maybeTicket !== null && conversation.state === 'inicio') {
    await showStatus(services, chatId, maybeTicket.value);
    return { chatId, handled: true, action: 'estado_por_texto' };
  }

  switch (conversation.state) {
    case 'nombre':
      await handleName(services, chatId, draft, incoming);
      return { chatId, handled: true, action: 'paso_nombre' };
    case 'documento':
      await handleDocument(services, chatId, draft, incoming);
      return { chatId, handled: true, action: 'paso_documento' };
    case 'telefono':
      await handlePhone(services, chatId, draft, incoming);
      return { chatId, handled: true, action: 'paso_telefono' };
    case 'nacimiento':
      await handleBirthDate(services, chatId, draft, incoming);
      return { chatId, handled: true, action: 'paso_nacimiento' };
    case 'representante':
      await handleGuardian(services, chatId, draft, incoming);
      return { chatId, handled: true, action: 'paso_representante' };
    case 'motivo':
      await handleReason(services, chatId, draft, incoming);
      return { chatId, handled: true, action: 'paso_motivo' };
    default: {
      await reply(services, chatId, 'bienvenida');
      return { chatId, handled: true, action: 'bienvenida' };
    }
  }
};

/** ¿Tiene ya una solicitud en curso? Devuelve el ticket si la tiene. */
const hasActiveRequest = async (
  services: BotServices,
  conversation: BotConversationRow,
): Promise<string | null> => {
  if (conversation.lastTicket === null) return null;
  const ticket = formatTicket(conversation.lastTicket).value;
  const found = await services.clients.findRequestByTicket(ticket);
  if (found === null) return null;
  if (
    found.status === 'cancelada' ||
    found.status === 'atendido' ||
    found.status === 'no_asistio'
  ) {
    return null;
  }
  return found.ticket;
};

/** Vinculación por deep link: `t.me/<bot>?start=<código>`. */
const linkByCode = async (
  services: BotServices,
  chatId: string,
  code: string,
  username: string | null,
): Promise<boolean> => {
  const rows = await services.db
    .select()
    .from(patientChannels)
    .where(
      and(eq(patientChannels.linkCode, code), gt(patientChannels.linkCodeExpiresAt, new Date())),
    )
    .limit(1);

  const row = rows[0];
  if (row === undefined) {
    await services.transport.sendMessage(
      chatId,
      'Ese enlace ya no sirve (caducó). Pídele al consultorio uno nuevo, por favor.',
    );
    return false;
  }

  await linkChat(services.db, {
    patientId: row.patientId,
    chatId,
    telegramUsername: username,
    viaCode: code,
  });
  await saveConversation(services.db, chatId, { state: 'inicio', patientId: row.patientId });

  await reply(services, chatId, 'bienvenida');
  await services.transport.sendMessage(
    chatId,
    'Listo: quedaste vinculado con tu ficha del consultorio. Te avisaré por aquí cuando tu cita esté confirmada.',
  );
  return true;
};
