import { z } from 'zod';

import { optionalDate, optionalNumber, optionalText } from '../common/optional.js';
import { OCCLUSION_STATES, ORAL_HYGIENE_LEVELS, REGION_EVALUATIONS } from './clinical.js';
import { CLINICAL_SESSION_STATUSES } from './enums.js';
import {
  surfaceLabelFor,
  toothNumberSchema,
  toothSurfaceSchema,
  type ToothSurface,
} from './odontogram.js';
import { cleanText } from './patient.js';

/**
 * Sesión clínica (Fase 7, sesión A): la **evolución** de §11 de
 * `docs/formato_historia.md`.
 *
 * La historia clínica se llena una vez y se firma; la evolución es lo que se
 * escribe **en cada visita**: signos vitales, examen del día, procedimientos
 * realizados (con pieza y caras), materiales, diagnóstico de la sesión,
 * indicaciones y la próxima cita. Nace en `borrador` (se autoguarda mientras el
 * paciente está sentado) y pasa a `cerrada`, que es **inmutable**: una corrección
 * no reescribe lo que se hizo, abre una sesión enmendada (`amendedFromId`).
 *
 * La sesión cuelga de la **historia** (que puede estar firmada: firmar la historia
 * no cierra la vida del paciente) y, si el paciente está en el consultorio, de la
 * **cita** (`appointmentId`), que es lo que habilita el «atendido» sin motivo.
 */

/* ── Catálogo de procedimientos ────────────────────────────────────────────── */

/**
 * Procedimientos que se pueden registrar en una sesión. Es un catálogo
 * **cerrado con «otros» inputable**, igual que los antecedentes de la historia:
 * es lo que permite contar procedimientos en los reportes de la Fase 9 (y
 * enganchar cada fase del implante a su partida, ADR 0032).
 */
export const SESSION_PROCEDURES = [
  { code: 'consulta_evaluacion', label: 'Consulta y evaluación' },
  { code: 'control_postoperatorio', label: 'Control postoperatorio' },
  { code: 'profilaxis', label: 'Profilaxis (limpieza)' },
  { code: 'detartraje', label: 'Detartraje y alisado radicular' },
  { code: 'aplicacion_fluor', label: 'Aplicación de flúor' },
  { code: 'sellante', label: 'Sellante de fosas y fisuras' },
  { code: 'obturacion_resina', label: 'Obturación con resina compuesta' },
  { code: 'obturacion_amalgama', label: 'Obturación con amalgama' },
  { code: 'obturacion_ionomero', label: 'Obturación con ionómero de vidrio' },
  { code: 'reconstruccion', label: 'Reconstrucción coronaria' },
  { code: 'endodoncia_unirradicular', label: 'Endodoncia unirradicular' },
  { code: 'endodoncia_birradicular', label: 'Endodoncia birradicular' },
  { code: 'endodoncia_multirradicular', label: 'Endodoncia multirradicular' },
  { code: 'retratamiento_endodontico', label: 'Retratamiento endodóntico' },
  { code: 'extraccion_simple', label: 'Extracción simple' },
  { code: 'extraccion_quirurgica', label: 'Extracción quirúrgica' },
  { code: 'corona_metal_porcelana', label: 'Corona metal-porcelana' },
  { code: 'corona_zirconia', label: 'Corona de zirconia' },
  { code: 'corona_temporal', label: 'Corona temporal' },
  { code: 'implante_quirurgico', label: 'Implante: fase quirúrgica' },
  { code: 'carga_implante', label: 'Implante: carga de la corona' },
  { code: 'protesis_fija', label: 'Prótesis fija' },
  { code: 'protesis_removible', label: 'Prótesis removible' },
  { code: 'blanqueamiento', label: 'Blanqueamiento dental' },
  { code: 'cementado', label: 'Cementado de restauración' },
  { code: 'retiro_sutura', label: 'Retiro de sutura' },
  { code: 'radiografia', label: 'Toma de radiografía' },
  { code: 'otros', label: 'Otro procedimiento' },
] as const;

export const SESSION_PROCEDURE_CODES = SESSION_PROCEDURES.map(
  (procedure) => procedure.code,
) as unknown as readonly [SessionProcedureCode, ...SessionProcedureCode[]];

export type SessionProcedureCode = (typeof SESSION_PROCEDURES)[number]['code'];

const PROCEDURE_LABELS: ReadonlyMap<string, string> = new Map(
  SESSION_PROCEDURES.map((item) => [item.code as string, item.label as string]),
);

/** Texto del procedimiento: el «otros» manda cuando el código es `otros`. */
export const procedureLabel = (code: string): string => PROCEDURE_LABELS.get(code) ?? code;

/* ── Catálogo de materiales ────────────────────────────────────────────────── */

/** Materiales e insumos usados en la sesión (también cerrado, con «otros»). */
export const SESSION_MATERIALS = [
  { code: 'anestesia_lidocaina', label: 'Lidocaína 2 % con epinefrina' },
  { code: 'anestesia_mepivacaina', label: 'Mepivacaína 3 %' },
  { code: 'anestesia_articaina', label: 'Articaína 4 %' },
  { code: 'resina_compuesta', label: 'Resina compuesta' },
  { code: 'amalgama', label: 'Amalgama de plata' },
  { code: 'ionomero_vidrio', label: 'Ionómero de vidrio' },
  { code: 'hidroxido_calcio', label: 'Hidróxido de calcio' },
  { code: 'cemento_temporal', label: 'Cemento de obturación temporal' },
  { code: 'gutapercha', label: 'Gutapercha' },
  { code: 'cemento_endodontico', label: 'Cemento endodóntico' },
  { code: 'sutura_seda', label: 'Sutura de seda' },
  { code: 'alginato', label: 'Alginato' },
  { code: 'yeso_piedra', label: 'Yeso piedra' },
  { code: 'fluor_gel', label: 'Flúor en gel' },
  { code: 'sellante_resina', label: 'Sellante de resina' },
  { code: 'otros', label: 'Otro material' },
] as const;

export const SESSION_MATERIAL_CODES = SESSION_MATERIALS.map(
  (material) => material.code,
) as unknown as readonly [SessionMaterialCode, ...SessionMaterialCode[]];

export type SessionMaterialCode = (typeof SESSION_MATERIALS)[number]['code'];

const MATERIAL_LABELS: ReadonlyMap<string, string> = new Map(
  SESSION_MATERIALS.map((item) => [item.code as string, item.label as string]),
);

export const materialLabel = (code: string): string => MATERIAL_LABELS.get(code) ?? code;

/* ── Signos vitales ────────────────────────────────────────────────────────── */

/**
 * Rangos admitidos de los signos vitales. Están aquí (y no en la interfaz) porque
 * el servidor no se fía de lo que llega: un peso de 900 kg o una SpO₂ de 150 son
 * errores de tecleo, y un signo vital inventado es peor que un signo vital vacío.
 */
export const VITAL_RANGES = {
  taSistolica: { min: 50, max: 300, decimals: 0, label: 'La tensión sistólica' },
  taDiastolica: { min: 30, max: 200, decimals: 0, label: 'La tensión diastólica' },
  fc: { min: 20, max: 250, decimals: 0, label: 'La frecuencia cardíaca' },
  temperatura: { min: 30, max: 45, decimals: 1, label: 'La temperatura' },
  spo2: { min: 50, max: 100, decimals: 0, label: 'La saturación de oxígeno' },
  peso: { min: 1, max: 400, decimals: 1, label: 'El peso' },
} as const;

export const clinicalSessionVitalsSchema = z
  .object({
    /** Tensión arterial en mmHg: se guardan los dos números por separado. */
    taSistolica: optionalNumber(VITAL_RANGES.taSistolica),
    taDiastolica: optionalNumber(VITAL_RANGES.taDiastolica),
    /** Frecuencia cardíaca en latidos por minuto. */
    fc: optionalNumber(VITAL_RANGES.fc),
    /** Temperatura en °C. */
    temperatura: optionalNumber(VITAL_RANGES.temperatura),
    /** Saturación de oxígeno en %. */
    spo2: optionalNumber(VITAL_RANGES.spo2),
    /** Peso en kg. */
    peso: optionalNumber(VITAL_RANGES.peso),
  })
  .superRefine((value, ctx) => {
    const sistolica = value.taSistolica;
    const diastolica = value.taDiastolica;
    if (sistolica !== null && diastolica !== null && sistolica <= diastolica) {
      ctx.addIssue({
        code: 'custom',
        path: ['taSistolica'],
        message: 'La tensión sistólica tiene que ser mayor que la diastólica',
      });
    }
  });

export type ClinicalSessionVitals = z.infer<typeof clinicalSessionVitalsSchema>;

/** Signos vitales «sin tomar»: es lo normal en una consulta de rutina. */
export const emptySessionVitals = (): ClinicalSessionVitals => ({
  taSistolica: null,
  taDiastolica: null,
  fc: null,
  temperatura: null,
  spo2: null,
  peso: null,
});

/* ── Examen del día ────────────────────────────────────────────────────────── */

/** Examen intraoral y periodontal de la sesión (lo que cambia de una visita a otra). */
export const clinicalSessionExamSchema = z.object({
  tejidosBlandos: z.enum(REGION_EVALUATIONS).nullable().default(null),
  encias: z.enum(REGION_EVALUATIONS).nullable().default(null),
  /** Profundidad de sondaje por pieza, en texto libre («16: 3 mm, 26: 5 mm»). */
  sondaje: optionalText(300),
  oclusion: z.enum(OCCLUSION_STATES).nullable().default(null),
  higiene: z.enum(ORAL_HYGIENE_LEVELS).nullable().default(null),
  hallazgos: optionalText(2000),
});

export type ClinicalSessionExam = z.infer<typeof clinicalSessionExamSchema>;

export const emptySessionExam = (): ClinicalSessionExam => ({
  tejidosBlandos: null,
  encias: null,
  sondaje: null,
  oclusion: null,
  higiene: null,
  hallazgos: null,
});

/* ── Procedimientos y materiales ───────────────────────────────────────────── */

export const sessionProcedureSchema = z
  .object({
    code: z.enum(SESSION_PROCEDURE_CODES),
    /** Obligatorio cuando el código es `otros`. */
    detalle: optionalText(200),
    toothNumber: toothNumberSchema.nullable().default(null),
    /** Caras tratadas; la pieza puede ir sin caras (una extracción, por ejemplo). */
    surfaces: z.array(toothSurfaceSchema).max(5).default([]),
    notas: optionalText(300),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.code === 'otros' && (value.detalle === null || value.detalle.trim().length < 3)) {
      ctx.addIssue({
        code: 'custom',
        path: ['detalle'],
        message: 'Describe el procedimiento en «otro procedimiento»',
      });
    }
    if (value.toothNumber === null && value.surfaces.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['toothNumber'],
        message: 'Indica la pieza a la que pertenecen las caras',
      });
    }
  });

export type SessionProcedure = z.infer<typeof sessionProcedureSchema>;

/**
 * Un procedimiento tal como viaja en el bloque `session` de `clinical.session.closed`
 * ([ADR 0041](../../../docs/adr/0041-el-evento-lleva-lo-que-el-consumidor-necesita.md)).
 *
 * El borrador de factura necesita **código, detalle, pieza y caras**: con `procedureCodes` a secas no
 * puede describir la partida («Obturación con resina compuesta · pieza 26 (oclusal)»), y el detalle es
 * imprescindible cuando el código es `otros`. Es **aditivo**: lo que ya viajaba sigue viajando y los
 * consumidores actuales ignoran lo que no conocen.
 */
export interface SessionProcedureBlock {
  code: SessionProcedureCode;
  /** Detalle escrito a mano: el que hace falta cuando el código es `otros`. */
  detail: string | null;
  toothNumber: number | null;
  surfaces: readonly ToothSurface[];
}

/** El bloque `session.procedures[]` del evento, a partir del contenido de la sesión. */
export const sessionProcedureBlocks = (
  procedimientos: readonly SessionProcedure[],
): SessionProcedureBlock[] =>
  procedimientos.map((procedimiento) => ({
    code: procedimiento.code,
    detail: procedimiento.detalle,
    toothNumber: procedimiento.toothNumber,
    surfaces: procedimiento.surfaces,
  }));

export const sessionMaterialSchema = z
  .object({
    code: z.enum(SESSION_MATERIAL_CODES),
    detalle: optionalText(200),
    /** «2 cartuchos», «1 tubo»: es texto porque las unidades se cuentan así. */
    cantidad: optionalText(60),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.code === 'otros' && (value.detalle === null || value.detalle.trim().length < 3)) {
      ctx.addIssue({
        code: 'custom',
        path: ['detalle'],
        message: 'Describe el material en «otro material»',
      });
    }
  });

export type SessionMaterial = z.infer<typeof sessionMaterialSchema>;

/* ── Contenido de la sesión (el documento que se autoguarda) ───────────────── */

export const clinicalSessionContentSchema = z
  .object({
    /** Motivo de la visita de hoy (no el de la primera consulta). */
    motivo: optionalText(500),
    /** Anamnesis breve y cambios relevantes desde la última sesión. */
    anamnesis: optionalText(2000),
    vitals: clinicalSessionVitalsSchema.default(emptySessionVitals()),
    exam: clinicalSessionExamSchema.default(emptySessionExam()),
    procedimientos: z.array(sessionProcedureSchema).max(40).default([]),
    materiales: z.array(sessionMaterialSchema).max(40).default([]),
    /** Diagnóstico de la sesión. */
    diagnostico: optionalText(1000),
    /** Indicaciones postoperatorias que se le dan al paciente. */
    indicaciones: optionalText(2000),
    /** Próxima cita sugerida: fecha y nota («control de endodoncia»). */
    proximaCitaFecha: optionalDate,
    proximaCitaNota: optionalText(300),
    /** Notas internas: no se imprimen para el paciente. */
    notasInternas: optionalText(2000),
  })
  .strict();

export type ClinicalSessionContent = z.infer<typeof clinicalSessionContentSchema>;

/**
 * Sesión recién abierta, con la forma exacta del contrato.
 *
 * Se construye a mano —y una prueba comprueba que sigue siendo válida y estable—
 * porque lo usan la interfaz (como estado inicial del formulario) y el servidor
 * (para comparar y detectar «sin cambios»).
 */
export const emptyClinicalSessionContent = (): ClinicalSessionContent => ({
  motivo: null,
  anamnesis: null,
  vitals: emptySessionVitals(),
  exam: emptySessionExam(),
  procedimientos: [],
  materiales: [],
  diagnostico: null,
  indicaciones: null,
  proximaCitaFecha: null,
  proximaCitaNota: null,
  notasInternas: null,
});

const hasText = (value: string | null): boolean => value !== null && value.trim().length > 0;

/** ¿Hay algo escrito en la sesión? Una sesión vacía se puede descartar sin ruido. */
export const clinicalSessionHasContent = (content: ClinicalSessionContent): boolean =>
  hasText(content.motivo) ||
  hasText(content.anamnesis) ||
  hasText(content.diagnostico) ||
  hasText(content.indicaciones) ||
  hasText(content.notasInternas) ||
  hasText(content.proximaCitaNota) ||
  content.proximaCitaFecha !== null ||
  content.procedimientos.length > 0 ||
  content.materiales.length > 0 ||
  Object.values(content.vitals).some((value) => value !== null) ||
  Object.values(content.exam).some((value) => value !== null && value !== '');

/**
 * ¿Se puede cerrar? Una sesión sin motivo, sin procedimientos y sin diagnóstico
 * no documenta nada: cerrarla dejaría un hueco en la evolución del paciente.
 */
export const clinicalSessionCanClose = (content: ClinicalSessionContent): boolean =>
  hasText(content.motivo) || content.procedimientos.length > 0 || hasText(content.diagnostico);

/** Texto de un procedimiento: «Obturación con resina compuesta · 26 (oclusal)». */
export const sessionProcedureText = (procedure: SessionProcedure): string => {
  const nombre =
    procedure.code === 'otros' ? (procedure.detalle ?? 'Otro') : procedureLabel(procedure.code);
  if (procedure.toothNumber === null) return nombre;
  const caras = (procedure.surfaces as readonly ToothSurface[]).map((surface) =>
    surfaceLabelFor(procedure.toothNumber as number, surface),
  );
  return caras.length === 0
    ? `${nombre} · pieza ${String(procedure.toothNumber)}`
    : `${nombre} · pieza ${String(procedure.toothNumber)} (${caras.join(', ')})`;
};

/** Texto de un material: «Resina compuesta (2 cartuchos)». */
export const sessionMaterialText = (material: SessionMaterial): string => {
  const nombre =
    material.code === 'otros' ? (material.detalle ?? 'Otro') : materialLabel(material.code);
  return material.cantidad === null ? nombre : `${nombre} (${material.cantidad})`;
};

/**
 * Resumen legible de la sesión, para la auditoría y las listas:
 * «Sesión con 3 procedimientos: Profilaxis (limpieza); Obturación…». Nunca
 * inventa: si no hay procedimientos lo dice.
 */
export const clinicalSessionSummaryText = (content: ClinicalSessionContent): string => {
  const total = content.procedimientos.length;
  if (total === 0) {
    return hasText(content.motivo) ? `Consulta: ${content.motivo}` : 'Consulta sin procedimientos';
  }
  const primeros = content.procedimientos.slice(0, 2).map(sessionProcedureText).join('; ');
  return total <= 2
    ? `Sesión: ${primeros}`
    : `Sesión con ${String(total)} procedimientos: ${primeros}…`;
};

/** Número visible de la sesión: `S-000012` (se calcula, no se guarda formateado). */
export const formatSessionNumber = (sessionNumber: number): string =>
  `S-${String(sessionNumber).padStart(6, '0')}`;

/* ── Entradas de la API ────────────────────────────────────────────────────── */

export const createClinicalSessionSchema = z.object({
  /** Cita en curso: es lo que después habilita el «atendido» sin motivo. */
  appointmentId: z.uuid().nullable().default(null),
  /** Motivo de la visita, para no abrir la sesión en blanco. */
  motivo: optionalText(500),
});

export type CreateClinicalSessionInput = z.infer<typeof createClinicalSessionSchema>;

/**
 * Autoguardado: llega el documento **completo** tal como lo tiene el formulario.
 *
 * `.required()` no es un capricho: si un cliente mandara solo el campo que tocó,
 * los `default` del esquema rellenarían el resto y el autoguardado **borraría** en
 * silencio los procedimientos que ya estaban. Con el documento entero, lo que
 * falta es un error, no una pérdida.
 */
export const saveClinicalSessionSchema = z.object({
  content: clinicalSessionContentSchema.required(),
});

export type SaveClinicalSessionInput = z.infer<typeof saveClinicalSessionSchema>;

export const closeClinicalSessionSchema = z.object({
  confirm: z.literal(true, { message: 'Confirma el cierre de la sesión' }),
  /** Nota de cierre: qué quedó pendiente, cómo salió el paciente. */
  closureNote: optionalText(1000),
});

export type CloseClinicalSessionInput = z.infer<typeof closeClinicalSessionSchema>;

/** Enmienda de una sesión cerrada: abre una sesión nueva en borrador con su copia. */
export const amendClinicalSessionSchema = z.object({
  reason: z
    .string()
    .overwrite(cleanText)
    .pipe(z.string().min(3, 'Indica por qué se corrige la sesión').max(300)),
});

export type AmendClinicalSessionInput = z.infer<typeof amendClinicalSessionSchema>;

/* ── Salidas de la API ─────────────────────────────────────────────────────── */

export const clinicalSessionStatusSchema = z.enum(CLINICAL_SESSION_STATUSES);

export const clinicalSessionSummarySchema = z.object({
  id: z.uuid(),
  recordId: z.uuid(),
  patientId: z.uuid(),
  appointmentId: z.uuid().nullable(),
  sessionNumber: z.number().int().min(1),
  status: clinicalSessionStatusSchema,
  openedAt: z.string(),
  updatedAt: z.string(),
  closedAt: z.string().nullable(),
  openedByUsername: z.string().nullable(),
  closedByUsername: z.string().nullable(),
  closureNote: z.string().nullable(),
  /** Sesión que esta corrige (la enmendada apunta a la original, que no se toca). */
  amendedFromId: z.uuid().nullable(),
  amendmentReason: z.string().nullable(),
  procedureCount: z.number().int().min(0),
  /** Resumen legible («Sesión: Profilaxis…»), el mismo que va a la auditoría. */
  summary: z.string(),
});

export type ClinicalSessionSummary = z.infer<typeof clinicalSessionSummarySchema>;

export const clinicalSessionDetailSchema = clinicalSessionSummarySchema.extend({
  content: clinicalSessionContentSchema,
});

export type ClinicalSessionDetail = z.infer<typeof clinicalSessionDetailSchema>;

export const clinicalSessionListSchema = z.object({
  items: z.array(clinicalSessionSummarySchema),
  total: z.number().int().min(0),
});

export type ClinicalSessionList = z.infer<typeof clinicalSessionListSchema>;

/**
 * Estado de una sesión para los **otros servicios** (la agenda comprueba que la
 * sesión esté cerrada antes de dejar marcar «atendido» sin motivo).
 */
export const clinicalSessionStatusLookupSchema = z.object({
  sessionId: z.uuid(),
  patientId: z.uuid(),
  appointmentId: z.uuid().nullable(),
  status: clinicalSessionStatusSchema,
  closedAt: z.string().nullable(),
});

export type ClinicalSessionStatusLookup = z.infer<typeof clinicalSessionStatusLookupSchema>;
