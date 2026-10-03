import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Usuarios del sistema. En la Fase 1 se amplía con roles, permisos, tokens de
 * refresco y dispositivos kiosko mediante migraciones nuevas (nunca editando
 * esta).
 *
 * La contraseña se guarda con `scrypt` de `node:crypto`: sin dependencias
 * nativas (no hace falta compilador de C++ en Windows) y con sal por usuario.
 *
 * Nota: la tabla `outbox_events` vive en `packages/db/src/schema/outbox.ts` y se
 * añade al esquema del servicio en `src/db/client.ts`, para que drizzle-kit
 * genere la migración una sola vez por base.
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

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
