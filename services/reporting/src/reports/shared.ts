import {
  AGE_BUCKETS,
  REPORT_DESCRIPTIONS,
  REPORT_LABELS,
  type ReportColumn,
  type ReportColumnType,
  type ReportDocument,
  type ReportFilters,
  type ReportGranularity,
  type ReportKey,
  type ReportKpi,
  type ReportKpiTone,
  type ReportRange,
  type ReportRow,
  type ReportSeries,
  type ReportSeriesKind,
  type ReportSeriesPoint,
  type ReportTable,
} from '@odontocrm/contracts';
import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';

import type { ReportingDb } from '../db/client.js';
import { dimPatient } from '../db/schema.js';

/**
 * Piezas comunes a los seis reportes.
 *
 * Todo lo que hay aquí es **puro** (salvo los constructores de condiciones SQL), de
 * modo que la parte difícil de un reporte —agrupar por período, calcular tasas,
 * recortar una tabla— se puede probar sin base de datos.
 */

export interface ReportDeps {
  db: ReportingDb;
}

/** Lo que necesita cualquier reporte: los filtros ya validados y el rango resuelto. */
export interface ReportContext {
  filters: ReportFilters;
  range: ReportRange;
  generatedAt: string;
}

/* ── Constructores del documento ───────────────────────────────────────────── */

export const kpi = (
  label: string,
  value: number | string,
  options: { unit?: string | null; hint?: string | null; tone?: ReportKpiTone } = {},
): ReportKpi => ({
  label,
  value,
  unit: options.unit ?? null,
  hint: options.hint ?? null,
  tone: options.tone ?? 'neutral',
});

export const columna = (
  key: string,
  label: string,
  type: ReportColumnType = 'text',
): ReportColumn => ({ key, label, type });

export const punto = (x: string, y: number, group: string | null = null): ReportSeriesPoint => ({
  x,
  y,
  group,
});

export const serie = (
  id: string,
  label: string,
  kind: ReportSeriesKind,
  points: readonly ReportSeriesPoint[],
  options: { xLabel?: string | null; yLabel?: string | null } = {},
): ReportSeries => ({
  id,
  label,
  kind,
  xLabel: options.xLabel ?? null,
  yLabel: options.yLabel ?? null,
  points: [...points],
});

export const tabla = (
  columns: readonly ReportColumn[],
  rows: readonly ReportRow[],
  total: number | null = null,
): ReportTable => ({ columns: [...columns], rows: [...rows], total });

/** Arma el documento con lo que comparten los seis reportes (título, rango, filtros). */
export const documento = (
  key: ReportKey,
  ctx: ReportContext,
  partes: Pick<ReportDocument, 'kpis' | 'series' | 'table' | 'notes'>,
): ReportDocument => ({
  key,
  title: REPORT_LABELS[key],
  subtitle: `${REPORT_DESCRIPTIONS[key]} Del ${ctx.range.from} al ${ctx.range.to}.`,
  generatedAt: ctx.generatedAt,
  range: ctx.range,
  filters: ctx.filters,
  kpis: partes.kpis,
  series: partes.series,
  table: partes.table,
  notes: partes.notes,
});

export const sinDatos = (ctx: ReportContext): string =>
  `Sin datos entre el ${ctx.range.from} y el ${ctx.range.to} con los filtros elegidos.`;

/** Nota que deja constancia de los filtros de paciente aplicados (o `null`). */
export const notaDeFiltros = (filters: ReportFilters, alDia: string): string | null => {
  const partes: string[] = [];
  if (filters.ageMin !== undefined || filters.ageMax !== undefined) {
    const desde = filters.ageMin === undefined ? '0' : String(filters.ageMin);
    const hasta = filters.ageMax === undefined ? '120' : String(filters.ageMax);
    partes.push(`edad de ${desde} a ${hasta} años (cumplidos al ${alDia})`);
  }
  if (filters.sex !== undefined) partes.push(`sexo ${filters.sex}`);
  if (filters.status !== undefined) partes.push(`estado ${filters.status}`);
  return partes.length === 0 ? null : `Filtros aplicados: ${partes.join(', ')}.`;
};

/* ── Números ───────────────────────────────────────────────────────────────── */

/** Porcentaje con un decimal, **ya escalado** (12,5 se pinta como «12,5 %»). */
export const porcentaje = (parte: number, total: number): number =>
  total === 0 ? 0 : Math.round((parte / total) * 1000) / 10;

/**
 * Tasa de inasistencia: inasistencias sobre las citas que **debían** ocurrir
 * (atendidas + inasistencias). No se cuentan las canceladas: una cita cancelada con
 * aviso no es una inasistencia.
 */
export const tasaInasistencia = (atendidas: number, inasistencias: number): number =>
  porcentaje(inasistencias, atendidas + inasistencias);

/* ── Períodos ──────────────────────────────────────────────────────────────── */

/** Lunes de la semana de una fecha `aaaa-mm-dd` (la semana empieza en lunes). */
export const inicioDeSemana = (fecha: string): string => {
  const dia = new Date(`${fecha}T00:00:00Z`);
  const desdeElLunes = (dia.getUTCDay() + 6) % 7;
  dia.setUTCDate(dia.getUTCDate() - desdeElLunes);
  return dia.toISOString().slice(0, 10);
};

/** Clave del período al que pertenece una fecha, según la agrupación pedida. */
export const periodoDe = (fecha: string, granularidad: ReportGranularity): string => {
  if (granularidad === 'month') return fecha.slice(0, 7);
  if (granularidad === 'week') return inicioDeSemana(fecha);
  return fecha;
};

/** Etiqueta legible y **ordenable** del período (es la que sale en la tabla). */
export const etiquetaDePeriodo = (periodo: string, granularidad: ReportGranularity): string =>
  granularidad === 'week'
    ? `semana del ${periodo}`
    : granularidad === 'month'
      ? `mes ${periodo}`
      : periodo;

/**
 * Todos los períodos del rango, en orden y **sin huecos**: un día sin citas tiene que
 * salir con ceros, no desaparecer de la gráfica.
 */
export const periodosDelRango = (range: ReportRange, granularidad: ReportGranularity): string[] => {
  const periodos: string[] = [];
  const cursor = new Date(`${range.from}T00:00:00Z`);
  const fin = new Date(`${range.to}T00:00:00Z`);
  while (cursor.getTime() <= fin.getTime()) {
    const periodo = periodoDe(cursor.toISOString().slice(0, 10), granularidad);
    if (periodos[periodos.length - 1] !== periodo) periodos.push(periodo);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return periodos;
};

/** Días del rango, en orden (para las series diarias de ocupación). */
export const diasDelRango = (range: ReportRange): string[] => {
  const dias: string[] = [];
  const cursor = new Date(`${range.from}T00:00:00Z`);
  const fin = new Date(`${range.to}T00:00:00Z`);
  while (cursor.getTime() <= fin.getTime()) {
    dias.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dias;
};

/* ── Filtros de paciente (combinados sobre `dim_patient`) ──────────────────── */

/**
 * ¿Hay algún filtro que dependa del paciente? Cuando no lo hay, un reporte puede
 * servirse de su vista materializada (pre-agregada); cuando lo hay, hay que cruzar
 * `dim_patient` y agregar en vivo.
 */
export const hayFiltrosDePaciente = (filters: ReportFilters): boolean =>
  filters.ageMin !== undefined ||
  filters.ageMax !== undefined ||
  filters.sex !== undefined ||
  filters.status !== undefined;

/** Edad en años cumplidos a una fecha, calculada en SQL (igual que `ageAtDate`). */
export const edadSql = (alDia: string): SQL<number> =>
  sql<number>`extract(year from age(${alDia}::date, ${dimPatient.birthDate}))::int`;

/**
 * Condiciones de `dim_patient` que se **combinan** (Y lógico) con las del hecho:
 * sexo, estado y rango de edad. Los pacientes sin fecha de nacimiento quedan fuera
 * de un filtro de edad —no se les puede calcular—, y eso se explica en las notas.
 */
export const condicionesDePaciente = (filters: ReportFilters, alDia: string): SQL[] => {
  const condiciones: SQL[] = [];
  if (filters.sex !== undefined) condiciones.push(sql`${dimPatient.sex} = ${filters.sex}`);
  if (filters.status !== undefined) condiciones.push(sql`${dimPatient.status} = ${filters.status}`);
  if (filters.ageMin !== undefined || filters.ageMax !== undefined) {
    condiciones.push(sql`${dimPatient.birthDate} is not null`);
    const edad = edadSql(alDia);
    if (filters.ageMin !== undefined) condiciones.push(sql`${edad} >= ${filters.ageMin}`);
    if (filters.ageMax !== undefined) condiciones.push(sql`${edad} <= ${filters.ageMax}`);
  }
  return condiciones;
};

/** `expresión between desde and hasta`, con el rango resuelto del reporte. */
export const enRango = (expresion: SQLWrapper, range: ReportRange): SQL =>
  sql`${expresion} between ${range.from}::date and ${range.to}::date`;

/** Columna `day` de una vista materializada como texto `aaaa-mm-dd`. */
export const diaTexto = (expresion: SQLWrapper): SQL<string> =>
  sql<string>`to_char(${expresion}, 'YYYY-MM-DD')`;

/* ── Tablas recortadas (top N) ─────────────────────────────────────────────── */

export interface TablaRecortada {
  filas: ReportRow[];
  total: number;
  recortada: boolean;
  nota: string | null;
}

/**
 * Recorta una tabla al top N dejando dicho **cuántas filas había**: un reporte de
 * medicamentos con 340 nombres no se sirve entero, pero tampoco se miente diciendo
 * que solo hay 20.
 */
export const recortarTabla = (
  filas: readonly ReportRow[],
  limite: number,
  que: string,
): TablaRecortada => {
  const total = filas.length;
  if (total <= limite) return { filas: [...filas], total, recortada: false, nota: null };
  return {
    filas: filas.slice(0, limite),
    total,
    recortada: true,
    nota: `La tabla muestra ${String(limite)} de ${String(total)} ${que}.`,
  };
};

/* ── Etiquetas de apoyo ────────────────────────────────────────────────────── */

/** Nombre legible de un tramo de edad del contrato (`18-40` → «18 a 40 años»). */
export const etiquetaDeTramo = (bucket: string): string =>
  AGE_BUCKETS.find((tramo) => tramo.key === bucket)?.label ?? bucket;
