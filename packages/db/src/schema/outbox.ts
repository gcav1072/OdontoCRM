import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Tabla del patrón *transactional outbox*: cada servicio la tiene en su propia
 * base de datos. El evento se inserta **en la misma transacción** que el cambio
 * de datos; un publicador lo entrega después a `pg-boss`. Así un evento nunca se
 * pierde ni se publica dos veces por un fallo a mitad de camino.
 *
 * El sobre completo (contrato `DomainEvent`) se guarda en `envelope`; las
 * columnas sueltas existen solo para consultar e indexar.
 */
export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    envelope: jsonb('envelope').$type<Record<string, unknown>>().notNull(),
    eventId: uuid('event_id').notNull().unique(),
    eventType: text('event_type').notNull(),
    aggregateId: uuid('aggregate_id').notNull(),
    producer: text('producer').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    /** Cuándo se puede reintentar; evita martillar la cola cuando algo falla. */
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
  },
  (table) => [
    index('idx_outbox_pending').on(table.publishedAt, table.nextAttemptAt),
    index('idx_outbox_aggregate').on(table.aggregateId),
  ],
);

export type OutboxEventRow = typeof outboxEvents.$inferSelect;
export type NewOutboxEventRow = typeof outboxEvents.$inferInsert;
