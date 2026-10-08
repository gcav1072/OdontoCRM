import { date, integer, pgTable, smallint, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Vistas **materializadas** del read model, declaradas aquí solo para poder
 * consultarlas con Drizzle.
 *
 * Viven en este archivo y **no** en `db/schema.ts` a propósito: `drizzle.config.ts`
 * solo mira `src/db/schema.ts` (más el outbox), así que `npm run db:generate:reporting`
 * nunca intentará crear estas vistas como tablas. Las crea la migración escrita a
 * mano `0001_vistas_materializadas.sql`, y las refresca el consumidor tras cada
 * lote y el job nocturno.
 *
 * Cada vista tiene su **índice único** (el grano: día + dimensiones) para que
 * `REFRESH MATERIALIZED VIEW CONCURRENTLY` sea posible el día que el tablero no
 * pueda permitirse el bloqueo de un `REFRESH` normal.
 */

/** KPIs del día: es lo que sirve el tablero (`ReportSummary`) sin tocar hechos. */
export const mvDailyKpis = pgTable('mv_daily_kpis', {
  day: date('day', { mode: 'string' }).notNull(),
  capacity: integer('capacity'),
  assigned: integer('assigned').notNull(),
  scheduled: integer('scheduled').notNull(),
  notified: integer('notified').notNull(),
  /** Confirmadas por el paciente (ADR 0052). */
  confirmed: integer('confirmed').notNull(),
  attended: integer('attended').notNull(),
  noShow: integer('no_show').notNull(),
  cancelled: integer('cancelled').notNull(),
  requests: integer('requests').notNull(),
  sessions: integer('sessions').notNull(),
  prescriptions: integer('prescriptions').notNull(),
  notificationsSent: integer('notifications_sent').notNull(),
  notificationsFailed: integer('notifications_failed').notNull(),
});

/** Embudo por día: solicitudes → programadas → notificadas → confirmadas → atendidas. */
export const mvFunnel = pgTable('mv_funnel', {
  day: date('day', { mode: 'string' }).notNull(),
  requests: integer('requests').notNull(),
  scheduled: integer('scheduled').notNull(),
  notified: integer('notified').notNull(),
  confirmed: integer('confirmed').notNull(),
  attended: integer('attended').notNull(),
  noShow: integer('no_show').notNull(),
  cancelled: integer('cancelled').notNull(),
  /** Canceladas por el **paciente** por el bot (ADR 0053); excluye las de secretaría. */
  cancelledByPatient: integer('cancelled_by_patient').notNull(),
});

/** Pirámide demográfica por día de alta, tramo de edad, sexo y estado. */
export const mvDemographics = pgTable('mv_demographics', {
  day: date('day', { mode: 'string' }).notNull(),
  bucket: text('bucket').notNull(),
  sex: text('sex').notNull(),
  status: text('status').notNull(),
  patients: integer('patients').notNull(),
});

/** Salud bucal: hallazgos vigentes por día, pieza y condición. */
export const mvOralHealth = pgTable('mv_oral_health', {
  day: date('day', { mode: 'string' }).notNull(),
  toothNumber: smallint('tooth_number').notNull(),
  condition: text('condition').notNull(),
  findings: integer('findings').notNull(),
  patients: integer('patients').notNull(),
});

/** Medicamentos recetados por día (sin contar los récipes anulados). */
export const mvPrescriptions = pgTable('mv_prescriptions', {
  day: date('day', { mode: 'string' }).notNull(),
  medicationName: text('medication_name').notNull(),
  prescriptions: integer('prescriptions').notNull(),
  items: integer('items').notNull(),
  patients: integer('patients').notNull(),
  firstIssuedAt: timestamp('first_issued_at', { withTimezone: true }),
  lastIssuedAt: timestamp('last_issued_at', { withTimezone: true }),
});

/** Nombre de cada vista materializada, tal como lo pide el `REFRESH`. */
export const MATERIALIZED_VIEWS = [
  'mv_daily_kpis',
  'mv_funnel',
  'mv_demographics',
  'mv_oral_health',
  'mv_prescriptions',
] as const;

export type MaterializedView = (typeof MATERIALIZED_VIEWS)[number];
