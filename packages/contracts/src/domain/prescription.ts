import { z } from 'zod';

import { optionalText } from '../common/optional.js';
import { PRESCRIPTION_STATUSES } from './enums.js';
import { toothNumberSchema } from './odontogram.js';
import { MAX_FILE_BYTES } from './patient.js';

/**
 * Adjuntos de la sesión y **récipes** (Fase 7, sesión B).
 *
 * Un adjunto es una radiografía, una foto clínica o un documento que pertenece a la
 * sesión en la que se tomó y, cuando corresponde, a una pieza concreta.
 *
 * Un récipe es un documento clínico-legal
 * ([ADR 0015](../../../docs/adr/0015-recipe-a5-en-pdf.md)): nace como borrador, se
 * **emite** (número `RX-000001`, PDF A5 archivado y código de verificación) y nunca
 * se borra: si hay que dejarlo sin efecto se **anula** con motivo, y el código de
 * verificación lo dice.
 */

/* ── Adjuntos ──────────────────────────────────────────────────────────────── */

export const CLINICAL_ATTACHMENT_KINDS = [
  'radiografia',
  'foto_clinica',
  'documento',
  'otro',
] as const;
export type ClinicalAttachmentKind = (typeof CLINICAL_ATTACHMENT_KINDS)[number];

export const clinicalAttachmentKindLabel = (kind: ClinicalAttachmentKind): string => {
  switch (kind) {
    case 'radiografia':
      return 'Radiografía';
    case 'foto_clinica':
      return 'Foto clínica';
    case 'documento':
      return 'Documento';
    default:
      return 'Otro';
  }
};

/** Los mismos formatos y el mismo tope que los adjuntos de la ficha del paciente. */
export const CLINICAL_ATTACHMENT_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
] as const;

export const clinicalAttachmentSchema = z.object({
  id: z.uuid(),
  sessionId: z.uuid(),
  patientId: z.uuid(),
  kind: z.enum(CLINICAL_ATTACHMENT_KINDS),
  originalName: z.string(),
  mime: z.string(),
  size: z.number().int().min(0),
  sha256: z.string(),
  /** Pie de foto: qué se ve o por qué se tomó. */
  caption: z.string().nullable(),
  /** Pieza a la que se refiere (una periapical del 46). */
  toothNumber: z.number().int().nullable(),
  uploadedByUsername: z.string().nullable(),
  createdAt: z.string(),
});

export type ClinicalAttachment = z.infer<typeof clinicalAttachmentSchema>;

export const clinicalAttachmentListSchema = z.object({
  items: z.array(clinicalAttachmentSchema),
  total: z.number().int().min(0),
});

export type ClinicalAttachmentList = z.infer<typeof clinicalAttachmentListSchema>;

export { MAX_FILE_BYTES };

/* ── Catálogo de medicamentos ──────────────────────────────────────────────── */

export const MEDICATION_ROUTES = [
  'oral',
  'sublingual',
  'topica',
  'intramuscular',
  'endovenosa',
  'otra',
] as const;
export type MedicationRoute = (typeof MEDICATION_ROUTES)[number];

export const medicationRouteLabel = (route: MedicationRoute | null): string | null => {
  switch (route) {
    case null:
      return null;
    case 'oral':
      return 'Vía oral';
    case 'sublingual':
      return 'Vía sublingual';
    case 'topica':
      return 'Vía tópica';
    case 'intramuscular':
      return 'Vía intramuscular';
    case 'endovenosa':
      return 'Vía endovenosa';
    default:
      return 'Otra vía';
  }
};

/** Medicamento del catálogo: lo que el récipe autocompleta. */
export const medicationSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  /** Presentaciones y concentraciones («Tabletas 500 mg», «Suspensión 250 mg/5 ml»). */
  presentations: z.array(z.string()),
  /** Vías habituales, en orden de preferencia. */
  routes: z.array(z.enum(MEDICATION_ROUTES)),
  /** Dosis habitual en adultos: es una sugerencia editable, no una imposición. */
  usualDose: z.string().nullable(),
  usualFrequency: z.string().nullable(),
  usualDuration: z.string().nullable(),
  /** Para qué se usa, en una línea («infección odontogénica», «dolor e inflamación»). */
  indications: z.string().nullable(),
  isActive: z.boolean(),
});

export type Medication = z.infer<typeof medicationSchema>;

export const medicationListSchema = z.object({
  items: z.array(medicationSchema),
  total: z.number().int().min(0),
});

export type MedicationList = z.infer<typeof medicationListSchema>;

/* ── Récipes ───────────────────────────────────────────────────────────────── */

/** Una línea del récipe: el medicamento y cómo se toma. */
export const prescriptionItemSchema = z
  .object({
    /** Medicamento del catálogo, si salió de ahí. */
    medicationId: z.uuid().nullable().default(null),
    /** Nombre que se imprime: el del catálogo o el escrito a mano. */
    medicationName: z.string().trim().min(2, 'Escribe el medicamento').max(120),
    /** Presentación y concentración («Tabletas 500 mg»). */
    presentation: optionalText(120),
    route: z.enum(MEDICATION_ROUTES).nullable().default(null),
    dose: z.string().trim().min(1, 'Escribe la dosis').max(80),
    frequency: z.string().trim().min(1, 'Escribe cada cuánto se toma').max(80),
    duration: optionalText(80),
    /** Indicaciones propias de este medicamento. */
    instructions: optionalText(300),
    quantity: optionalText(60),
  })
  .strict();

export type PrescriptionItemInput = z.infer<typeof prescriptionItemSchema>;

export const createPrescriptionSchema = z
  .object({
    /** La sesión que respalda el récipe: es la evolución del día. */
    sessionId: z.uuid(),
    items: z.array(prescriptionItemSchema).min(1, 'Añade al menos un medicamento').max(15),
    /** Indicaciones generales, debajo de la lista. */
    generalInstructions: optionalText(1500),
  })
  .strict();

export type CreatePrescriptionInput = z.infer<typeof createPrescriptionSchema>;

/** Emitir: asigna el número, genera el PDF A5 y deja el código de verificación. */
export const issuePrescriptionSchema = z.object({
  confirm: z.literal(true, { message: 'Confirma la emisión del récipe' }),
});

export type IssuePrescriptionInput = z.infer<typeof issuePrescriptionSchema>;

/** Anular un récipe emitido: nunca se borra, se deja sin efecto con motivo. */
export const annulPrescriptionSchema = z.object({
  reason: z.string().trim().min(3, 'Indica por qué se anula').max(300),
});

export type AnnulPrescriptionInput = z.infer<typeof annulPrescriptionSchema>;

/** Medicamento tal como se guardó en el récipe: el documento lleva su propia copia. */
export const storedPrescriptionItemSchema = prescriptionItemSchema.extend({
  id: z.uuid(),
  position: z.number().int().min(1),
});

export type StoredPrescriptionItem = z.infer<typeof storedPrescriptionItemSchema>;

export const prescriptionStatusSchema = z.enum(PRESCRIPTION_STATUSES);

export const prescriptionSummarySchema = z.object({
  id: z.uuid(),
  /** Número impreso `RX-000001`; `null` mientras es borrador. */
  number: z.string().nullable(),
  prescriptionNumber: z.number().int().min(1).nullable(),
  sessionId: z.uuid(),
  patientId: z.uuid(),
  status: prescriptionStatusSchema,
  issuedAt: z.string().nullable(),
  issuedByUsername: z.string().nullable(),
  itemCount: z.number().int().min(0),
  /** Código del QR de verificación; `null` mientras es borrador. */
  verifyCode: z.string().nullable(),
  /** `true` cuando el PDF A5 ya está archivado. */
  hasPdf: z.boolean(),
  printCount: z.number().int().min(0),
  lastPrintedAt: z.string().nullable(),
  annulledAt: z.string().nullable(),
  annulReason: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type PrescriptionSummary = z.infer<typeof prescriptionSummarySchema>;

export const prescriptionDetailSchema = prescriptionSummarySchema.extend({
  items: z.array(storedPrescriptionItemSchema),
  generalInstructions: z.string().nullable(),
});

export type PrescriptionDetail = z.infer<typeof prescriptionDetailSchema>;

export const prescriptionListSchema = z.object({
  items: z.array(prescriptionSummarySchema),
  total: z.number().int().min(0),
});

export type PrescriptionList = z.infer<typeof prescriptionListSchema>;

/* ── Verificación pública ──────────────────────────────────────────────────── */

/**
 * Lo que responde la página pública `/verificar/<código>`: **confirma que el papel
 * es auténtico y nada más** (ADR 0015). Ni diagnóstico, ni medicamentos, ni cédula:
 * el nombre abreviado —el mismo que usan las pantallas de la sala— sirve para que
 * quien tenga el papel reconozca que es suyo.
 */
export const prescriptionVerificationSchema = z.object({
  valid: z.literal(true),
  code: z.string(),
  clinicName: z.string(),
  /** Fecha de emisión (día, sin hora). */
  issuedAt: z.string(),
  dentistName: z.string().nullable(),
  dentistMpps: z.string().nullable(),
  /** Nombre abreviado del paciente: «María P.». */
  patientReference: z.string(),
  status: prescriptionStatusSchema,
  /** Cuántos medicamentos lleva, sin decir cuáles. */
  itemCount: z.number().int().min(0),
});

export type PrescriptionVerification = z.infer<typeof prescriptionVerificationSchema>;

/** Cuando el código no consta no es un error del cliente: es «este récipe no existe». */
export const prescriptionNotFoundSchema = z.object({
  valid: z.literal(false),
  code: z.string(),
});

export type PrescriptionNotFound = z.infer<typeof prescriptionNotFoundSchema>;

export const prescriptionVerificationResultSchema = z.discriminatedUnion('valid', [
  prescriptionVerificationSchema,
  prescriptionNotFoundSchema,
]);

export type PrescriptionVerificationResult = z.infer<typeof prescriptionVerificationResultSchema>;

/* ── Derivados compartidos ─────────────────────────────────────────────────── */

/** Número visible del récipe: `RX-000001` (se calcula, no se guarda formateado). */
export const formatPrescriptionNumber = (prescriptionNumber: number): string =>
  `RX-${String(prescriptionNumber).padStart(6, '0')}`;

/** Un récipe solo se emite desde borrador; emitido o anulado ya son documentos. */
export const prescriptionIsDraft = (status: string): boolean => status === 'borrador';

export const prescriptionStatusLabel = (status: string): string => {
  switch (status) {
    case 'borrador':
      return 'Borrador';
    case 'emitida':
      return 'Emitida';
    case 'anulada':
      return 'Anulada';
    default:
      return status;
  }
};

/** Pieza a la que se refiere un adjunto, validada como cualquier pieza FDI. */
export const clinicalAttachmentToothSchema = toothNumberSchema.nullable().default(null);
