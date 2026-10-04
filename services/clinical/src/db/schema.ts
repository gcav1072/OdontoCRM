import {
  CLINICAL_SECTION_KEYS,
  CLINICAL_SESSION_STATUSES,
  MEDICAL_RECORD_STATUSES,
} from '@odontocrm/contracts';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
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
 * Historia clínica de un paciente: **una por paciente** (`uq_medical_records_patient`).
 *
 * Nace en `borrador` (editable, con guardado por sección) y pasa a `firmada`, que
 * es inmutable: a partir de ahí solo se admiten **adendas** con motivo. La
 * identidad del paciente vive en su propio servicio; aquí solo se guarda el `id`.
 */
export const medicalRecords = pgTable(
  'medical_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    patientId: uuid('patient_id').notNull(),
    status: text('status').notNull().default('borrador'),
    signedAt: timestamp('signed_at', { withTimezone: true }),
    signedBy: uuid('signed_by'),
    signedByUsername: text('signed_by_username'),
    /** Última impresión (la secretaría imprime: queda en auditoría con su actor). */
    lastPrintedAt: timestamp('last_printed_at', { withTimezone: true }),
    printCount: integer('print_count').notNull().default(0),
    createdBy: uuid('created_by'),
    updatedBy: uuid('updated_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_medical_records_patient').on(table.patientId),
    index('idx_medical_records_status').on(table.status),
    check(
      'chk_medical_records_status',
      sql`${table.status} in (${sqlLiteralList(MEDICAL_RECORD_STATUSES)})`,
    ),
  ],
);

/**
 * Contenido de cada sección de la historia (`docs/formato_historia.md`): un
 * bloque JSON validado con el esquema de su clave. Se guarda por secciones para
 * poder llenar la historia como borrador sin tener el resto completa.
 */
export const medicalRecordSections = pgTable(
  'medical_record_sections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    recordId: uuid('record_id')
      .notNull()
      .references(() => medicalRecords.id, { onDelete: 'cascade' }),
    sectionKey: text('section_key').notNull(),
    content: jsonb('content').$type<Record<string, unknown>>().notNull(),
    updatedBy: uuid('updated_by'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_medical_record_sections').on(table.recordId, table.sectionKey),
    check(
      'chk_medical_record_sections_key',
      sql`${table.sectionKey} in (${sqlLiteralList(CLINICAL_SECTION_KEYS)})`,
    ),
  ],
);

/**
 * Adendas: la historia firmada no se edita, se corrige con una nota fechada,
 * firmada por su autor y con motivo. Es el rastro legal de la corrección.
 */
export const medicalRecordAmendments = pgTable(
  'medical_record_amendments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    recordId: uuid('record_id')
      .notNull()
      .references(() => medicalRecords.id, { onDelete: 'cascade' }),
    /** Sección a la que se refiere la adenda; `null` = adenda general. */
    sectionKey: text('section_key'),
    reason: text('reason').notNull(),
    content: text('content').notNull(),
    authorId: uuid('author_id'),
    authorUsername: text('author_username'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_medical_record_amendments').on(table.recordId, table.createdAt),
    check(
      'chk_medical_record_amendments_section',
      sql`${table.sectionKey} is null or ${table.sectionKey} in (${sqlLiteralList(CLINICAL_SECTION_KEYS)})`,
    ),
  ],
);

/** Consentimiento informado: registro de quién aceptó, cuándo y ante quién. */
export const medicalRecordConsents = pgTable(
  'medical_record_consents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    recordId: uuid('record_id')
      .notNull()
      .references(() => medicalRecords.id, { onDelete: 'cascade' }),
    accepted: boolean('accepted').notNull().default(true),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }).notNull().defaultNow(),
    acceptedByName: text('accepted_by_name').notNull(),
    acceptedByDocument: text('accepted_by_document'),
    relationship: text('relationship').notNull(),
    witnessName: text('witness_name'),
    notes: text('notes'),
    registeredBy: uuid('registered_by'),
    registeredByUsername: text('registered_by_username'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('uq_medical_record_consents').on(table.recordId)],
);

/**
 * Sesión clínica: la **evolución** del paciente (Fase 7, sesión A).
 *
 * Una sesión por visita, numerada por paciente (`S-000001`), con el documento del
 * día en `content` (signos vitales, examen, procedimientos con pieza y caras,
 * materiales, diagnóstico, indicaciones y próxima cita). Nace en `borrador` —se
 * autoguarda mientras el paciente está sentado— y pasa a `cerrada`, que es
 * **inmutable**: una corrección abre una sesión enmendada (`amended_from_id`) en
 * lugar de reescribir lo que se hizo.
 *
 * La historia puede estar **firmada** y la evolución sigue: firmar cierra la
 * edición de la historia, no la vida del paciente.
 */
export const clinicalSessions = pgTable(
  'clinical_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    recordId: uuid('record_id')
      .notNull()
      .references(() => medicalRecords.id, { onDelete: 'cascade' }),
    /** Desnormalizado a propósito: la sesión se lista por paciente sin pasar por la historia. */
    patientId: uuid('patient_id').notNull(),
    /** Cita que respalda la sesión; es lo que habilita el «atendido» sin motivo. */
    appointmentId: uuid('appointment_id'),
    /** Número de sesión del paciente (1, 2, 3…): «S-000012» se calcula al mostrar. */
    sessionNumber: integer('session_number').notNull(),
    status: text('status').notNull().default('borrador'),
    content: jsonb('content').$type<Record<string, unknown>>().notNull(),
    openedBy: uuid('opened_by'),
    openedByUsername: text('opened_by_username'),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    closedBy: uuid('closed_by'),
    closedByUsername: text('closed_by_username'),
    closureNote: text('closure_note'),
    /** Sesión cerrada que esta corrige (la original no se toca). */
    amendedFromId: uuid('amended_from_id'),
    amendmentReason: text('amendment_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /** El número de sesión es único por paciente: dos visitas no comparten número. */
    uniqueIndex('uq_clinical_sessions_patient_number').on(table.patientId, table.sessionNumber),
    index('idx_clinical_sessions_patient').on(table.patientId, table.sessionNumber),
    index('idx_clinical_sessions_appointment').on(table.appointmentId),
    /**
     * Una sola sesión **abierta** por cita: dos pestañas (o dos toques) no pueden
     * dejar dos borradores del mismo paciente en la misma visita.
     */
    uniqueIndex('uq_clinical_sessions_appointment_open')
      .on(table.appointmentId)
      .where(sql`${table.appointmentId} is not null and ${table.status} = 'borrador'`),
    check(
      'chk_clinical_sessions_status',
      sql`${table.status} in (${sqlLiteralList(CLINICAL_SESSION_STATUSES)})`,
    ),
    check('chk_clinical_sessions_number', sql`${table.sessionNumber} > 0`),
  ],
);

export type MedicalRecordRow = typeof medicalRecords.$inferSelect;
export type MedicalRecordSectionRow = typeof medicalRecordSections.$inferSelect;
export type MedicalRecordAmendmentRow = typeof medicalRecordAmendments.$inferSelect;
export type MedicalRecordConsentRow = typeof medicalRecordConsents.$inferSelect;
export type ClinicalSessionRow = typeof clinicalSessions.$inferSelect;
