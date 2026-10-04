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

export const OCCLUSION_STATES = [
  'normal',
  'apinamiento',
  'mordida_abierta',
  'mordida_cruzada',
  'sobremordida',
  'sin_dato',
] as const;

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
  oclusion: z.enum(OCCLUSION_STATES).nullable().default(null),
  higiene: z.enum(ORAL_HYGIENE_LEVELS).nullable().default(null),
  hallazgos: optionalText(1000),
  observaciones: optionalText(1000),
});

export const complementaryExamSectionSchema = z.object({
  estudios: catalogSelection(STUDY_ITEMS),
  observaciones: optionalText(1000),
});

export const diagnosisSectionSchema = z.object({
  principal: z
    .string()
    .overwrite(cleanText)
    .pipe(z.string().min(3, 'Escribe el diagnóstico principal').max(500)),
  secundarios: optionalText(1000),
  porPieza: optionalText(1000),
  saludBucalGeneral: z.enum(ORAL_HEALTH_STATES).nullable().default(null),
  observaciones: optionalText(1000),
});

export const treatmentPlanSectionSchema = z.object({
  procedimientos: z
    .array(
      z.object({
        descripcion: z
          .string()
          .overwrite(cleanText)
          .pipe(z.string().min(3, 'Describe el procedimiento').max(200)),
        prioridad: z.enum(TREATMENT_PRIORITIES).default('media'),
        pieza: optionalText(12),
        presupuesto: z.coerce.number().min(0).max(1_000_000).nullable().default(null),
      }),
    )
    .max(40)
    .default([]),
  alternativas: optionalText(1000),
  aceptacionPaciente: z.boolean().nullable().default(null),
  observaciones: optionalText(1000),
});

export const consentSectionSchema = z.object({
  riesgosInformados: optionalText(1500),
  alternativasInformadas: optionalText(1500),
  observaciones: optionalText(1000),
});

export const evolutionSectionSchema = z.object({
  resumen: optionalText(2000),
  observaciones: optionalText(1000),
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

const isEvaluated = (value: unknown): boolean =>
  typeof value === 'string' && value !== 'no_evaluado';

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
        isEvaluated(content['oclusion']) ||
        isEvaluated(content['higiene']) ||
        hasText(content['sondaje']) ||
        hasText(content['hallazgos']) ||
        hasText(content['observaciones'])
      );
    case 'examenes_complementarios':
      return selectionHasContent(content['estudios']) || hasText(content['observaciones']);
    case 'diagnostico':
      return hasText(content['principal']);
    case 'plan_tratamiento': {
      const procedimientos = content['procedimientos'];
      return Array.isArray(procedimientos) && procedimientos.length > 0;
    }
    case 'consentimiento':
      return hasText(content['riesgosInformados']) || hasText(content['alternativasInformadas']);
    case 'evolucion':
      return hasText(content['resumen']) || hasText(content['observaciones']);
    default:
      return false;
  }
};

/** Secciones obligatorias que todavía no están completas. */
export const missingSignatureSections = (
  sections: Partial<Record<ClinicalSectionKey, SectionContent | undefined>>,
): ClinicalSectionKey[] =>
  CLINICAL_SIGNATURE_SECTIONS.filter((key) => !clinicalSectionIsComplete(key, sections[key]));

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
