import { CLINICAL_SECTION_KEYS, MEDICAL_RECORD_STATUSES } from '@odontocrm/contracts';
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

export type MedicalRecordRow = typeof medicalRecords.$inferSelect;
export type MedicalRecordSectionRow = typeof medicalRecordSections.$inferSelect;
export type MedicalRecordAmendmentRow = typeof medicalRecordAmendments.$inferSelect;
export type MedicalRecordConsentRow = typeof medicalRecordConsents.$inferSelect;
