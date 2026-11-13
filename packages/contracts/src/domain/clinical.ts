import { z } from 'zod';

import { optionalDate, optionalText } from '../common/optional.js';
import { MEDICAL_RECORD_STATUSES } from './enums.js';
import { cleanText } from './patient.js';

/**
 * Historia clínica odontológica (Fase 6, sesión A).
 *
 * La historia se guarda **por secciones** (`docs/formato_historia.md`): cada una
 * es un bloque JSON validado con su propio esquema, de modo que una sección se
 * puede guardar como borrador sin tener el resto completa. Los antecedentes se
 * tipifican en catálogos con casillas y un «otros» inputable, que es lo que
 * permite segmentar en los reportes de la Fase 9.
 *
 * Estados: `borrador` (editable) → `firmada` (inmutable, solo adendas). El
 * consentimiento informado es un registro aparte con su propia aceptación.
 */

/* ── Secciones ─────────────────────────────────────────────────────────────── */

export const CLINICAL_SECTION_KEYS = [
  'identificacion',
  'motivo_consulta',
  'anamnesis',
  'antecedentes_odontologicos',
  'examen_extraoral',
  'examen_intraoral',
  'examenes_complementarios',
  'diagnostico',
  'plan_tratamiento',
  'consentimiento',
  'evolucion',
] as const;
export type ClinicalSectionKey = (typeof CLINICAL_SECTION_KEYS)[number];

export const clinicalSectionKeySchema = z.enum(CLINICAL_SECTION_KEYS);

/**
 * Secciones que el servidor exige para permitir la firma: sin contenido mínimo
 * en todas ellas la historia no se puede firmar.
 */
export const CLINICAL_SIGNATURE_SECTIONS = [
  'motivo_consulta',
  'anamnesis',
  'examen_extraoral',
  'examen_intraoral',
  'diagnostico',
  'plan_tratamiento',
] as const satisfies readonly ClinicalSectionKey[];

/* ── Catálogos tipificados (con «otros» inputable) ─────────────────────────── */

export const ALLERGY_ITEMS = [
  'penicilina',
  'anestesicos_locales',
  'latex',
  'metales',
  'sulfas',
  'aines',
  'yodo',
  'otros',
] as const;

export const PATHOLOGICAL_ITEMS = [
  'diabetes',
  'hipertension',
  'cardiopatia',
  'hepatitis',
  'vih',
  'enfermedad_autoimmune',
  'asma',
  'epilepsia',
  'cancer',
  'hipotiroidismo',
  'otros',
] as const;

export const MEDICATION_ITEMS = [
  'anticoagulantes',
  'bifosfonatos',
  'antihipertensivos',
  'antidepresivos',
  'antidiabeticos',
  'corticoides',
  'anticonvulsivantes',
  'otros',
] as const;

export const SURGERY_ITEMS = [
  'extraccion_dental',
  'cirugia_maxilofacial',
  'amigdalectomia',
  'apendicectomia',
  'cesarea',
  'protesis_articular',
  'otros',
] as const;

export const FAMILY_ITEMS = [
  'diabetes',
  'hipertension',
  'cardiopatia',
  'cancer',
  'enfermedad_mental',
  'malformacion_dental',
  'otros',
] as const;

export const HABIT_ITEMS = [
  'tabaquismo',
  'alcohol',
  'bruxismo',
  'onicofagia',
  'respiracion_bucal',
  'masticacion_unilateral',
  'otros',
] as const;

export const DENTAL_HISTORY_ITEMS = [
  'endodoncia',
  'extraccion',
  'ortodoncia',
  'protesis',
  'implante',
  'restauracion',
  'blanqueamiento',
  'otros',
] as const;

export const STUDY_ITEMS = [
  'radiografia_periapical',
  'radiografia_panoramica',
  'aleta_mordida',
  'modelos_estudio',
  'fotografias_clinicas',
  'analisis_laboratorio',
  'otros',
] as const;

/** Grupos de la anamnesis que la interfaz pinta como casillas con «otros». */
export const ANAMNESIS_CATALOGS = [
  { key: 'alergias', codes: ALLERGY_ITEMS },
  { key: 'patologicos', codes: PATHOLOGICAL_ITEMS },
  { key: 'medicamentos', codes: MEDICATION_ITEMS },
  { key: 'cirugias', codes: SURGERY_ITEMS },
  { key: 'familiares', codes: FAMILY_ITEMS },
  { key: 'habitos', codes: HABIT_ITEMS },
] as const;
export type AnamnesisCatalogKey = (typeof ANAMNESIS_CATALOGS)[number]['key'];

/* ── Enumeraciones de apoyo ────────────────────────────────────────────────── */

export const REGION_EVALUATIONS = ['normal', 'alterado', 'no_evaluado'] as const;
export type RegionEvaluation = (typeof REGION_EVALUATIONS)[number];

export const DENTAL_VISIT_FREQUENCIES = [
  'primera_vez',
  'semestral',
  'anual',
  'cuando_molesta',
  'nunca',
] as const;

export const ORAL_HYGIENE_LEVELS = ['buena', 'regular', 'deficiente'] as const;

/**
 * Relación oclusal de Angle, registrada por separado en el lado **molar** y en el
 * **canino** (v1.2): cada uno es un campo único con `Tipo I`, `Tipo II`, `Tipo III`
 * o `sin_dato`. `sin_dato` significa «no explorado» y **no** cuenta como hallazgo
 * evaluado: elegirlo no da la sección por completa.
 */
export const OCLUSAL_RELATION_STATES = ['tipo_i', 'tipo_ii', 'tipo_iii', 'sin_dato'] as const;
export type OclusalRelation = (typeof OCLUSAL_RELATION_STATES)[number];

export const TREATMENT_PRIORITIES = ['alta', 'media', 'baja'] as const;

export const ORAL_HEALTH_STATES = ['buena', 'regular', 'deficiente', 'sin_dato'] as const;

/* ── Ayudantes de validación ───────────────────────────────────────────────── */

/** Selección de un catálogo tipificado: códigos + texto libre para «otros». */
const catalogSelection = <T extends readonly [string, ...string[]]>(codes: T) =>
  z
    .object({
      items: z.array(z.enum(codes)).max(codes.length).default([]),
      otros: optionalText(200),
    })
    .superRefine((value, ctx) => {
      if (value.items.includes('otros') && value.otros === null) {
        ctx.addIssue({
          code: 'custom',
          path: ['otros'],
          message: 'Especifica cuáles en «otros»',
        });
      }
    });

export type CatalogSelection = { items: string[]; otros: string | null };

/* ── Contenido de cada sección ─────────────────────────────────────────────── */

export const identificationSectionSchema = z.object({
  ocupacion: optionalText(80),
  responsableNombre: optionalText(120),
  responsableParentesco: optionalText(60),
  responsableTelefono: optionalText(30),
  observaciones: optionalText(500),
});

export const motivoConsultaSectionSchema = z.object({
  relato: z
    .string()
    .overwrite(cleanText)
    .pipe(
      z.string().min(10, 'Escribe el motivo de consulta con las palabras del paciente').max(1000),
    ),
  tiempoEvolucion: optionalText(80),
  inicioSintomas: optionalDate,
});

export const anamnesisSectionSchema = z.object({
  /** Marca explícita de «sin antecedentes»: deja la sección completa sin casillas. */
  sinAntecedentes: z.boolean().default(false),
  alergias: catalogSelection(ALLERGY_ITEMS),
  patologicos: catalogSelection(PATHOLOGICAL_ITEMS),
  medicamentos: catalogSelection(MEDICATION_ITEMS),
  cirugias: catalogSelection(SURGERY_ITEMS),
  familiares: catalogSelection(FAMILY_ITEMS),
  habitos: catalogSelection(HABIT_ITEMS),
  observaciones: optionalText(1000),
});

export const dentalHistorySectionSchema = z.object({
  tratamientos: catalogSelection(DENTAL_HISTORY_ITEMS),
  reaccionesAdversas: catalogSelection([
    'anestesia_local',
    'materiales',
    'ninguna',
    'otros',
  ] as const),
  experiencias: catalogSelection(['traumatica', 'ansiedad', 'ninguna', 'otros'] as const),
  frecuenciaVisitas: z.enum(DENTAL_VISIT_FREQUENCIES).nullable().default(null),
  ultimaConsulta: optionalDate,
  higieneCepillado: z
    .enum(['una_vez', 'dos_veces', 'tres_o_mas', 'esporadico'])
    .nullable()
    .default(null),
  usaHiloDental: z.boolean().nullable().default(null),
  tratamientoEnCurso: optionalText(300),
  observaciones: optionalText(1000),
});

export const extraoralExamSectionSchema = z.object({
  tejidosBlandos: z.enum(REGION_EVALUATIONS).nullable().default(null),
  ganglios: z.enum(REGION_EVALUATIONS).nullable().default(null),
  atm: z.enum(REGION_EVALUATIONS).nullable().default(null),
  musculatura: z.enum(REGION_EVALUATIONS).nullable().default(null),
  hallazgos: optionalText(1000),
  observaciones: optionalText(1000),
});

export const intraoralExamSectionSchema = z.object({
  tejidosBlandos: z.enum(REGION_EVALUATIONS).nullable().default(null),
  encias: z.enum(REGION_EVALUATIONS).nullable().default(null),
  sondaje: optionalText(200),
  relacionMolar: z.enum(OCLUSAL_RELATION_STATES).nullable().default(null),
  relacionCanina: z.enum(OCLUSAL_RELATION_STATES).nullable().default(null),
  higiene: z.enum(ORAL_HYGIENE_LEVELS).nullable().default(null),
  hallazgos: optionalText(1000),
  observaciones: optionalText(1000),
});

export const complementaryExamSectionSchema = z.object({
  estudios: catalogSelection(STUDY_ITEMS),
  observaciones: optionalText(1000),
});

/**
 * Un **ítem de diagnóstico** (v1.2): el diagnóstico ya no es un párrafo principal
 * con secundarios sueltos, sino una lista de hallazgos. Cada ítem tiene su
 * descripción obligatoria y unas piezas **opcionales** (texto libre, porque un
 * mismo hallazgo puede afectar a varias: «16, 26»). El `id` es lo que lo ata a su
 * procedimiento del plan de tratamiento.
 *
 * Aquí la descripción sí exige 3 caracteres: es la forma que valida el servidor al
 * **guardar**; mientras se escribe, la interfaz mantiene el borrador y pospone el
 * autoguardado hasta que el ítem es válido.
 */
export const diagnosisItemSchema = z.object({
  id: z.uuid(),
  descripcion: z
    .string()
    .overwrite(cleanText)
    .pipe(z.string().min(3, 'Describe el diagnóstico').max(500)),
  piezas: optionalText(60),
});

export type DiagnosisItem = z.infer<typeof diagnosisItemSchema>;

export const diagnosisSectionSchema = z.object({
  items: z.array(diagnosisItemSchema).max(40).default([]),
  saludBucalGeneral: z.enum(ORAL_HEALTH_STATES).nullable().default(null),
  observaciones: optionalText(1000),
});

export type DiagnosisSection = z.infer<typeof diagnosisSectionSchema>;

/**
 * Un procedimiento del plan de tratamiento.
 *
 * `diagnosticoId` lo une a su ítem de diagnóstico (los ítems **libres** van con
 * `null`). En los enlazados la pieza la manda el diagnóstico —se copia siempre
 * desde `diagnosisItem.piezas`—; el campo se conserva en el plan porque es lo que
 * se imprime junto al procedimiento.
 *
 * La descripción admite vacío **en borrador** (`default('')`): un ítem recién
 * abierto desde un diagnóstico nace por completar y el autoguardado no puede dar
 * 400. La firma exige que todos los procedimientos tengan texto
 * (`clinicalSectionIsComplete`).
 */
export const treatmentPlanProcedureSchema = z.object({
  diagnosticoId: z.uuid().nullable().default(null),
  descripcion: z.string().overwrite(cleanText).pipe(z.string().max(200)).default(''),
  prioridad: z.enum(TREATMENT_PRIORITIES).default('media'),
  pieza: optionalText(60),
  presupuesto: z.coerce.number().min(0).max(1_000_000).nullable().default(null),
});

export type TreatmentPlanProcedure = z.infer<typeof treatmentPlanProcedureSchema>;

export const treatmentPlanSectionSchema = z.object({
  /** 40 vinculados (máximo de diagnósticos) + 40 libres: el tope no corta el vínculo. */
  procedimientos: z.array(treatmentPlanProcedureSchema).max(80).default([]),
  alternativas: optionalText(1000),
  aceptacionPaciente: z.boolean().nullable().default(null),
  observaciones: optionalText(1000),
});

export type TreatmentPlanSection = z.infer<typeof treatmentPlanSectionSchema>;

export const consentSectionSchema = z.object({
  riesgosInformados: optionalText(1500),
  alternativasInformadas: optionalText(1500),
  observaciones: optionalText(1000),
});

/**
 * Evolución clínica (v1.2): el **resumen automático** de las sesiones cerradas se
 * proyecta al leer la historia (`evolutionSessions`) y no se guarda aquí; esta
 * sección solo guarda el **cuadro manual** que el doctor escribe al final.
 */
export const evolutionSectionSchema = z.object({
  observaciones: optionalText(2000),
});

/** Esquema de contenido de cada sección, por clave. */
export const CLINICAL_SECTION_SCHEMAS = {
  identificacion: identificationSectionSchema,
  motivo_consulta: motivoConsultaSectionSchema,
  anamnesis: anamnesisSectionSchema,
  antecedentes_odontologicos: dentalHistorySectionSchema,
  examen_extraoral: extraoralExamSectionSchema,
  examen_intraoral: intraoralExamSectionSchema,
  examenes_complementarios: complementaryExamSectionSchema,
  diagnostico: diagnosisSectionSchema,
  plan_tratamiento: treatmentPlanSectionSchema,
  consentimiento: consentSectionSchema,
  evolucion: evolutionSectionSchema,
} as const satisfies Record<ClinicalSectionKey, z.ZodType>;

/** Valida el contenido de una sección concreta. */
export const clinicalSectionSchemaFor = (key: ClinicalSectionKey): z.ZodType =>
  CLINICAL_SECTION_SCHEMAS[key];

/** Guarda el contenido de una sección (solo en estado `borrador`). */
export const saveClinicalSectionSchema = z.object({
  content: z.record(z.string(), z.unknown()),
});

export type SaveClinicalSectionInput = z.infer<typeof saveClinicalSectionSchema>;

/* ── Firma, adendas y consentimiento ───────────────────────────────────────── */

export const signMedicalRecordSchema = z.object({
  confirm: z.literal(true, { message: 'Confirma la firma de la historia clínica' }),
});

export type SignMedicalRecordInput = z.infer<typeof signMedicalRecordSchema>;

export const createAmendmentSchema = z.object({
  /** Sección a la que se refiere la adenda; `null` = adenda general. */
  sectionKey: clinicalSectionKeySchema.nullable().default(null),
  reason: z
    .string()
    .overwrite(cleanText)
    .pipe(z.string().min(3, 'Indica el motivo de la adenda').max(300)),
  content: z
    .string()
    .overwrite(cleanText)
    .pipe(z.string().min(3, 'Escribe el texto de la adenda').max(2000)),
});

export type CreateAmendmentInput = z.infer<typeof createAmendmentSchema>;

export const acceptConsentSchema = z.object({
  accepted: z.literal(true, { message: 'Registra la aceptación del consentimiento' }),
  acceptedByName: z
    .string()
    .overwrite(cleanText)
    .pipe(z.string().min(3, 'Escribe quién acepta').max(120)),
  acceptedByDocument: optionalText(20),
  relationship: z
    .string()
    .overwrite(cleanText)
    .pipe(z.string().min(3, 'Indica la relación con el paciente').max(60)),
  witnessName: optionalText(120),
  notes: optionalText(500),
});

export type AcceptConsentInput = z.infer<typeof acceptConsentSchema>;

/* ── Salida de la API ──────────────────────────────────────────────────────── */

export const medicalRecordStatusSchema = z.enum(MEDICAL_RECORD_STATUSES);

export const catalogSelectionOutputSchema = z.object({
  items: z.array(z.string()),
  otros: z.string().nullable(),
});

export const clinicalAlertSchema = z.object({
  code: z.string(),
  /** Texto libre cuando la alerta viene del «otros» de un catálogo. */
  detail: z.string().nullable(),
});

export type ClinicalAlert = z.infer<typeof clinicalAlertSchema>;

/**
 * Texto de cada alerta clínica. Vive aquí —y no solo en la interfaz— porque la
 * pantalla del consultorio la pinta desde el **servidor** de pantallas, que no
 * tiene el diccionario de la web; el código es el que manda para segmentar y el
 * texto es el que se lee de reojo antes de entrar al consultorio.
 */
export const CLINICAL_ALERT_LABELS: Readonly<Record<string, string>> = {
  alergia_penicilina: 'Alergia a la penicilina',
  alergia_anestesico: 'Alergia a anestésicos locales',
  alergia_latex: 'Alergia al látex',
  alergia_otro: 'Otra alergia',
  anticoagulante: 'Toma anticoagulantes',
  bifosfonato: 'Toma bifosfonatos',
  diabetes: 'Diabetes',
  hipertension: 'Hipertensión',
  cardiopatia: 'Cardiopatía',
  medicamento_otro: 'Otro medicamento',
  patologico_otro: 'Otro antecedente',
};

/** Texto legible de una alerta: el detalle del «otros» manda si lo hay. */
export const clinicalAlertLabel = (alert: ClinicalAlert): string =>
  alert.detail ?? CLINICAL_ALERT_LABELS[alert.code] ?? alert.code;

/**
 * Severidad de una alerta, de cara al **semáforo de riesgo** de la pantalla del
 * consultorio: lo que obliga a parar va en rojo; lo crónico, en ámbar.
 */
export const clinicalAlertSeverity = (code: string): 'alto' | 'medio' | 'info' => {
  if (code.startsWith('alergia') || code === 'anticoagulante' || code === 'bifosfonato') {
    return 'alto';
  }
  if (code === 'diabetes' || code === 'hipertension' || code === 'cardiopatia') return 'medio';
  return 'info';
};

/** Tipo de dato crítico con el que se pinta la alerta en la pantalla. */
export const clinicalAlertFlagKind = (
  code: string,
): 'alergia' | 'cronico' | 'medicamento' | 'otro' => {
  if (code.startsWith('alergia')) return 'alergia';
  if (code === 'anticoagulante' || code === 'bifosfonato' || code === 'medicamento_otro') {
    return 'medicamento';
  }
  if (code === 'diabetes' || code === 'hipertension' || code === 'cardiopatia') return 'cronico';
  return 'otro';
};

export const clinicalAmendmentSchema = z.object({
  id: z.uuid(),
  sectionKey: clinicalSectionKeySchema.nullable(),
  reason: z.string(),
  content: z.string(),
  authorUsername: z.string().nullable(),
  createdAt: z.string(),
});

export type ClinicalAmendment = z.infer<typeof clinicalAmendmentSchema>;

export const clinicalConsentSchema = z.object({
  accepted: z.boolean(),
  acceptedAt: z.string().nullable(),
  acceptedByName: z.string().nullable(),
  acceptedByDocument: z.string().nullable(),
  relationship: z.string().nullable(),
  witnessName: z.string().nullable(),
  notes: z.string().nullable(),
});

export type ClinicalConsent = z.infer<typeof clinicalConsentSchema>;

export const clinicalPatientSnapshotSchema = z.object({
  id: z.uuid(),
  fullName: z.string(),
  document: z.string(),
  birthDate: z.string(),
  age: z.number().int().min(0),
  sex: z.string(),
  phone: z.string().nullable(),
  address: z.string().nullable(),
  occupation: z.string().nullable(),
});

export type ClinicalPatientSnapshot = z.infer<typeof clinicalPatientSnapshotSchema>;

/**
 * Una sesión clínica **cerrada**, resumida para la evolución de la historia (v1.2).
 *
 * No se guarda en `medical_record_sections`: se **proyecta** al leer el detalle de
 * la historia para que las consultas posteriores a la firma también aparezcan en
 * la evolución (ADR 0034: lo firmado es inmutable, la evolución sigue viva).
 */
export const clinicalEvolutionSessionSummarySchema = z.object({
  id: z.uuid(),
  sessionNumber: z.number().int().positive(),
  /** ISO de la sesión: `closedAt`, que es cuando quedó documentada. */
  fecha: z.string(),
  diagnostico: z.string().nullable(),
  tratamientos: z.array(z.string()),
  observaciones: z.string().nullable(),
});

export type ClinicalEvolutionSessionSummary = z.infer<typeof clinicalEvolutionSessionSummarySchema>;

export const clinicalRecordSummarySchema = z.object({
  id: z.uuid(),
  patientId: z.uuid(),
  status: medicalRecordStatusSchema,
  openedAt: z.string(),
  updatedAt: z.string(),
  signedAt: z.string().nullable(),
  signedByUsername: z.string().nullable(),
  amendmentCount: z.number().int().min(0),
  completedSections: z.array(clinicalSectionKeySchema),
  missingSections: z.array(clinicalSectionKeySchema),
  consentAccepted: z.boolean(),
  alerts: z.array(clinicalAlertSchema),
});

export type ClinicalRecordSummary = z.infer<typeof clinicalRecordSummarySchema>;

export const clinicalRecordDetailSchema = clinicalRecordSummarySchema.extend({
  patient: clinicalPatientSnapshotSchema.nullable(),
  /** Contenido guardado de cada sección (las ausentes no aparecen). */
  sections: z.partialRecord(clinicalSectionKeySchema, z.record(z.string(), z.unknown())),
  amendments: z.array(clinicalAmendmentSchema),
  consent: clinicalConsentSchema.nullable(),
  /**
   * Evolución automática (v1.2): las sesiones cerradas, en orden cronológico, con
   * diagnóstico, tratamientos y observaciones. Es una proyección de
   * `clinical_sessions`, no parte de las secciones guardadas.
   */
  evolutionSessions: z.array(clinicalEvolutionSessionSummarySchema).default([]),
});

export type ClinicalRecordDetail = z.infer<typeof clinicalRecordDetailSchema>;

/**
 * Respuesta de `GET /api/v1/clinical/patients/:id/record`: o la historia existe…
 * o el paciente es «primera visita» y la interfaz muestra el aviso obligatorio.
 */
export const clinicalRecordLookupSchema = z.discriminatedUnion('exists', [
  z.object({ exists: z.literal(true), record: clinicalRecordDetailSchema }),
  z.object({
    exists: z.literal(false),
    patientId: z.uuid(),
    patient: clinicalPatientSnapshotSchema.nullable(),
  }),
]);

export type ClinicalRecordLookup = z.infer<typeof clinicalRecordLookupSchema>;

/** Datos críticos que la historia clínica entrega a la pantalla del consultorio. */
export const clinicalAlertsSchema = z.object({
  patientId: z.uuid(),
  alerts: z.array(clinicalAlertSchema),
  hasRecord: z.boolean(),
});

export type ClinicalAlerts = z.infer<typeof clinicalAlertsSchema>;

/* ── Derivados (compartidos por servidor y web) ────────────────────────────── */

const selectionHasContent = (value: unknown): boolean => {
  if (typeof value !== 'object' || value === null) return false;
  const selection = value as { items?: unknown; otros?: unknown };
  const items = Array.isArray(selection.items) ? selection.items : [];
  const otros = typeof selection.otros === 'string' ? selection.otros.trim() : '';
  return items.length > 0 || otros !== '';
};

const hasText = (value: unknown): boolean => typeof value === 'string' && value.trim().length > 0;

type SectionContent = Record<string, unknown>;

/**
 * ¿El campo de un examen regional tiene un hallazgo? `no_evaluado` (no se miró) y
 * `sin_dato` (no hay dato que registrar) **no** son hallazgos: elegir la opción del
 * selector no da la sección por completa.
 */
const isEvaluated = (value: unknown): boolean =>
  typeof value === 'string' && value !== 'no_evaluado' && value !== 'sin_dato';

/** ¿El texto tiene la sustancia mínima que exigen los esquemas de diagnóstico y plan? */
const hasMinimumText = (value: unknown): boolean =>
  typeof value === 'string' && value.trim().length >= 3;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const diagnosisItemsOf = (
  content: Record<string, unknown> | undefined,
): Record<string, unknown>[] => {
  const items = content?.['items'];
  return Array.isArray(items) ? items.filter(isRecord) : [];
};

const planProceduresOf = (
  content: Record<string, unknown> | undefined,
): Record<string, unknown>[] => {
  const procedimientos = content?.['procedimientos'];
  return Array.isArray(procedimientos) ? procedimientos.filter(isRecord) : [];
};

const diagnosisItemIsComplete = (item: Record<string, unknown>): boolean =>
  hasMinimumText(item['descripcion']);

const planProcedureIsComplete = (procedure: Record<string, unknown>): boolean =>
  hasMinimumText(procedure['descripcion']);

/**
 * ¿La sección tiene contenido suficiente? Es la misma regla que aplica el
 * servidor para bloquear la firma, y la que la interfaz usa para marcar los
 * pasos completados del formulario.
 */
export const clinicalSectionIsComplete = (
  key: ClinicalSectionKey,
  content: SectionContent | undefined,
): boolean => {
  if (content === undefined || content === null) return false;

  switch (key) {
    case 'identificacion':
      // La identificación se toma del paciente; la sección siempre está "lista".
      return true;
    case 'motivo_consulta':
      return hasText(content['relato']);
    case 'anamnesis': {
      if (content['sinAntecedentes'] === true) return true;
      if (ANAMNESIS_CATALOGS.some((group) => selectionHasContent(content[group.key]))) return true;
      return hasText(content['observaciones']);
    }
    case 'antecedentes_odontologicos':
      return (
        selectionHasContent(content['tratamientos']) ||
        selectionHasContent(content['reaccionesAdversas']) ||
        selectionHasContent(content['experiencias']) ||
        hasText(content['tratamientoEnCurso']) ||
        hasText(content['observaciones'])
      );
    case 'examen_extraoral':
      return (
        ['tejidosBlandos', 'ganglios', 'atm', 'musculatura'].some((field) =>
          isEvaluated(content[field]),
        ) ||
        hasText(content['hallazgos']) ||
        hasText(content['observaciones'])
      );
    case 'examen_intraoral':
      return (
        ['tejidosBlandos', 'encias'].some((field) => isEvaluated(content[field])) ||
        isEvaluated(content['relacionMolar']) ||
        isEvaluated(content['relacionCanina']) ||
        isEvaluated(content['higiene']) ||
        hasText(content['sondaje']) ||
        hasText(content['hallazgos']) ||
        hasText(content['observaciones'])
      );
    case 'examenes_complementarios':
      return selectionHasContent(content['estudios']) || hasText(content['observaciones']);
    case 'diagnostico':
      // Un diagnóstico es una lista de hallazgos: sin ítems (o con alguno sin
      // describir) la sección no está lista para firmar.
      return (
        Array.isArray(content['items']) &&
        content['items'].length > 0 &&
        content['items'].every((item) => isRecord(item) && diagnosisItemIsComplete(item))
      );
    case 'plan_tratamiento': {
      // Los procedimientos vinculados nacen vacíos a propósito (se completan aquí),
      // así que la sección no está completa hasta que **todos** tengan descripción.
      const procedimientos = content['procedimientos'];
      return (
        Array.isArray(procedimientos) &&
        procedimientos.length > 0 &&
        procedimientos.every(
          (procedure) => isRecord(procedure) && planProcedureIsComplete(procedure),
        )
      );
    }
    case 'consentimiento':
      return hasText(content['riesgosInformados']) || hasText(content['alternativasInformadas']);
    case 'evolucion':
      // Solo el cuadro manual: el resumen de sesiones se proyecta al leer.
      return hasText(content['observaciones']);
    default:
      return false;
  }
};

const isTreatmentPriority = (value: unknown): value is (typeof TREATMENT_PRIORITIES)[number] =>
  typeof value === 'string' && (TREATMENT_PRIORITIES as readonly string[]).includes(value);

const procedureDescriptionOf = (value: unknown): string => (typeof value === 'string' ? value : '');

const procedureBudgetOf = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const procedurePieceOf = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value : null;

/**
 * Sincroniza el **plan de tratamiento** con los ítems del diagnóstico (v1.2).
 *
 * Es una función **pura** y la usan los dos lados para que la pantalla y el
 * servidor no se separen nunca:
 *  - Los diagnósticos son la fuente de verdad de la lista: cada ítem abre (y
 *    conserva) **un** procedimiento enlazado, en el mismo orden.
 *  - Del procedimiento enlazado se respeta lo que el doctor ya escribió
 *    (`descripcion`, `prioridad`, `presupuesto`); la **pieza** siempre se copia
 *    del diagnóstico, que es quien la manda.
 *  - Los ítems nuevos nacen **por completar**: descripción vacía, prioridad media.
 *  - Los enlaces huérfanos (diagnóstico borrado) se eliminan; los procedimientos
 *    libres (`diagnosticoId: null`) se preservan intactos al final de la lista.
 *
 * Acepta borradores sin validar (`Record<string, unknown>`) porque la interfaz la
 * aplica mientras el médico escribe; el servidor valida después el resultado con
 * `treatmentPlanSectionSchema`.
 */
export const syncPlanWithDiagnosis = (
  diagnosis: Record<string, unknown> | undefined,
  plan: Record<string, unknown> | undefined,
): Record<string, unknown> => {
  const items = diagnosisItemsOf(diagnosis);
  const previousProcedures = planProceduresOf(plan);

  const previousLinked = new Map<string, Record<string, unknown>>();
  const previousFree: Record<string, unknown>[] = [];
  for (const procedure of previousProcedures) {
    const diagnosticoId = procedure['diagnosticoId'];
    if (typeof diagnosticoId === 'string' && diagnosticoId !== '') {
      // Dos filas con el mismo enlace no deberían existir; se conserva la primera.
      if (!previousLinked.has(diagnosticoId)) previousLinked.set(diagnosticoId, procedure);
    } else {
      previousFree.push(procedure);
    }
  }

  const linkedProcedures: Record<string, unknown>[] = [];
  for (const item of items) {
    const id = item['id'];
    if (typeof id !== 'string' || id === '') continue;
    const previous = previousLinked.get(id);
    linkedProcedures.push({
      diagnosticoId: id,
      descripcion: procedureDescriptionOf(previous?.['descripcion']),
      prioridad: isTreatmentPriority(previous?.['prioridad']) ? previous['prioridad'] : 'media',
      // La pieza la manda el diagnóstico: el plan no la edita por su cuenta.
      pieza: procedurePieceOf(item['piezas']),
      presupuesto: procedureBudgetOf(previous?.['presupuesto']),
    });
  }

  const freeProcedures = previousFree.map((procedure) => ({
    diagnosticoId: null,
    descripcion: procedureDescriptionOf(procedure['descripcion']),
    prioridad: isTreatmentPriority(procedure['prioridad']) ? procedure['prioridad'] : 'media',
    pieza: procedurePieceOf(procedure['pieza']),
    presupuesto: procedureBudgetOf(procedure['presupuesto']),
  }));

  return { ...(plan ?? {}), procedimientos: [...linkedProcedures, ...freeProcedures] };
};

/**
 * ¿Cada ítem de diagnóstico tiene su procedimiento del plan **con texto**?
 *
 * La sincronización los crea, pero el servidor no se fía: una petición fuera de
 * orden o un borrador antiguo podrían dejar un diagnóstico sin tratamiento.
 */
const planCoversDiagnosis = (
  sections: Partial<Record<ClinicalSectionKey, SectionContent | undefined>>,
): boolean => {
  const diagnosis = sections['diagnostico'];
  if (diagnosis === undefined || diagnosis === null) return true;
  const procedures = planProceduresOf(sections['plan_tratamiento']);
  return diagnosisItemsOf(diagnosis).every((item) => {
    // Un ítem todavía incompleto lo reporta la propia sección `diagnostico`.
    if (!diagnosisItemIsComplete(item)) return true;
    const id = item['id'];
    if (typeof id !== 'string' || id === '') return false;
    return procedures.some(
      (procedure) => procedure['diagnosticoId'] === id && planProcedureIsComplete(procedure),
    );
  });
};

/** Secciones obligatorias que todavía no están completas. */
export const missingSignatureSections = (
  sections: Partial<Record<ClinicalSectionKey, SectionContent | undefined>>,
): ClinicalSectionKey[] => {
  const missing: ClinicalSectionKey[] = CLINICAL_SIGNATURE_SECTIONS.filter(
    (key) => !clinicalSectionIsComplete(key, sections[key]),
  );
  // El plan puede estar «completo» con sus ítems libres y, aun así, un diagnóstico
  // enlazado seguir sin tratamiento: eso también bloquea la firma.
  if (!missing.includes('plan_tratamiento') && !planCoversDiagnosis(sections)) {
    missing.push('plan_tratamiento');
  }
  return missing;
};

/** Secciones con contenido (para el resumen de la historia). */
export const completedClinicalSections = (
  sections: Partial<Record<ClinicalSectionKey, SectionContent | undefined>>,
): ClinicalSectionKey[] =>
  CLINICAL_SECTION_KEYS.filter((key) => clinicalSectionIsComplete(key, sections[key]));

const selectionItems = (value: unknown): string[] => {
  if (typeof value !== 'object' || value === null) return [];
  const items = (value as { items?: unknown }).items;
  return Array.isArray(items)
    ? items.filter((item): item is string => typeof item === 'string')
    : [];
};

const selectionOther = (value: unknown): string | null => {
  if (typeof value !== 'object' || value === null) return null;
  const otros = (value as { otros?: unknown }).otros;
  return typeof otros === 'string' && otros.trim() !== '' ? otros.trim() : null;
};

/**
 * Alertas clínicas derivadas de la anamnesis. El servidor las publica y la
 * interfaz las resalta (la alergia a penicilina, por ejemplo, va en rojo).
 */
export const clinicalAlerts = (
  sections: Partial<Record<ClinicalSectionKey, SectionContent | undefined>>,
): ClinicalAlert[] => {
  const anamnesis = sections['anamnesis'];
  if (anamnesis === undefined || anamnesis === null) return [];

  const alerts: ClinicalAlert[] = [];
  const alergias = selectionItems(anamnesis['alergias']);
  const patologicos = selectionItems(anamnesis['patologicos']);
  const medicamentos = selectionItems(anamnesis['medicamentos']);

  if (alergias.includes('penicilina')) alerts.push({ code: 'alergia_penicilina', detail: null });
  if (alergias.includes('anestesicos_locales')) {
    alerts.push({ code: 'alergia_anestesico', detail: null });
  }
  if (alergias.includes('latex')) alerts.push({ code: 'alergia_latex', detail: null });
  if (medicamentos.includes('anticoagulantes'))
    alerts.push({ code: 'anticoagulante', detail: null });
  if (medicamentos.includes('bifosfonatos')) alerts.push({ code: 'bifosfonato', detail: null });
  if (patologicos.includes('diabetes')) alerts.push({ code: 'diabetes', detail: null });
  if (patologicos.includes('hipertension')) alerts.push({ code: 'hipertension', detail: null });
  if (patologicos.includes('cardiopatia')) alerts.push({ code: 'cardiopatia', detail: null });

  const alergiasOtros = selectionOther(anamnesis['alergias']);
  if (alergias.includes('otros') && alergiasOtros !== null) {
    alerts.push({ code: 'alergia_otro', detail: alergiasOtros });
  }
  const medicamentosOtros = selectionOther(anamnesis['medicamentos']);
  if (medicamentos.includes('otros') && medicamentosOtros !== null) {
    alerts.push({ code: 'medicamento_otro', detail: medicamentosOtros });
  }
  const patologicosOtros = selectionOther(anamnesis['patologicos']);
  if (patologicos.includes('otros') && patologicosOtros !== null) {
    alerts.push({ code: 'patologico_otro', detail: patologicosOtros });
  }

  return alerts;
};

/** `true` si la historia registra alergia a la penicilina (validación clínica). */
export const hasPenicillinAllergy = (
  sections: Partial<Record<ClinicalSectionKey, SectionContent | undefined>>,
): boolean => clinicalAlerts(sections).some((alert) => alert.code === 'alergia_penicilina');
