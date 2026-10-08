import { APPOINTMENT_STATUSES, CHANNELS, REQUEST_STATUSES, SLOT_KINDS } from '@odontocrm/contracts';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgSequence,
  pgTable,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
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
 * Secuencia de tickets de solicitud.
 *
 * `nextval()` es atómico en PostgreSQL: dos solicitudes simultáneas **nunca**
 * reciben el mismo número y no hace falta ningún bloqueo en la aplicación. El
 * ticket que ve la gente se formatea desde este número (`#000123`, y si algún día
 * se pasa de 999.999 → `A-000001`; ver `packages/contracts/src/domain/ticket.ts`).
 */
export const ticketSeq = pgSequence('ticket_seq', { startWith: 1, increment: 1 });

/** Solicitud de cita: es el ticket de la cola «en espera de cita». */
export const appointmentRequests = pgTable(
  'appointment_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ticketNumber: bigint('ticket_number', { mode: 'number' })
      .notNull()
      .default(sql`nextval('ticket_seq')`),
    channel: text('channel').notNull().default('registro'),
    patientId: uuid('patient_id').notNull(),
    /** Copia para la cola: la ficha viva del paciente está en el servicio de pacientes. */
    patientName: text('patient_name').notNull(),
    patientDocument: text('patient_document'),
    patientPhone: text('patient_phone'),
    reason: text('reason').notNull(),
    status: text('status').notNull().default('en_espera_cita'),
    priority: integer('priority').notNull().default(0),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    notes: text('notes'),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_appointment_requests_ticket').on(table.ticketNumber),
    index('idx_appointment_requests_status').on(table.status, table.priority, table.ticketNumber),
    index('idx_appointment_requests_patient').on(table.patientId),
    index('idx_appointment_requests_requested').on(table.requestedAt),
    check('chk_requests_channel', sql`${table.channel} in (${sqlLiteralList(CHANNELS)})`),
    // Las solicitudes no pasan por `confirmada` (ADR 0052): no tienen fecha todavía.
    check('chk_requests_status', sql`${table.status} in (${sqlLiteralList(REQUEST_STATUSES)})`),
  ],
);

/**
 * Citas. Una solicitud puede tener varias a lo largo del tiempo (reprogramar crea
 * una nueva y enlaza la anterior con `rescheduled_from_id`: nunca se borra nada).
 */
export const appointments = pgTable(
  'appointments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requestId: uuid('request_id').references(() => appointmentRequests.id, {
      onDelete: 'set null',
    }),
    patientId: uuid('patient_id').notNull(),
    patientName: text('patient_name').notNull(),
    patientDocument: text('patient_document'),
    patientPhone: text('patient_phone'),
    appointmentDate: date('appointment_date', { mode: 'string' }).notNull(),
    startTime: time('start_time').notNull(),
    endTime: time('end_time').notNull(),
    durationMinutes: integer('duration_minutes').notNull(),
    slotKind: text('slot_kind').notNull().default('franja'),
    status: text('status').notNull().default('programada'),
    callCount: integer('call_count').notNull().default(0),
    dentistId: uuid('dentist_id'),
    chairId: uuid('chair_id'),
    checkedInAt: timestamp('checked_in_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    noShowReason: text('no_show_reason'),
    forceAttendedReason: text('force_attended_reason'),
    /**
     * Sesión clínica **cerrada** que respalda el «atendido» (Fase 7): es la prueba
     * de que la cita se atendió con su evolución hecha. El identificador se
     * verifica contra el servicio clínico antes de aceptarlo, así que un cliente no
     * puede saltarse la regla mandando un identificador inventado.
     */
    clinicalSessionId: uuid('clinical_session_id'),
    /**
     * Confirmación del paciente (ADR 0052): **cuándo** dijo que sí y **por dónde**.
     * Van aparte del estado porque el estado dice el último hecho y esto dice el
     * detalle (un cambio posterior a `en_sala_espera` no borra que confirmó). El
     * estado en sí también se mueve a `confirmada`.
     */
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    confirmedChannel: text('confirmed_channel'),
    /**
     * Cancelación del paciente (ADR 0053): **cuándo** y **por dónde** se canceló. Un
     * canal de paciente (`telegram`/`whatsapp`) es lo que distingue una cancelación
     * hecha por el propio paciente de una hecha por la secretaría; la tarjeta y el KPI
     * de reportes miran exactamente eso.
     */
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelledChannel: text('cancelled_channel'),
    overbookAuthorized: boolean('overbook_authorized').notNull().default(false),
    overbookReason: text('overbook_reason'),
    rescheduledFromId: uuid('rescheduled_from_id').references((): AnyPgColumn => appointments.id, {
      onDelete: 'set null',
    }),
    /** Se incrementa al reprogramar: obliga a los calendarios a actualizarse. */
    icsSequence: integer('ics_sequence').notNull().default(0),
    notes: text('notes'),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /**
     * Una sola silla (ADR 0006): no puede haber dos citas **activas** a la misma
     * hora. El índice es parcial porque cancelar o reprogramar libera el hueco, y
     * es la garantía definitiva frente a dos personas asignando a la vez (el
     * servicio además comprueba el solapamiento y responde 409 con un mensaje claro).
     */
    uniqueIndex('uq_appointments_slot')
      .on(table.appointmentDate, table.startTime)
      .where(
        sql`${table.status} in (${sqlLiteralList([
          'programada',
          'notificada',
          // Confirmar mantiene la franja ocupada: si no, el hueco quedaría libre y
          // se podría citar a dos pacientes a la misma hora.
          'confirmada',
          'en_sala_espera',
          'llamado',
          'en_consulta',
          'atendido',
          'no_asistio',
        ])})`,
      ),
    index('idx_appointments_date').on(table.appointmentDate, table.startTime),
    index('idx_appointments_status').on(table.status, table.appointmentDate),
    index('idx_appointments_patient').on(table.patientId),
    index('idx_appointments_request').on(table.requestId),
    check('chk_appointments_slot_kind', sql`${table.slotKind} in (${sqlLiteralList(SLOT_KINDS)})`),
    check(
      'chk_appointments_channel',
      sql`${table.confirmedChannel} is null or ${table.confirmedChannel} in (${sqlLiteralList(CHANNELS)})`,
    ),
    check(
      'chk_appointments_cancelled_channel',
      sql`${table.cancelledChannel} is null or ${table.cancelledChannel} in (${sqlLiteralList(CHANNELS)})`,
    ),
    check(
      'chk_appointments_status',
      sql`${table.status} in (${sqlLiteralList(APPOINTMENT_STATUSES)})`,
    ),
  ],
);

/**
 * Cupo del día. Es **editable en cualquier momento**, incluso después de asignar:
 * bajarlo por debajo de lo asignado avisa pero no borra ninguna cita.
 */
export const dayCapacities = pgTable('day_capacities', {
  date: date('date', { mode: 'string' }).primaryKey(),
  capacity: integer('capacity').notNull(),
  notes: text('notes'),
  updatedBy: uuid('updated_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Plantilla de franjas por día de la semana (una jornada; puede haber varias). */
export const slotTemplates = pgTable(
  'slot_templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    weekday: integer('weekday').notNull(),
    startTime: time('start_time').notNull(),
    endTime: time('end_time').notNull(),
    slotMinutes: integer('slot_minutes').notNull().default(30),
    /** Pausas dentro de la jornada (el almuerzo): `[{startTime,endTime}]`. */
    breaks: jsonb('breaks').$type<{ startTime: string; endTime: string }[]>().notNull().default([]),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('idx_slot_templates_weekday').on(table.weekday, table.isActive)],
);

/**
 * Historial de estados: cada transición con actor, hora y motivo. Alimenta los
 * reportes de tiempos de espera (Fase 9) y es la prueba de que nada se cambió a
 * espaldas de nadie.
 */
export const statusHistory = pgTable(
  'status_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    fromStatus: text('from_status'),
    toStatus: text('to_status').notNull(),
    reason: text('reason'),
    actorId: uuid('actor_id'),
    actorUsername: text('actor_username'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_status_history_entity').on(table.entityType, table.entityId, table.occurredAt),
    check('chk_status_history_entity', sql`${table.entityType} in ('request', 'appointment')`),
  ],
);

export type AppointmentRequestRow = typeof appointmentRequests.$inferSelect;
export type AppointmentRow = typeof appointments.$inferSelect;
export type DayCapacityRow = typeof dayCapacities.$inferSelect;
export type SlotTemplateRow = typeof slotTemplates.$inferSelect;
export type StatusHistoryRow = typeof statusHistory.$inferSelect;
