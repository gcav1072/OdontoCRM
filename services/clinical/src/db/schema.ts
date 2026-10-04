import {
  CLINICAL_ATTACHMENT_KINDS,
  CLINICAL_SECTION_KEYS,
  CLINICAL_SESSION_STATUSES,
  MEDICAL_RECORD_STATUSES,
  MEDICATION_ROUTES,
  PRESCRIPTION_STATUSES,
} from '@odontocrm/contracts';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgSequence,
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

/* ── Adjuntos de la sesión (Fase 7, sesión B) ──────────────────────────────── */

/**
 * Radiografías, fotos clínicas y documentos de una sesión.
 *
 * El binario vive en disco (almacén compartido, `STORAGE_DIR`); aquí quedan los
 * metadatos, la huella y —cuando corresponde— la pieza a la que se refiere. Se
 * borran con la sesión solo si esta se descarta: un adjunto de una sesión ya no
 * tiene sentido sin ella (de ahí la cascada).
 */
export const clinicalSessionFiles = pgTable(
  'clinical_session_files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => clinicalSessions.id, { onDelete: 'cascade' }),
    patientId: uuid('patient_id').notNull(),
    kind: text('kind').notNull(),
    originalName: text('original_name').notNull(),
    mime: text('mime').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    /** Ruta relativa dentro del almacén: la construye el servicio, nunca el cliente. */
    storagePath: text('storage_path').notNull(),
    sha256: text('sha256').notNull(),
    caption: text('caption'),
    /** Pieza FDI a la que se refiere la imagen (una periapical del 46). */
    toothNumber: integer('tooth_number'),
    uploadedBy: uuid('uploaded_by'),
    uploadedByUsername: text('uploaded_by_username'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_clinical_session_files_session').on(table.sessionId, table.createdAt),
    index('idx_clinical_session_files_patient').on(table.patientId),
    check(
      'chk_clinical_session_files_kind',
      sql`${table.kind} in (${sqlLiteralList(CLINICAL_ATTACHMENT_KINDS)})`,
    ),
    check(
      'chk_clinical_session_files_tooth',
      sql`${table.toothNumber} is null or (${table.toothNumber} >= 11 and ${table.toothNumber} <= 85)`,
    ),
  ],
);

/* ── Récipes (Fase 7, sesión B) ────────────────────────────────────────────── */

/**
 * Catálogo de medicamentos: lo que autocompleta el récipe. Es un catálogo
 * **cerrado y editable** en la base (no en el código) porque un consultorio puede
 * trabajar con otros laboratorios; el récipe guarda además su propia copia del
 * medicamento, así que cambiar el catálogo no reescribe los récipes emitidos.
 */
export const medicationsCatalog = pgTable(
  'medications_catalog',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    /** Presentaciones y concentraciones («Tabletas 500 mg»). */
    presentations: jsonb('presentations').$type<string[]>().notNull().default([]),
    /** Vías habituales, en orden de preferencia. */
    routes: jsonb('routes').$type<string[]>().notNull().default([]),
    usualDose: text('usual_dose'),
    usualFrequency: text('usual_frequency'),
    usualDuration: text('usual_duration'),
    indications: text('indications'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_medications_catalog_name').on(table.name),
    index('idx_medications_catalog_active').on(table.isActive, table.name),
  ],
);

/** Secuencia del número de récipe: `RX-000001` es el 1 (atómico, sin carreras). */
export const prescriptionNumberSequence = pgSequence('prescription_number_seq', {
  startWith: 1,
});

/**
 * Récipes. Nacen como `borrador`, se **emiten** con su número, su PDF A5 archivado
 * y su código de verificación, y **nunca se borran**: se anulan con motivo, y el
 * `CHECK` garantiza que lo emitido tenga número y código.
 */
export const prescriptions = pgTable(
  'prescriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Número de la secuencia; se asigna al emitir. */
    prescriptionNumber: integer('prescription_number'),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => clinicalSessions.id, { onDelete: 'cascade' }),
    patientId: uuid('patient_id').notNull(),
    status: text('status').notNull().default('borrador'),
    generalInstructions: text('general_instructions'),
    /**
     * Copia de los datos del paciente **tal como se imprimieron** (nombre,
     * documento, fecha de nacimiento y edad). Un récipe es un documento legal: si
     * mañana el paciente corrige su nombre o su cédula, el récipe emitido tiene que
     * seguir diciendo lo que decía.
     */
    patientSnapshot: jsonb('patient_snapshot').$type<Record<string, unknown>>(),
    issuedAt: timestamp('issued_at', { withTimezone: true }),
    issuedBy: uuid('issued_by'),
    issuedByUsername: text('issued_by_username'),
    /** Código que lleva el QR y resuelve la página pública `/verificar/<código>`. */
    verifyCode: text('verify_code'),
    /** PDF A5 archivado (ruta dentro del almacén) y su huella. */
    pdfPath: text('pdf_path'),
    pdfSha256: text('pdf_sha256'),
    generatedAt: timestamp('generated_at', { withTimezone: true }),
    printCount: integer('print_count').notNull().default(0),
    lastPrintedAt: timestamp('last_printed_at', { withTimezone: true }),
    annulledAt: timestamp('annulled_at', { withTimezone: true }),
    annulledBy: uuid('annulled_by'),
    annulledByUsername: text('annulled_by_username'),
    annulReason: text('annul_reason'),
    createdBy: uuid('created_by'),
    createdByUsername: text('created_by_username'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_prescriptions_number').on(table.prescriptionNumber),
    uniqueIndex('uq_prescriptions_verify_code').on(table.verifyCode),
    /** Un solo borrador por sesión: dos pestañas no preparan dos récipes a la vez. */
    uniqueIndex('uq_prescriptions_session_draft')
      .on(table.sessionId)
      .where(sql`${table.status} = 'borrador'`),
    index('idx_prescriptions_patient').on(table.patientId, table.createdAt),
    index('idx_prescriptions_session').on(table.sessionId, table.createdAt),
    check(
      'chk_prescriptions_status',
      sql`${table.status} in (${sqlLiteralList(PRESCRIPTION_STATUSES)})`,
    ),
    check(
      'chk_prescriptions_number',
      sql`${table.prescriptionNumber} is null or ${table.prescriptionNumber} > 0`,
    ),
    /** Lo que está emitido tiene número, código y PDF: sin eso no es un documento. */
    check(
      'chk_prescriptions_issued',
      sql`${table.status} <> 'emitida' or (${table.prescriptionNumber} is not null and ${table.verifyCode} is not null and ${table.pdfPath} is not null and ${table.issuedAt} is not null)`,
    ),
    check(
      'chk_prescriptions_annulled',
      sql`${table.status} <> 'anulada' or (${table.annulledAt} is not null and ${table.annulReason} is not null)`,
    ),
  ],
);

/**
 * Las líneas del récipe: el medicamento **tal como se imprimió**. Se guarda el
 * nombre y la presentación aunque vengan del catálogo, para que editar el catálogo
 * (o retirar un medicamento) no cambie un récipe ya emitido.
 */
export const prescriptionItems = pgTable(
  'prescription_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    prescriptionId: uuid('prescription_id')
      .notNull()
      .references(() => prescriptions.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    medicationId: uuid('medication_id'),
    medicationName: text('medication_name').notNull(),
    presentation: text('presentation'),
    route: text('route'),
    dose: text('dose').notNull(),
    frequency: text('frequency').notNull(),
    duration: text('duration'),
    instructions: text('instructions'),
    quantity: text('quantity'),
  },
  (table) => [
    uniqueIndex('uq_prescription_items_position').on(table.prescriptionId, table.position),
    check(
      'chk_prescription_items_route',
      sql`${table.route} is null or ${table.route} in (${sqlLiteralList(MEDICATION_ROUTES)})`,
    ),
  ],
);

export type ClinicalSessionFileRow = typeof clinicalSessionFiles.$inferSelect;
export type MedicationRow = typeof medicationsCatalog.$inferSelect;
export type PrescriptionRow = typeof prescriptions.$inferSelect;
export type PrescriptionItemRow = typeof prescriptionItems.$inferSelect;
