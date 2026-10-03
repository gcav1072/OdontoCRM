import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { DOC_TYPES, PATIENT_FILE_KINDS, PATIENT_STATUSES, SEXES } from '@odontocrm/contracts';

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
 * Pacientes del consultorio.
 *
 * La identidad del paciente es `(doc_type, doc_number)` normalizados (ADR 0007):
 * `V-12345678` y `v 12.345.678` son la misma persona. El índice único es parcial
 * (`where deleted_at is null`) para poder dar de baja sin bloquear el documento.
 */
export const patients = pgTable(
  'patients',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    docType: text('doc_type').notNull(),
    docNumber: text('doc_number').notNull(),
    fullName: text('full_name').notNull(),
    birthDate: date('birth_date', { mode: 'string' }).notNull(),
    sex: text('sex').notNull(),
    phone: text('phone').notNull(),
    phoneAlt: text('phone_alt'),
    email: text('email'),
    address: text('address'),
    occupation: text('occupation'),
    notes: text('notes'),
    status: text('status').notNull().default('en_espera_cita'),
    /** Marca de los datos del modo test: cédulas 90.000.000+ (ADR 0020). */
    isFictitious: boolean('is_fictitious').notNull().default(false),
    createdBy: uuid('created_by'),
    updatedBy: uuid('updated_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('uq_patients_document')
      .on(table.docType, table.docNumber)
      .where(sql`${table.deletedAt} is null`),
    index('idx_patients_doc_number').on(table.docNumber),
    index('idx_patients_phone').on(table.phone),
    index('idx_patients_status').on(table.status),
    // Búsqueda por nombre: trigrama (pg_trgm), tolera errores de tecleo.
    index('idx_patients_full_name_trgm').using('gin', sql`${table.fullName} gin_trgm_ops`),
    check('chk_patients_doc_type', sql`${table.docType} in (${sqlLiteralList(DOC_TYPES)})`),
    check('chk_patients_sex', sql`${table.sex} in (${sqlLiteralList(SEXES)})`),
    check('chk_patients_status', sql`${table.status} in (${sqlLiteralList(PATIENT_STATUSES)})`),
  ],
);

/** Representante del paciente (obligatorio para menores de edad, ADR 0007). */
export const patientGuardians = pgTable(
  'patient_guardians',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'cascade' }),
    fullName: text('full_name').notNull(),
    docType: text('doc_type'),
    docNumber: text('doc_number'),
    relationship: text('relationship').notNull(),
    phone: text('phone'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('uq_patient_guardians_patient').on(table.patientId)],
);

/**
 * Historial local de los datos de contacto que cambiaron. La auditoría completa
 * vive en identity (llega por el outbox); esto permite ver la evolución del
 * teléfono o la dirección sin salir del servicio de pacientes.
 */
export const patientContactsHistory = pgTable(
  'patient_contacts_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'cascade' }),
    field: text('field').notNull(),
    previousValue: text('previous_value'),
    newValue: text('new_value'),
    reason: text('reason'),
    changedBy: uuid('changed_by'),
    changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('idx_patient_contacts_patient').on(table.patientId, table.changedAt)],
);

/** Archivos del paciente: el binario vive en el almacén, aquí solo los metadatos. */
export const patientFiles = pgTable(
  'patient_files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patients.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    originalName: text('original_name').notNull(),
    mime: text('mime').notNull(),
    size: integer('size').notNull(),
    sha256: text('sha256').notNull(),
    /** Ruta relativa dentro del almacén (nunca una ruta absoluta del sistema). */
    storagePath: text('storage_path').notNull(),
    caption: text('caption'),
    uploadedBy: uuid('uploaded_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    index('idx_patient_files_patient').on(table.patientId, table.createdAt),
    check('chk_patient_files_kind', sql`${table.kind} in (${sqlLiteralList(PATIENT_FILE_KINDS)})`),
  ],
);

export type PatientRow = typeof patients.$inferSelect;
export type NewPatientRow = typeof patients.$inferInsert;
export type PatientGuardianRow = typeof patientGuardians.$inferSelect;
export type PatientFileRow = typeof patientFiles.$inferSelect;
export type PatientContactHistoryRow = typeof patientContactsHistory.$inferSelect;
