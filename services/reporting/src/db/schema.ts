import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  date,
  index,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Read model del servicio de reportes (Fase 9).
 *
 * **Ningún reporte consulta las bases operativas**: los servicios publican sus
 * eventos en el outbox y el consumidor de `reporting` los proyecta aquí
 * ([ADR 0019](../../../../docs/adr/0019-reportes-y-kpis.md)). Por eso las tablas se
 * llaman `dim_*` (dimensiones, el «quién» y el «cuándo») y `fact_*` (hechos, el
 * «qué pasó»), y por eso **no hay claves foráneas entre hechos**: los eventos
 * pueden llegar desordenados o de un agregado que todavía no se ha visto, y una FK
 * tiraría el lote entero. Las columnas `patient_id` se indexan y se cruzan con
 * `dim_patient` al consultar.
 *
 * `fact_appointment` y `fact_request` llevan los tiempos de cada transición
 * (`notified_at`, `checked_in_at`, `called_at`, `started_at`, `finished_at`…) para
 * poder medir esperas y horas pico sin volver a la agenda.
 */

/* ── Dimensiones ───────────────────────────────────────────────────────────── */

/**
 * Un paciente del read model. Se alimenta de `patients.patient.created|updated|deleted`
 * y se **enriquece** con `clinical.record.*` (alertas del perfil clínico) y con las
 * visitas (`first_visit_at`/`last_visit_at`).
 *
 * `created_at` es la fecha del **alta** (la del evento, que se publica en la misma
 * transacción que el `insert` del paciente): es lo que filtra el reporte
 * demográfico por rango de fechas.
 */
export const dimPatient = pgTable(
  'dim_patient',
  {
    patientId: uuid('patient_id').primaryKey(),
    document: text('document').notNull(),
    fullName: text('full_name').notNull(),
    sex: text('sex'),
    birthDate: date('birth_date', { mode: 'string' }),
    status: text('status').notNull().default('en_espera_cita'),
    /** Datos del modo test (cédulas 90.000.000+): el reporte los cuenta aparte. */
    isFictitious: boolean('is_fictitious').notNull().default(false),
    /** Códigos de alerta clínica (`CLINICAL_ALERT_LABELS`) que alimentan el perfil. */
    profileAlerts: text('profile_alerts')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    recordStatus: text('record_status'),
    recordSignedAt: timestamp('record_signed_at', { withTimezone: true }),
    /** Primera y última visita: citas atendidas, sesiones cerradas y récipes. */
    firstVisitAt: timestamp('first_visit_at', { withTimezone: true }),
    lastVisitAt: timestamp('last_visit_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_dim_patient_sex').on(table.sex),
    index('idx_dim_patient_status').on(table.status),
    index('idx_dim_patient_birth').on(table.birthDate),
    index('idx_dim_patient_created').on(table.createdAt),
  ],
);

/**
 * Cupo de cada día y **contadores del tablero** de ese día.
 *
 * `capacity` es `null` mientras nadie haya fijado el cupo a mano: la agenda lo
 * deduce de las plantillas de franjas, dato que el read model no tiene (no viaja en
 * ningún evento) y que por eso no se inventa.
 *
 * Los contadores de avisos viven aquí, y no en una tabla propia, porque el read
 * model no tiene hechos de notificaciones: el tablero necesita «enviados» y
 * «fallidos» **por día** y esta tabla ya está indexada por fecha.
 */
export const dimDayCapacity = pgTable(
  'dim_day_capacity',
  {
    date: date('date', { mode: 'string' }).primaryKey(),
    capacity: integer('capacity'),
    notificationsSent: integer('notifications_sent').notNull().default(0),
    notificationsFailed: integer('notifications_failed').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('idx_dim_day_capacity_date').on(table.date)],
);

/* ── Hechos ────────────────────────────────────────────────────────────────── */

/** Solicitud (ticket) del embudo: se crea y se cancela en la agenda. */
export const factRequest = pgTable(
  'fact_request',
  {
    requestId: uuid('request_id').primaryKey(),
    ticketNumber: bigint('ticket_number', { mode: 'number' }),
    patientId: uuid('patient_id'),
    channel: text('channel').notNull(),
    status: text('status').notNull().default('en_espera_cita'),
    reason: text('reason'),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull(),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    /** Cita que terminó asignándose a esta solicitud (si la hubo). */
    appointmentId: uuid('appointment_id'),
    lastEventAt: timestamp('last_event_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_fact_request_date').on(table.requestedAt),
    index('idx_fact_request_patient').on(table.patientId),
    index('idx_fact_request_status').on(table.status),
  ],
);

/**
 * Cita con **todos sus tiempos**. Es el hecho central del embudo y de la ocupación:
 * cada transición de la máquina de estados deja aquí su instante, de modo que el
 * reporte de horas pico y tiempos de espera no necesita releer la agenda.
 */
export const factAppointment = pgTable(
  'fact_appointment',
  {
    appointmentId: uuid('appointment_id').primaryKey(),
    patientId: uuid('patient_id'),
    appointmentDate: date('appointment_date', { mode: 'string' }).notNull(),
    /** `HH:MM` local del consultorio, tal como llega en el evento. */
    startTime: text('start_time').notNull(),
    endTime: text('end_time').notNull(),
    status: text('status').notNull(),
    channel: text('channel'),
    ticketNumber: bigint('ticket_number', { mode: 'number' }),
    requestId: uuid('request_id'),
    dentistId: uuid('dentist_id'),
    chairId: uuid('chair_id'),
    requestedAt: timestamp('requested_at', { withTimezone: true }),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
    notifiedAt: timestamp('notified_at', { withTimezone: true }),
    /** Cuándo confirmó el paciente su asistencia (ADR 0052). */
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    checkedInAt: timestamp('checked_in_at', { withTimezone: true }),
    calledAt: timestamp('called_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    noShowAt: timestamp('no_show_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    rescheduledAt: timestamp('rescheduled_at', { withTimezone: true }),
    rescheduledFromId: uuid('rescheduled_from_id'),
    noShowReason: text('no_show_reason'),
    forceAttendedReason: text('force_attended_reason'),
    clinicalSessionId: uuid('clinical_session_id'),
    lastEventAt: timestamp('last_event_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_fact_appointment_date').on(table.appointmentDate),
    index('idx_fact_appointment_patient').on(table.patientId),
    index('idx_fact_appointment_status').on(table.status),
    index('idx_fact_appointment_date_status').on(table.appointmentDate, table.status),
  ],
);

/** Sesión clínica: cuenta como movimiento del día y aporta los procedimientos. */
export const factClinicalSession = pgTable(
  'fact_clinical_session',
  {
    sessionId: uuid('session_id').primaryKey(),
    patientId: uuid('patient_id').notNull(),
    appointmentId: uuid('appointment_id'),
    sessionNumber: integer('session_number').notNull().default(1),
    status: text('status').notNull().default('borrador'),
    openedAt: timestamp('opened_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    diagnosisText: text('diagnosis_text'),
    procedureCodes: text('procedure_codes')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    procedureCount: integer('procedure_count').notNull().default(0),
    lastEventAt: timestamp('last_event_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_fact_session_patient').on(table.patientId),
    index('idx_fact_session_opened').on(table.openedAt),
    index('idx_fact_session_appointment').on(table.appointmentId),
  ],
);

/** Récipe emitido (o anulado/reimpreso) con su recuento de renglones. */
export const factPrescription = pgTable(
  'fact_prescription',
  {
    prescriptionId: uuid('prescription_id').primaryKey(),
    number: text('number'),
    patientId: uuid('patient_id').notNull(),
    sessionId: uuid('session_id'),
    status: text('status').notNull().default('emitida'),
    issuedAt: timestamp('issued_at', { withTimezone: true }),
    itemCount: integer('item_count').notNull().default(0),
    annulledAt: timestamp('annulled_at', { withTimezone: true }),
    reprintCount: integer('reprint_count').notNull().default(0),
    lastEventAt: timestamp('last_event_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_fact_prescription_patient').on(table.patientId),
    index('idx_fact_prescription_issued').on(table.issuedAt),
    index('idx_fact_prescription_status').on(table.status),
  ],
);

/**
 * Un renglón por medicamento del récipe: es lo que permite contar «los más
 * recetados» sin abrir el JSON del récipe. Se rellena con el bloque
 * `prescription.medications` del evento (un array de nombres).
 */
export const factPrescriptionItem = pgTable(
  'fact_prescription_item',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    prescriptionId: uuid('prescription_id').notNull(),
    patientId: uuid('patient_id').notNull(),
    medicationName: text('medication_name').notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    index('idx_fact_prescription_item_med').on(table.medicationName, table.issuedAt),
    index('idx_fact_prescription_item_prescription').on(table.prescriptionId),
  ],
);

/**
 * Hallazgo vigente del odontograma, copiado **por clave natural**
 * (`patient_id, tooth_number, condition, coalesce(surface, '')`), que es la misma
 * clave con la que el odontograma decide si un hallazgo ya existe. Así un evento
 * repetido no duplica la fila y un cambio de estado solo la actualiza.
 *
 * El índice único usa `coalesce(surface, '')` porque en PostgreSQL un `NULL` no
 * colisiona con otro `NULL`: sin él, la pieza completa (`surface` nula) se podría
 * insertar dos veces.
 */
export const factToothFinding = pgTable(
  'fact_tooth_finding',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    patientId: uuid('patient_id').notNull(),
    toothNumber: smallint('tooth_number').notNull(),
    condition: text('condition').notNull(),
    surface: text('surface'),
    state: text('state'),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
    /** Cuándo dejó de estar vigente (superado o borrado). */
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    sessionId: uuid('session_id'),
    lastEventAt: timestamp('last_event_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_fact_tooth_finding_slot').on(
      table.patientId,
      table.toothNumber,
      table.condition,
      sql`coalesce(${table.surface}, '')`,
    ),
    index('idx_fact_tooth_finding_patient').on(table.patientId),
    index('idx_fact_tooth_finding_tooth').on(table.toothNumber, table.condition),
    index('idx_fact_tooth_finding_condition').on(table.condition),
  ],
);

/* ── Control del read model ────────────────────────────────────────────────── */

/**
 * Perfil clínico **de paso**, para que el orden de llegada de los eventos no
 * importe.
 *
 * Los eventos de `patients` y los de `clinical` los publican **dos servicios
 * distintos**, cada uno con su publicador de outbox: no hay ningún orden
 * garantizado entre ellos, y se midió en la prueba de humo (2026-10-04): el alta
 * del paciente llegó a procesarse **un segundo después** de los guardados de su
 * historia clínica, así que el `UPDATE` del perfil no encontró fila y las alertas
 * (diabetes, alergia a la penicilina) se perdían en silencio.
 *
 * La solución es no depender del orden: el perfil se escribe **siempre** aquí y,
 * además, se aplica a `dim_patient` si la fila ya existe. Cuando el alta del
 * paciente llega más tarde, se lleva el perfil consigo (`aplicarPerfilDiferido`).
 * La tabla es diminuta (una fila por paciente con historia) y se puede purgar sin
 * miedo: lo que vale es lo que quedó en `dim_patient`.
 */
export const patientProfiles = pgTable(
  'patient_profiles',
  {
    patientId: uuid('patient_id').primaryKey(),
    alertCodes: text('alert_codes')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    recordStatus: text('record_status'),
    recordSignedAt: timestamp('record_signed_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('idx_patient_profiles_updated').on(table.updatedAt)],
);

/** Una fila por refresco de las vistas materializadas (traza y diagnóstico). */
export const reportRefreshes = pgTable(
  'report_refreshes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    /** `evento` (lote del consumidor) · `nocturno` (temporizador) · `manual` (ruta interna). */
    trigger: text('trigger').notNull(),
    views: integer('views').notNull().default(0),
    ok: boolean('ok').notNull().default(false),
    error: text('error'),
  },
  (table) => [index('idx_report_refreshes_started').on(table.startedAt)],
);

/**
 * Registro de eventos ya aplicados al read model. Copia exacta de la tabla de
 * identity: el consumidor es **idempotente** y deduplica por `event_id`, así que un
 * reintento de la cola no duplica ni una cita ni un renglón de récipe.
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

export type DimPatientRow = typeof dimPatient.$inferSelect;
export type DimDayCapacityRow = typeof dimDayCapacity.$inferSelect;
export type FactRequestRow = typeof factRequest.$inferSelect;
export type FactAppointmentRow = typeof factAppointment.$inferSelect;
export type FactClinicalSessionRow = typeof factClinicalSession.$inferSelect;
export type FactPrescriptionRow = typeof factPrescription.$inferSelect;
export type FactPrescriptionItemRow = typeof factPrescriptionItem.$inferSelect;
export type FactToothFindingRow = typeof factToothFinding.$inferSelect;
export type PatientProfileRow = typeof patientProfiles.$inferSelect;
export type ReportRefreshRow = typeof reportRefreshes.$inferSelect;
export type ProcessedEventRow = typeof processedEvents.$inferSelect;
