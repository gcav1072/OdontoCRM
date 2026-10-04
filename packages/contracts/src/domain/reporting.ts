import { z } from 'zod';

import { buildCsv } from '../common/csv.js';
import { PATIENT_STATUSES, SEXES } from './enums.js';

/**
 * Reportes, KPIs y exportación (Fase 9, [ADR 0019](../../../docs/adr/0019-reportes-y-kpis.md)).
 *
 * El catálogo es **cerrado**: estos seis reportes y no otros. Todos comparten los
 * mismos filtros (fecha, rango de edad, sexo y estado) y todos se sirven con la
 * misma forma de documento (`ReportDocument`), de modo que:
 *
 * - la interfaz tiene **un** componente de tablas, **uno** de gráficas y **uno**
 *   de filtros para los seis reportes, en vez de seis pantallas distintas;
 * - la exportación (CSV y PDF) se escribe **una vez**: CSV sale de la tabla del
 *   documento y el PDF imprime el documento entero;
 * - una prueba unitaria puede comprobar las cifras de cualquier reporte sin
 *   levantar un navegador.
 *
 * El servicio `reporting` compone el documento desde su read model (nunca
 * consultando las bases operativas) y la interfaz solo lo pinta.
 */

/* ── Catálogo de reportes ──────────────────────────────────────────────────── */

export const REPORT_KEYS = [
  'funnel',
  'capacity',
  'demographics',
  'clinical-profile',
  'oral-health',
  'prescriptions',
] as const;

export type ReportKey = (typeof REPORT_KEYS)[number];

export const reportKeySchema = z.enum(REPORT_KEYS);

/**
 * Permiso que exige cada reporte. Los **operativos** (embudo, ocupación y
 * demografía) van con `reports:read`, que tienen los tres roles; los
 * **clínicos** (perfil clínico, salud bucal y recetas) exigen `reports:clinical`
 * —`admin` y `odontologo`—, porque agregan datos de la historia clínica
 * (plan §5.4: la secretaría ve reportes operativos).
 */
export const REPORT_PERMISSIONS = {
  funnel: 'reports:read',
  capacity: 'reports:read',
  demographics: 'reports:read',
  'clinical-profile': 'reports:clinical',
  'oral-health': 'reports:clinical',
  prescriptions: 'reports:clinical',
} as const satisfies Readonly<Record<ReportKey, string>>;

export const reportPermissionFor = (key: ReportKey): 'reports:read' | 'reports:clinical' =>
  REPORT_PERMISSIONS[key];

export const REPORT_LABELS: Readonly<Record<ReportKey, string>> = {
  funnel: 'Embudo y tasa de inasistencia',
  capacity: 'Ocupación de la agenda',
  demographics: 'Demografía',
  'clinical-profile': 'Perfil clínico',
  'oral-health': 'Salud bucal',
  prescriptions: 'Recetas por medicamento',
};

export const REPORT_DESCRIPTIONS: Readonly<Record<ReportKey, string>> = {
  funnel: 'Solicitudes → programadas → notificadas → atendidas, con la tasa de inasistencia.',
  capacity: 'Cupos usados frente a disponibles por día y detección de horas pico.',
  demographics: 'Pirámide de edad y distribución por sexo, con rango de edad editable.',
  'clinical-profile': 'Pacientes con diabetes, hipertensión, alergias, anticoagulantes y otros.',
  'oral-health': 'Prevalencia de caries, obturaciones y ausencias por pieza y por paciente.',
  prescriptions: 'Medicamentos más recetados en el período.',
};

/** Orden en que la interfaz pinta las pestañas de reportes. */
export const REPORT_ORDER: readonly ReportKey[] = REPORT_KEYS;

/* ── Filtros comunes ───────────────────────────────────────────────────────── */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const isoDateSchema = z
  .string()
  .regex(ISO_DATE, 'La fecha debe tener el formato aaaa-mm-dd');

export const REPORT_GRANULARITIES = ['day', 'week', 'month'] as const;
export type ReportGranularity = (typeof REPORT_GRANULARITIES)[number];

/** Filtros que aceptan **todos** los reportes (plan §13, Fase 9). */
export const reportFiltersSchema = z.object({
  /** Fecha inicial (incluida). Por defecto, hace 29 días. */
  from: isoDateSchema.optional(),
  /** Fecha final (incluida). Por defecto, hoy en America/Caracas. */
  to: isoDateSchema.optional(),
  ageMin: z.coerce.number().int().min(0).max(120).optional(),
  ageMax: z.coerce.number().int().min(0).max(120).optional(),
  sex: z.enum(SEXES).optional(),
  /** Estado del paciente (`en_espera_cita`, `activo`, `inactivo`). */
  status: z.enum(PATIENT_STATUSES).optional(),
  /** Agrupación de las series temporales (embudo y ocupación). */
  granularity: z.enum(REPORT_GRANULARITIES).default('week'),
});

export type ReportFilters = z.infer<typeof reportFiltersSchema>;

/** Número de días del período por defecto (una ventana de un mes). */
export const REPORT_DEFAULT_DAYS = 30;
export const REPORT_MAX_DAYS = 1_095;

export const reportRangeSchema = z.object({ from: isoDateSchema, to: isoDateSchema });
export type ReportRange = z.infer<typeof reportRangeSchema>;

/**
 * Resuelve y valida el rango de fechas de un reporte.
 *
 * Sin fechas explícitas se usa una **ventana de 30 días** que termina hoy: es lo
 * que quiere ver quien abre la pantalla. Un rango invertido o más largo que
 * `REPORT_MAX_DAYS` (3 años) se rechaza con un error legible en vez de devolver
 * una consulta gigantesca.
 */
export const resolveReportRange = (
  filters: Pick<ReportFilters, 'from' | 'to'>,
  today: string,
): ReportRange => {
  const to = filters.to ?? today;
  const from = filters.from ?? shiftIsoDate(to, -(REPORT_DEFAULT_DAYS - 1));
  if (!ISO_DATE.test(from) || !ISO_DATE.test(to)) {
    throw new Error('El rango del reporte necesita fechas aaaa-mm-dd');
  }
  if (from > to) throw new Error('El rango del reporte empieza después de terminar');
  if (daysBetween(from, to) > REPORT_MAX_DAYS) {
    throw new Error(`El rango del reporte no puede pasar de ${String(REPORT_MAX_DAYS)} días`);
  }
  return { from, to };
};

/** Suma días a una fecha `aaaa-mm-dd` sin depender de la zona horaria local. */
export const shiftIsoDate = (isoDate: string, days: number): string => {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

/** Días completos entre dos fechas `aaaa-mm-dd` (ambas incluidas). */
export const daysBetween = (from: string, to: string): number => {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  return Math.round((end - start) / 86_400_000);
};

/* ── Edad ──────────────────────────────────────────────────────────────────── */

/** Tramos de edad de la pirámide demográfica (plan §12: el seed los respeta). */
export const AGE_BUCKETS = [
  { key: '0-12', label: '0 a 12 años', from: 0, to: 12 },
  { key: '13-17', label: '13 a 17 años', from: 13, to: 17 },
  { key: '18-40', label: '18 a 40 años', from: 18, to: 40 },
  { key: '41-65', label: '41 a 65 años', from: 41, to: 65 },
  { key: '66+', label: '66 años o más', from: 66, to: 120 },
] as const;

export type AgeBucketKey = (typeof AGE_BUCKETS)[number]['key'];

export const ageBucketOf = (age: number): AgeBucketKey => {
  const bucket = AGE_BUCKETS.find((candidate) => age >= candidate.from && age <= candidate.to);
  return bucket?.key ?? '66+';
};

/** Edad en años cumplidos a una fecha `aaaa-mm-dd`. Se calcula en UTC a propósito. */
export const ageAtDate = (birthDate: string, atDate: string): number => {
  const born = Date.parse(`${birthDate}T00:00:00Z`);
  const at = Date.parse(`${atDate}T00:00:00Z`);
  if (Number.isNaN(born) || Number.isNaN(at)) return 0;
  const birthday = new Date(born);
  const reference = new Date(at);
  let age = reference.getUTCFullYear() - birthday.getUTCFullYear();
  const monthDelta = reference.getUTCMonth() - birthday.getUTCMonth();
  if (monthDelta < 0 || (monthDelta === 0 && reference.getUTCDate() < birthday.getUTCDate())) {
    age -= 1;
  }
  return Math.max(0, age);
};

/* ── Forma del documento de reporte ────────────────────────────────────────── */

export const REPORT_KPI_TONES = ['neutral', 'good', 'warn', 'bad'] as const;
export type ReportKpiTone = (typeof REPORT_KPI_TONES)[number];

export const reportKpiSchema = z.object({
  label: z.string().min(1),
  /** Cifra ya formateada o número crudo; la interfaz decide cómo pintarla. */
  value: z.union([z.number(), z.string()]),
  unit: z.string().nullable().default(null),
  hint: z.string().nullable().default(null),
  tone: z.enum(REPORT_KPI_TONES).default('neutral'),
});

export type ReportKpi = z.infer<typeof reportKpiSchema>;

export const REPORT_SERIES_KINDS = ['bar', 'stacked-bar', 'line', 'pie', 'pyramid'] as const;
export type ReportSeriesKind = (typeof REPORT_SERIES_KINDS)[number];

export const reportSeriesPointSchema = z.object({
  /** Etiqueta del eje X (semana, mes, tramo de edad, pieza…). */
  x: z.string(),
  y: z.number(),
  /** Serie a la que pertenece el punto (`M`, `F`, `atendidas`…). */
  group: z.string().nullable().default(null),
});
export type ReportSeriesPoint = z.infer<typeof reportSeriesPointSchema>;

export const reportSeriesSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  kind: z.enum(REPORT_SERIES_KINDS),
  xLabel: z.string().nullable().default(null),
  yLabel: z.string().nullable().default(null),
  points: z.array(reportSeriesPointSchema),
});
export type ReportSeries = z.infer<typeof reportSeriesSchema>;

export const REPORT_COLUMN_TYPES = ['text', 'number', 'percent', 'date'] as const;
export type ReportColumnType = (typeof REPORT_COLUMN_TYPES)[number];

export const reportColumnSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  type: z.enum(REPORT_COLUMN_TYPES).default('text'),
});
export type ReportColumn = z.infer<typeof reportColumnSchema>;

export const reportCellValueSchema = z.union([z.string(), z.number(), z.null()]);
export type ReportCellValue = z.infer<typeof reportCellValueSchema>;
export type ReportRow = Record<string, ReportCellValue>;

export const reportTableSchema = z.object({
  columns: z.array(reportColumnSchema),
  rows: z.array(z.record(z.string(), reportCellValueSchema)),
  /** Total de filas del reporte cuando la tabla viene recortada (top N). */
  total: z.number().int().min(0).nullable().default(null),
});
export type ReportTable = z.infer<typeof reportTableSchema>;

/**
 * Documento de reporte: la única forma que devuelve el servicio y la única que
 * sabe pintar la interfaz. `kpis` resume, `series` dibuja y `table` exporta.
 */
export const reportDocumentSchema = z.object({
  key: reportKeySchema,
  title: z.string().min(1),
  subtitle: z.string(),
  generatedAt: z.string(),
  range: reportRangeSchema,
  /** Filtros ya resueltos (con sus valores por defecto aplicados). */
  filters: reportFiltersSchema,
  kpis: z.array(reportKpiSchema),
  series: z.array(reportSeriesSchema),
  table: reportTableSchema,
  /** Advertencias de lectura: «sin datos en el período», «top 20 de 340»… */
  notes: z.array(z.string()),
});

export type ReportDocument = z.infer<typeof reportDocumentSchema>;

/* ── Tablero del día ───────────────────────────────────────────────────────── */

export const reportSummarySchema = z.object({
  date: isoDateSchema,
  generatedAt: z.string(),
  appointments: z.object({
    scheduled: z.number().int().min(0),
    attended: z.number().int().min(0),
    noShow: z.number().int().min(0),
    pending: z.number().int().min(0),
    cancelled: z.number().int().min(0),
  }),
  capacity: z.object({
    capacity: z.number().int().min(0),
    assigned: z.number().int().min(0),
    freeSlots: z.number().int(),
  }),
  patients: z.object({
    active: z.number().int().min(0),
    waiting: z.number().int().min(0),
    newThisMonth: z.number().int().min(0),
  }),
  notifications: z.object({
    sent: z.number().int().min(0),
    failed: z.number().int().min(0),
  }),
  /** Última vez que el read model se refrescó (job nocturno o por eventos). */
  refreshedAt: z.string().nullable(),
});

export type ReportSummary = z.infer<typeof reportSummarySchema>;

/* ── Exportación ───────────────────────────────────────────────────────────── */

export const REPORT_EXPORT_FORMATS = ['csv', 'pdf'] as const;
export type ReportExportFormat = (typeof REPORT_EXPORT_FORMATS)[number];

export const reportParamsSchema = z.object({ key: reportKeySchema });
export type ReportParams = z.infer<typeof reportParamsSchema>;

export const reportExportParamsSchema = z.object({
  key: reportKeySchema,
  format: z.enum(REPORT_EXPORT_FORMATS),
});
export type ReportExportParams = z.infer<typeof reportExportParamsSchema>;

/**
 * CSV del reporte: sale de la **tabla** del documento, así que cualquier reporte
 * se exporta sin código propio y lo que se descarga es exactamente lo que se ve.
 */
export const reportToCsv = (document: ReportDocument): string =>
  buildCsv(document.table.columns, document.table.rows);

/** Nombre de archivo estable y sin acentos: `reporte-funnel-2026-10-01_2026-10-31.csv`. */
export const reportFileName = (
  key: ReportKey,
  range: ReportRange,
  format: ReportExportFormat,
): string => `reporte-${key}-${range.from}_${range.to}.${format}`;

/* ── Perfil clínico agregado ───────────────────────────────────────────────── */

/**
 * Grupos del perfil clínico, sobre los **códigos de alerta clínica** que ya
 * calcula la historia clínica (`clinicalAlerts`, `CLINICAL_ALERT_LABELS`). El
 * reporte cuenta pacientes por grupo; un paciente puede caer en varios.
 */
export const CLINICAL_PROFILE_GROUPS = [
  { key: 'diabetes', label: 'Diabetes', codes: ['diabetes'] },
  { key: 'hipertension', label: 'Hipertensión', codes: ['hipertension'] },
  { key: 'cardiopatia', label: 'Cardiopatía', codes: ['cardiopatia'] },
  {
    key: 'alergias',
    label: 'Alergias',
    codes: ['alergia_penicilina', 'alergia_anestesico', 'alergia_latex', 'alergia_otro'],
  },
  { key: 'anticoagulados', label: 'Anticoagulados', codes: ['anticoagulante'] },
  { key: 'bifosfonatos', label: 'Bifosfonatos', codes: ['bifosfonato'] },
  { key: 'otros_antecedentes', label: 'Otros antecedentes', codes: ['patologico_otro'] },
  { key: 'otros_medicamentos', label: 'Otros medicamentos', codes: ['medicamento_otro'] },
] as const;

export type ClinicalProfileGroupKey = (typeof CLINICAL_PROFILE_GROUPS)[number]['key'];

/**
 * Cuenta, por grupo, cuántos pacientes entran. `alerts` es un conjunto de
 * códigos por paciente; la función es pura para poder probarla sin base de datos.
 */
export const clinicalProfileCounts = (
  alertsByPatient: readonly (readonly string[])[],
): Record<ClinicalProfileGroupKey, number> => {
  const counts = Object.fromEntries(
    CLINICAL_PROFILE_GROUPS.map((group) => [group.key, 0]),
  ) as Record<ClinicalProfileGroupKey, number>;
  for (const alerts of alertsByPatient) {
    const set = new Set(alerts);
    for (const group of CLINICAL_PROFILE_GROUPS) {
      if (group.codes.some((code) => set.has(code))) counts[group.key] += 1;
    }
  }
  return counts;
};

/* ── Salud bucal ───────────────────────────────────────────────────────────── */

/** Condiciones que el reporte de salud bucal mide por pieza (ADR 0019). */
export const ORAL_HEALTH_CONDITIONS = ['caries', 'restauracion', 'ausente'] as const;
export type OralHealthCondition = (typeof ORAL_HEALTH_CONDITIONS)[number];

export const ORAL_HEALTH_LABELS: Readonly<Record<OralHealthCondition, string>> = {
  caries: 'Caries',
  restauracion: 'Obturaciones',
  ausente: 'Piezas ausentes',
};
