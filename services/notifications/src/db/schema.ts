import { CHANNELS, NOTIFICATION_STATUSES } from '@odontocrm/contracts';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/** Lista de valores para un CHECK como literales (ver nota en identity/schema.ts). */
const sqlLiteralList = (values: readonly string[]) => {
  const escaped = values.map((value) => `'${value.replace(/'/g, "''")}'`);
  return sql.join(
    // eslint-disable-next-line no-restricted-syntax -- constantes del contrato, nunca entrada de usuario
    escaped.map((value) => sql.raw(value)),
    sql`, `,
  );
};

/**
 * Canal de un paciente: la **dirección** a la que se le escribe (`chat_id` de
 * Telegram o número de WhatsApp). La identidad es `(channel, direccion)`, así que
 * un mismo paciente puede estar vinculado por los dos canales sin pisarse.
 */
export const patientChannels = pgTable(
  'patient_channels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    patientId: uuid('patient_id').notNull(),
    channel: text('channel').notNull().default('telegram'),
    /** Dirección del interlocutor: chat numérico (Telegram) o número (WhatsApp). */
    direccion: text('direccion'),
    /** Nombre de usuario del canal, si lo hay (para mostrarlo en la bandeja). */
    usuario: text('usuario'),
    linkedAt: timestamp('linked_at', { withTimezone: true }).notNull().defaultNow(),
    /** Código del deep link de vinculación (se borra al usarlo). */
    linkCode: text('link_code'),
    linkCodeExpiresAt: timestamp('link_code_expires_at', { withTimezone: true }),
    isBlocked: boolean('is_blocked').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_patient_channels_direccion').on(table.channel, table.direccion),
    index('idx_patient_channels_patient').on(table.patientId),
    uniqueIndex('uq_patient_channels_link_code').on(table.linkCode),
    check('chk_patient_channels_channel', sql`${table.channel} in (${sqlLiteralList(CHANNELS)})`),
  ],
);

/**
 * Conversación del asistente por **canal y dirección**: permite **retomar** donde
 * se quedó el paciente (se va, vuelve al día siguiente y el bot sigue en el mismo
 * paso) y que la misma persona hable por Telegram y por WhatsApp en paralelo.
 */
export const botConversations = pgTable(
  'bot_conversations',
  {
    canal: text('canal').notNull().default('telegram'),
    direccion: text('direccion').notNull(),
    state: text('state').notNull().default('inicio'),
    draft: jsonb('draft').$type<Record<string, unknown>>().notNull().default({}),
    patientId: uuid('patient_id'),
    usuario: text('usuario'),
    /**
     * Opciones numeradas del último paso enviado (ADR 0029): en los canales sin
     * botones el paciente responde «2» y aquí se recuerda qué acción era.
     */
    opciones: jsonb('opciones').$type<Record<string, string>>().notNull().default({}),
    /** Último ticket creado desde esta conversación (para «estado» y «mi ticket»). */
    lastTicket: bigint('last_ticket', { mode: 'number' }),
    /** Ventana móvil de anti-flood: mensajes recibidos y cuándo empezó. */
    messageCount: integer('message_count').notNull().default(0),
    windowStartedAt: timestamp('window_started_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.canal, table.direccion] }),
    index('idx_bot_conversations_updated').on(table.updatedAt),
  ],
);

/** Plantillas editables: el texto de los mensajes sin recompilar (plan §4.4). */
export const messageTemplates = pgTable(
  'message_templates',
  {
    key: text('key').primaryKey(),
    channel: text('channel').notNull().default('telegram'),
    subject: text('subject'),
    body: text('body').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('chk_message_templates_channel', sql`${table.channel} in (${sqlLiteralList(CHANNELS)})`),
  ],
);

/**
 * Cola de envíos. La clave de deduplicación (`dedupe_key`) garantiza que la misma
 * cita no genere dos avisos del mismo tipo: es la **idempotencia por cita y canal**
 * que pide el plan, incluso si el evento llega repetido.
 */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    patientId: uuid('patient_id').notNull(),
    patientName: text('patient_name'),
    appointmentId: uuid('appointment_id'),
    templateKey: text('template_key').notNull(),
    channel: text('channel').notNull().default('telegram'),
    /** Chat de destino; `null` cuando el paciente no tiene Telegram vinculado. */
    recipient: text('recipient'),
    status: text('status').notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    lastError: text('last_error'),
    providerMessageId: text('provider_message_id'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    /** Aviso hecho por teléfono cuando el paciente no tiene Telegram. */
    manualNote: text('manual_note'),
    contactedAt: timestamp('contacted_at', { withTimezone: true }),
    contactedBy: uuid('contacted_by'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    dedupeKey: text('dedupe_key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_notifications_dedupe').on(table.dedupeKey),
    index('idx_notifications_queue').on(table.status, table.nextAttemptAt),
    index('idx_notifications_patient').on(table.patientId, table.createdAt),
    index('idx_notifications_appointment').on(table.appointmentId),
    check(
      'chk_notifications_status',
      sql`${table.status} in (${sqlLiteralList(NOTIFICATION_STATUSES)})`,
    ),
  ],
);

/** `.ics` generados: reproducibles y auditables (huella por versión). */
export const icsArtifacts = pgTable(
  'ics_artifacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    appointmentId: uuid('appointment_id').notNull(),
    sequence: integer('sequence').notNull().default(0),
    filename: text('filename').notNull(),
    content: text('content').notNull(),
    sha256: text('sha256').notNull(),
    generatedAt: timestamp('generated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('uq_ics_artifacts_appointment').on(table.appointmentId, table.sequence)],
);

/**
 * Eventos entrantes ya procesados: la clave es `(canal, evento_id)` — el
 * `update_id` de Telegram o el `wamid` de WhatsApp—, así que un reenvío del canal
 * no crea dos tickets.
 */
export const processedUpdates = pgTable(
  'processed_updates',
  {
    canal: text('canal').notNull().default('telegram'),
    eventoId: text('evento_id').notNull(),
    direccion: text('direccion'),
    processedAt: timestamp('processed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.canal, table.eventoId] })],
);

export type PatientChannelRow = typeof patientChannels.$inferSelect;
export type BotConversationRow = typeof botConversations.$inferSelect;
export type MessageTemplateRow = typeof messageTemplates.$inferSelect;
export type NotificationRow = typeof notifications.$inferSelect;
export type IcsArtifactRow = typeof icsArtifacts.$inferSelect;
