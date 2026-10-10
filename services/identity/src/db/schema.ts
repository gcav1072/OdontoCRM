import {
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
import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';

/**
 * Lista de valores para un CHECK escrito como literales SQL.
 *
 * ⚠️ Aquí sí se usa `sql.raw` (excepción justificada a la regla del proyecto): los
 * valores son constantes de `@odontocrm/contracts`, nunca entrada de usuario, y
 * **tienen que quedar literales** porque drizzle-kit parametrizaría el CHECK
 * (`in ($1, $2)`) y el migrador no sustituye parámetros en DDL. La prueba
 * `migrations.test.ts` verifica que ninguna migración contenga `$n`.
 */
const sqlLiteralList = (values: readonly string[]): SQL => {
  const escaped = values.map((value) => `'${value.replace(/'/g, "''")}'`);
  return sql.join(
    // eslint-disable-next-line no-restricted-syntax -- constantes del contrato, nunca entrada de usuario
    escaped.map((value) => sql.raw(value)),
    sql`, `,
  );
};

import { DOC_TYPES, PERMISSIONS, ROLES, SCREEN_KINDS, UI_ACCENT_IDS } from '@odontocrm/contracts';
import type {
  BrandFontsSettings,
  BrandLetterheadSettings,
  BrandPaletteSettings,
  BrandTypographyInput,
  ScreenTexts,
} from '@odontocrm/contracts';

/**
 * Esquema de la base de identidad. Incluye usuarios, sus roles, las sesiones
 * (tokens de refresco con rotación), los dispositivos kiosko y la auditoría.
 *
 * `outbox_events` vive en `packages/db/src/schema/outbox.ts` y se añade al
 * esquema del servicio en `src/db/client.ts`.
 */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    username: text('username').notNull(),
    fullName: text('full_name').notNull(),
    email: text('email'),
    passwordHash: text('password_hash').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    mustChangePassword: boolean('must_change_password').notNull().default(true),
    failedAttempts: integer('failed_attempts').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_users_username').on(table.username),
    index('idx_users_active').on(table.isActive),
  ],
);

/** Roles del usuario. Los roles son un catálogo fijo del sistema (ADR 0005). */
export const userRoles = pgTable(
  'user_roles',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
    grantedBy: uuid('granted_by'),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.role] }),
    check('chk_user_roles_role', sql`${table.role} in (${sqlLiteralList(ROLES)})`),
    index('idx_user_roles_role').on(table.role),
  ],
);

/**
 * Perfil **profesional** de un odontólogo (ADR 0056): lo que firma sus documentos
 * (MPPS, especialidad, colegiatura y correo de membrete). Una fila por usuario.
 *
 * `completedAt` es la marca del **primer llenado**: mientras sea `null`, el odontólogo
 * no tiene permisos y solo puede completar su perfil (el gate del primer acceso, igual
 * que `must_change_password`). El nombre que se imprime es el del usuario
 * (`users.full_name`), no un campo aparte: una sola fuente para el nombre.
 */
export const dentistProfiles = pgTable(
  'dentist_profiles',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    mpps: text('mpps').notNull(),
    specialty: text('specialty').notNull(),
    licenseNumber: text('license_number'),
    contactEmail: text('contact_email'),
    /** Cuándo se completó por primera vez (el gate del primer acceso). */
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('idx_dentist_profiles_completed').on(table.completedAt)],
);

/**
 * Datos del consultorio para el membrete (una **sola fila**, patrón de tabla
 * singleton: `id = 1`). Los llena el **titular** en su primer acceso y a partir de ahí
 * son la fuente del membrete; `clinic.ts` queda como respaldo neutro, sin datos personales.
 *
 * El logo subido vive en el **almacén** (`logo_blob_key`); aquí solo queda su clave y
 * su tipo MIME. La **marca** (paleta, tipografías, medidas) no está aquí: sigue siendo
 * solo-código (`brand.ts`).
 */
export const clinicProfiles = pgTable(
  'clinic_profiles',
  {
    id: integer('id').primaryKey().default(1),
    name: text('name').notNull(),
    legalName: text('legal_name'),
    address: text('address').notNull(),
    city: text('city'),
    phones: text('phones')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    email: text('email'),
    rif: text('rif'),
    website: text('website'),
    /** Clave del objeto en el almacén con el logo subido, o `null`. */
    logoBlobKey: text('logo_blob_key'),
    logoMime: text('logo_mime'),
    /** Cuándo lo completó el titular por primera vez. */
    completedAt: timestamp('completed_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check('chk_clinic_profiles_singleton', sql`${table.id} = 1`)],
);

/**
 * Tokens de refresco. Se guarda **solo el hash**: si alguien lee la base no puede
 * suplantar una sesión. `familyId` agrupa la cadena de rotaciones de una misma
 * sesión, de modo que detectar un reuso revoca toda la familia (ADR 0005).
 */
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    familyId: uuid('family_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: text('revoked_reason'),
    replacedById: uuid('replaced_by_id'),
    ip: text('ip'),
    userAgent: text('user_agent'),
  },
  (table) => [
    uniqueIndex('uq_refresh_tokens_hash').on(table.tokenHash),
    index('idx_refresh_tokens_family').on(table.familyId),
    index('idx_refresh_tokens_user').on(table.userId),
  ],
);

/** Tokens de las pantallas kiosko (sala de espera y consultorio). */
export const deviceTokens = pgTable(
  'device_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    label: text('label').notNull(),
    kind: text('kind').notNull(),
    tokenHash: text('token_hash').notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    isActive: boolean('is_active').notNull().default(true),
  },
  (table) => [
    uniqueIndex('uq_device_tokens_hash').on(table.tokenHash),
    check('chk_device_tokens_kind', sql`${table.kind} in (${sqlLiteralList(SCREEN_KINDS)})`),
    index('idx_device_tokens_active').on(table.isActive),
  ],
);

/**
 * Auditoría: una fila por acción sensible, con el estado anterior y posterior de
 * los campos que cambiaron. Es la base del módulo de auditoría (Fase 9) y de la
 * trazabilidad de datos clínicos.
 */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    actorId: uuid('actor_id'),
    actorUsername: text('actor_username'),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id'),
    /** Línea legible del hecho, para la consulta de auditoría. */
    summary: text('summary'),
    before: jsonb('before').$type<Record<string, unknown> | null>(),
    after: jsonb('after').$type<Record<string, unknown> | null>(),
    changedFields: text('changed_fields')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    reason: text('reason'),
    ip: text('ip'),
    userAgent: text('user_agent'),
    requestId: text('request_id'),
  },
  (table) => [
    index('idx_audit_occurred').on(table.occurredAt),
    index('idx_audit_actor').on(table.actorId),
    index('idx_audit_action').on(table.action),
    index('idx_audit_entity').on(table.entityType, table.entityId),
  ],
);

/**
 * Marca de los **imprimibles** guardada en la base (ADR 0060): paleta, tipografías,
 * medidas y fuentes. Una **sola fila** (patrón singleton `id = 1`).
 *
 * Mientras no haya fila, la marca sale del respaldo del código (`BRAND`), así que una
 * instalación recién puesta imprime con la identidad de fábrica sin sembrar nada.
 * El **logo** no está aquí: ya vive en `clinic_profiles` (ADR 0056) y esta marca lo
 * reutiliza.
 */
export const brandSettings = pgTable(
  'brand_settings',
  {
    id: integer('id').primaryKey().default(1),
    palette: jsonb('palette').$type<BrandPaletteSettings>(),
    typography: jsonb('typography').$type<BrandTypographyInput>(),
    letterhead: jsonb('letterhead').$type<BrandLetterheadSettings>(),
    fonts: jsonb('fonts').$type<BrandFontsSettings>(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid('updated_by'),
  },
  (table) => [check('chk_brand_settings_singleton', sql`${table.id} = 1`)],
);

/**
 * Configuración de la **aplicación** (ADR 0060): el acento de la interfaz y los
 * textos del kiosko. Una sola fila (`id = 1`). El acento `null` significa «el de
 * fábrica» (`DEFAULT_UI_ACCENT`).
 */
export const appSettings = pgTable(
  'app_settings',
  {
    id: integer('id').primaryKey().default(1),
    accent: text('accent'),
    screenTexts: jsonb('screen_texts')
      .$type<ScreenTexts>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid('updated_by'),
  },
  (table) => [
    check('chk_app_settings_singleton', sql`${table.id} = 1`),
    check(
      'chk_app_settings_accent',
      sql`${table.accent} is null or ${table.accent} in (${sqlLiteralList(UI_ACCENT_IDS)})`,
    ),
  ],
);

/**
 * Credenciales y datos de los **canales de mensajería** (ADR 0060), una sola fila.
 *
 * Los **secretos** se guardan cifrados (`…_enc`: el blob del almacén con AES-256-GCM,
 * en base64) con la misma clave que el resto del almacén. Los datos no secretos
 * (usuario del bot, chat del admin, teléfono y base de WhatsApp) van en claro porque
 * el panel los muestra.
 */
export const channelSettings = pgTable(
  'channel_settings',
  {
    id: integer('id').primaryKey().default(1),
    telegramBotUsername: text('telegram_bot_username'),
    adminTelegramChatId: text('admin_telegram_chat_id'),
    whatsappPhoneId: text('whatsapp_phone_id'),
    whatsappApiBase: text('whatsapp_api_base'),
    telegramBotTokenEnc: text('telegram_bot_token_enc'),
    adminTelegramBotTokenEnc: text('admin_telegram_bot_token_enc'),
    whatsappTokenEnc: text('whatsapp_token_enc'),
    whatsappVerifyTokenEnc: text('whatsapp_verify_token_enc'),
    whatsappAppSecretEnc: text('whatsapp_app_secret_enc'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid('updated_by'),
  },
  (table) => [check('chk_channel_settings_singleton', sql`${table.id} = 1`)],
);

/**
 * Registro de eventos ya procesados. Los consumidores de la cola deben ser
 * idempotentes: si el mismo evento llega dos veces (reintento de pg-boss, doble
 * entrega), se ignora. La clave es el `eventId` del sobre.
 */
export const processedEvents = pgTable(
  'processed_events',
  {
    eventId: uuid('event_id').primaryKey(),
    eventType: text('event_type').notNull(),
    producer: text('producer').notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('idx_processed_events_type').on(table.eventType, table.processedAt)],
);

export type ProcessedEventRow = typeof processedEvents.$inferSelect;

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
export type UserRoleRow = typeof userRoles.$inferSelect;
export type DentistProfileRow = typeof dentistProfiles.$inferSelect;
export type NewDentistProfileRow = typeof dentistProfiles.$inferInsert;
export type ClinicProfileRow = typeof clinicProfiles.$inferSelect;
export type NewClinicProfileRow = typeof clinicProfiles.$inferInsert;
export type RefreshTokenRow = typeof refreshTokens.$inferSelect;
export type DeviceTokenRow = typeof deviceTokens.$inferSelect;
export type AuditEventRow = typeof auditEvents.$inferSelect;

/** Se exporta para que quede claro qué valores admite `user_roles.role`. */
export const ALLOWED_ROLES = ROLES;
export const ALLOWED_PERMISSIONS = PERMISSIONS;
export const ALLOWED_DOC_TYPES = DOC_TYPES;
