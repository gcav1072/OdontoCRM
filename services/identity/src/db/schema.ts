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

import { DOC_TYPES, PERMISSIONS, ROLES, SCREEN_KINDS } from '@odontocrm/contracts';

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
export type RefreshTokenRow = typeof refreshTokens.$inferSelect;
export type DeviceTokenRow = typeof deviceTokens.$inferSelect;
export type AuditEventRow = typeof auditEvents.$inferSelect;

/** Se exporta para que quede claro qué valores admite `user_roles.role`. */
export const ALLOWED_ROLES = ROLES;
export const ALLOWED_PERMISSIONS = PERMISSIONS;
export const ALLOWED_DOC_TYPES = DOC_TYPES;
