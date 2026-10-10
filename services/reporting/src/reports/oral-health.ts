import {
  ORAL_HEALTH_CONDITIONS,
  ORAL_HEALTH_LABELS,
  type OralHealthCondition,
  type ReportDocument,
  type ReportRow,
} from '@odontocrm/contracts';
import { and, eq, isNull, sql } from 'drizzle-orm';

import { dimPatient, factToothFinding } from '../db/schema.js';
import { mvOralHealth } from '../db/views.js';
import {
  columna,
  condicionesDePaciente,
  diaTexto,
  documento,
  enRango,
  hayFiltrosDePaciente,
  kpi,
  notaDeFiltros,
  porcentaje,
  punto,
  recortarTabla,
  serie,
  sinDatos,
  tabla,
  type ReportContext,
  type ReportDeps,
} from './shared.js';

/**
 * Reporte de **salud bucal** desde el odontograma (plan §13, Fase 9): prevalencia de
 * caries, restauraciones y piezas ausentes, por pieza FDI y por paciente.
 *
 * Se cuentan los hallazgos **vigentes** (`resolved_at` nulo) **registrados en el
 * período**: una pieza ya restaurada no es una caries activa, pero un hallazgo
 * registrado en el período y después superado tampoco cuenta. Las dos cosas están
 * dichas en las notas del documento.
 *
 * La tabla por pieza sale ordenada **numéricamente** (16 antes que 26, y 46 antes
 * que 51): ordenar el FDI como texto dejaría la arcada al revés.
 */

export const TOP_PACIENTES = 10;

export interface FilaSaludBucal {
  day: string;
  toothNumber: number;
  condition: string;
  findings: number;
  patients: number;
}

export interface FilaPacienteBucal {
  patientId: string;
  etiqueta: string;
  caries: number;
  restauracion: number;
  ausente: number;
  extraida: number;
  total: number;
}

const esCondicion = (valor: string): valor is OralHealthCondition =>
  (ORAL_HEALTH_CONDITIONS as readonly string[]).includes(valor);

/**
 * Compone el documento. **Pura**: la tabla por pieza, el recorte del top de pacientes
 * y los porcentajes se prueban sin base de datos.
 */
export const componerSaludBucal = (
  filas: readonly FilaSaludBucal[],
  pacientes: readonly FilaPacienteBucal[],
  ctx: ReportContext,
): ReportDocument => {
  const voto = (fila: FilaSaludBucal): OralHealthCondition | null =>
    esCondicion(fila.condition) ? fila.condition : null;

  const porPieza = new Map<number, Record<OralHealthCondition, number>>();
  for (const fila of filas) {
    const condicion = voto(fila);
    if (condicion === null) continue;
    const conteo = porPieza.get(fila.toothNumber) ?? {
      caries: 0,
      restauracion: 0,
      ausente: 0,
      extraida: 0,
    };
    conteo[condicion] += fila.findings;
    porPieza.set(fila.toothNumber, conteo);
  }

  const piezas = [...porPieza.keys()].sort((izquierda, derecha) => izquierda - derecha);
  const filasTabla: ReportRow[] = piezas.map((pieza) => {
    const conteo = porPieza.get(pieza) ?? { caries: 0, restauracion: 0, ausente: 0, extraida: 0 };
    return {
      pieza,
      caries: conteo.caries,
      restauraciones: conteo.restauracion,
      ausentes: conteo.ausente,
      extraidas: conteo.extraida,
      hallazgos: conteo.caries + conteo.restauracion + conteo.ausente + conteo.extraida,
    };
  });

  const totales = ORAL_HEALTH_CONDITIONS.map((condicion) => ({
    condicion,
    hallazgos: filas
      .filter((fila) => fila.condition === condicion)
      .reduce((suma, fila) => suma + fila.findings, 0),
  }));

  const pacientesConHallazgos = pacientes.length;
  const conCaries = pacientes.filter((fila) => fila.caries > 0).length;

  const puntos = ORAL_HEALTH_CONDITIONS.flatMap((condicion) =>
    piezas.map((pieza) =>
      punto(String(pieza), porPieza.get(pieza)?.[condicion] ?? 0, ORAL_HEALTH_LABELS[condicion]),
    ),
  );

  const ranking = [...pacientes].sort((izquierda, derecha) => derecha.total - izquierda.total);
  const top = recortarTabla(
    ranking.map((fila) => ({
      paciente: fila.etiqueta,
      caries: fila.caries,
      restauraciones: fila.restauracion,
      ausentes: fila.ausente,
      hallazgos: fila.total,
    })),
    TOP_PACIENTES,
    'pacientes con hallazgos',
  );
  const puntosPacientes = ranking
    .slice(0, TOP_PACIENTES)
    .flatMap((fila) =>
      ORAL_HEALTH_CONDITIONS.map((condicion) =>
        punto(fila.etiqueta, fila[condicion], ORAL_HEALTH_LABELS[condicion]),
      ),
    );

  const notes: string[] = [];
  const filtros = notaDeFiltros(ctx.filters, ctx.range.to);
  if (filtros !== null) notes.push(filtros);
  if (filas.length === 0) notes.push(sinDatos(ctx));
  notes.push(
    'Se cuentan los hallazgos vigentes registrados en el período (los que después se superaron o se borraron no cuentan).',
  );
  if (top.nota !== null) notes.push(top.nota);
  if (piezas.length > 0) {
    notes.push(`Piezas con hallazgos en el período: ${piezas.join(', ')}.`);
  }

  return documento('oral-health', ctx, {
    kpis: [
      kpi('Pacientes con hallazgos', pacientesConHallazgos, {
        hint: `${String(porcentaje(conCaries, pacientesConHallazgos))} % con caries`,
      }),
      kpi('Piezas afectadas', piezas.length),
      kpi('Caries', totales.find((total) => total.condicion === 'caries')?.hallazgos ?? 0, {
        hint: 'hallazgos vigentes',
        tone: 'bad',
      }),
      kpi(
        'Restauraciones',
        totales.find((total) => total.condicion === 'restauracion')?.hallazgos ?? 0,
        { hint: 'hallazgos vigentes' },
      ),
      kpi(
        'Piezas ausentes',
        totales.find((total) => total.condicion === 'ausente')?.hallazgos ?? 0,
        {
          hint: 'hallazgos vigentes',
          tone: 'warn',
        },
      ),
      kpi(
        'Piezas extraídas',
        totales.find((total) => total.condicion === 'extraida')?.hallazgos ?? 0,
        {
          hint: 'hallazgos vigentes',
          tone: 'warn',
        },
      ),
      kpi('Pacientes con caries', conCaries, {
        hint: `${String(porcentaje(conCaries, pacientesConHallazgos))} % de los pacientes con hallazgos`,
      }),
    ],
    series: [
      serie('piezas', 'Prevalencia por pieza (FDI)', 'stacked-bar', puntos, {
        xLabel: 'pieza',
        yLabel: 'hallazgos',
      }),
      serie(
        'pacientes',
        `Pacientes con más hallazgos (top ${String(TOP_PACIENTES)})`,
        'bar',
        puntosPacientes,
      ),
    ],
    table: tabla(
      [
        columna('pieza', 'Pieza (FDI)', 'number'),
        columna('caries', 'Caries', 'number'),
        columna('restauraciones', 'Restauraciones', 'number'),
        columna('ausentes', 'Ausentes', 'number'),
        columna('extraidas', 'Extraídas', 'number'),
        columna('hallazgos', 'Hallazgos', 'number'),
      ],
      filasTabla,
    ),
    notes,
  });
};

/* ── Proyección ────────────────────────────────────────────────────────────── */

/** Hallazgos por pieza desde la vista materializada (sin filtros de paciente). */
const proyectarDesdeVista = async (
  deps: ReportDeps,
  ctx: ReportContext,
): Promise<FilaSaludBucal[]> => {
  const filas = await deps.db
    .select({
      day: diaTexto(mvOralHealth.day),
      toothNumber: mvOralHealth.toothNumber,
      condition: mvOralHealth.condition,
      findings: mvOralHealth.findings,
      patients: mvOralHealth.patients,
    })
    .from(mvOralHealth)
    .where(enRango(mvOralHealth.day, ctx.range));
  return filas;
};

/** Hallazgos calculados en vivo, cruzando `dim_patient` para los filtros. */
const proyectarDesdeHechos = async (
  deps: ReportDeps,
  ctx: ReportContext,
): Promise<FilaSaludBucal[]> => {
  const filas = await deps.db
    .select({
      day: diaTexto(factToothFinding.recordedAt),
      toothNumber: factToothFinding.toothNumber,
      condition: factToothFinding.condition,
      findings: sql<number>`count(*)::int`,
      patients: sql<number>`count(distinct ${factToothFinding.patientId})::int`,
    })
    .from(factToothFinding)
    .leftJoin(dimPatient, eq(dimPatient.patientId, factToothFinding.patientId))
    .where(
      and(
        isNull(factToothFinding.resolvedAt),
        sql`${factToothFinding.condition} in ('caries', 'restauracion', 'ausente', 'extraida')`,
        enRango(factToothFinding.recordedAt, ctx.range),
        ...condicionesDePaciente(ctx.filters, ctx.range.to),
      ),
    )
    // Por posición: repetir `to_char(...)` en el `group by` llevaría parámetros
    // distintos y PostgreSQL no lo reconocería como la misma expresión.
    .groupBy(sql`1, 2, 3`);
  return filas;
};

/**
 * Ranking de pacientes: se calcula siempre en vivo (la vista es por pieza y no lleva
 * el nombre del paciente, que es dato identificable y no se pre-agrega).
 */
const proyectarPacientes = async (
  deps: ReportDeps,
  ctx: ReportContext,
): Promise<FilaPacienteBucal[]> => {
  const filas = await deps.db
    .select({
      patientId: factToothFinding.patientId,
      nombre: dimPatient.fullName,
      documento: dimPatient.document,
      caries: sql<number>`(count(*) filter (where ${factToothFinding.condition} = 'caries'))::int`,
      restauracion: sql<number>`(count(*) filter (where ${factToothFinding.condition} = 'restauracion'))::int`,
      ausente: sql<number>`(count(*) filter (where ${factToothFinding.condition} = 'ausente'))::int`,
      extraida: sql<number>`(count(*) filter (where ${factToothFinding.condition} = 'extraida'))::int`,
      total: sql<number>`count(*)::int`,
    })
    .from(factToothFinding)
    .leftJoin(dimPatient, eq(dimPatient.patientId, factToothFinding.patientId))
    .where(
      and(
        isNull(factToothFinding.resolvedAt),
        sql`${factToothFinding.condition} in ('caries', 'restauracion', 'ausente', 'extraida')`,
        enRango(factToothFinding.recordedAt, ctx.range),
        ...condicionesDePaciente(ctx.filters, ctx.range.to),
      ),
    )
    .groupBy(factToothFinding.patientId, dimPatient.fullName, dimPatient.document);

  return filas.map((fila) => ({
    patientId: fila.patientId,
    etiqueta:
      fila.nombre === null
        ? fila.patientId
        : fila.documento === null
          ? fila.nombre
          : `${fila.nombre} (${fila.documento})`,
    caries: fila.caries,
    restauracion: fila.restauracion,
    ausente: fila.ausente,
    extraida: fila.extraida,
    total: fila.total,
  }));
};

export const buildOralHealthReport = async (
  deps: ReportDeps,
  ctx: ReportContext,
): Promise<ReportDocument> => {
  const [filas, pacientes] = await Promise.all([
    hayFiltrosDePaciente(ctx.filters)
      ? proyectarDesdeHechos(deps, ctx)
      : proyectarDesdeVista(deps, ctx),
    proyectarPacientes(deps, ctx),
  ]);
  return componerSaludBucal(filas, pacientes, ctx);
};
