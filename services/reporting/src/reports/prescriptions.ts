import type { ReportDocument } from '@odontocrm/contracts';
import { and, eq, ne, sql } from 'drizzle-orm';

import { dimPatient, factPrescription, factPrescriptionItem } from '../db/schema.js';
import { mvPrescriptions } from '../db/views.js';
import {
  columna,
  condicionesDePaciente,
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
 * Reporte de **medicamentos recetados** (plan §13, Fase 9): los más recetados en el
 * período, con su número de récipes, renglones y pacientes.
 *
 * Los récipes **anulados no cuentan**: un récipe anulado es uno que no llegó al
 * paciente. Un medicamento repetido en el mismo récipe cuenta un renglón y un solo
 * récipe (`count(distinct prescription_id)`).
 *
 * La tabla se recorta al top (`TOP_MEDICAMENTOS`) y el documento dice de cuántos.
 */

export const TOP_MEDICAMENTOS = 20;
export const TOP_SERIE_MEDICAMENTOS = 12;

export interface FilaMedicamento {
  medicationName: string;
  prescriptions: number;
  items: number;
  patients: number;
}

export interface TotalesRecetas {
  recetas: number;
  anuladas: number;
}

/**
 * Compone el documento. **Pura**: el ranking, los porcentajes y el recorte al top se
 * prueban sin base de datos.
 */
export const componerRecetas = (
  filas: readonly FilaMedicamento[],
  totales: TotalesRecetas,
  ctx: ReportContext,
): ReportDocument => {
  const porMedicamento = new Map<
    string,
    { prescriptions: number; items: number; patients: number }
  >();
  for (const fila of filas) {
    const acumulado = porMedicamento.get(fila.medicationName) ?? {
      prescriptions: 0,
      items: 0,
      patients: 0,
    };
    acumulado.prescriptions += fila.prescriptions;
    acumulado.items += fila.items;
    // Los pacientes distintos no se pueden sumar entre días: se toma el mayor, que
    // es una cota inferior honesta (la vista pre-agregada no lleva el detalle).
    acumulado.patients = Math.max(acumulado.patients, fila.patients);
    porMedicamento.set(fila.medicationName, acumulado);
  }

  const ranking = [...porMedicamento.entries()]
    .map(([medicationName, conteo]) => ({ medicationName, ...conteo }))
    .sort(
      (izquierda, derecha) =>
        derecha.items - izquierda.items ||
        derecha.prescriptions - izquierda.prescriptions ||
        izquierda.medicationName.localeCompare(derecha.medicationName),
    );

  const renglones = ranking.reduce((suma, fila) => suma + fila.items, 0);
  const top = recortarTabla(
    ranking.map((fila) => ({
      medicamento: fila.medicationName,
      recetas: fila.prescriptions,
      renglones: fila.items,
      pacientes: fila.patients,
      porcentaje: porcentaje(fila.items, renglones),
    })),
    TOP_MEDICAMENTOS,
    'medicamentos',
  );

  const primeros = ranking.slice(0, TOP_SERIE_MEDICAMENTOS);
  const puntos = primeros.map((fila) => punto(fila.medicationName, fila.items, 'renglones'));
  const puntosRecetas = primeros.map((fila) =>
    punto(fila.medicationName, fila.prescriptions, 'récipes'),
  );

  const masRecetado = ranking[0] ?? null;
  const notes: string[] = [];
  const filtros = notaDeFiltros(ctx.filters, ctx.range.to);
  if (filtros !== null) notes.push(filtros);
  if (filas.length === 0) notes.push(sinDatos(ctx));
  notes.push('Los récipes anulados no cuentan: no llegaron al paciente.');
  if (top.nota !== null) notes.push(top.nota);
  if (totales.anuladas > 0) {
    notes.push(`Récipes anulados en el período (no cuentan): ${String(totales.anuladas)}.`);
  }
  notes.push(
    'La columna de pacientes cuenta pacientes distintos por medicamento: con la vista pre-agregada por día es una cota inferior.',
  );

  return documento('prescriptions', ctx, {
    kpis: [
      kpi('Récipes emitidos', totales.recetas, { hint: `${String(totales.anuladas)} anulados` }),
      kpi('Medicamentos distintos', ranking.length),
      kpi('Renglones recetados', renglones, {
        hint: 'un renglón por medicamento y récipe',
      }),
      kpi('Más recetado', masRecetado?.medicationName ?? '—', {
        hint: masRecetado === null ? null : `${String(masRecetado.items)} renglones`,
      }),
    ],
    series: [
      serie(
        'medicamentos',
        `Renglones por medicamento (top ${String(TOP_SERIE_MEDICAMENTOS)})`,
        'bar',
        puntos,
      ),
      serie(
        'recetas',
        `Récipes por medicamento (top ${String(TOP_SERIE_MEDICAMENTOS)})`,
        'bar',
        puntosRecetas,
      ),
    ],
    table: tabla(
      [
        columna('medicamento', 'Medicamento'),
        columna('recetas', 'Récipes', 'number'),
        columna('renglones', 'Renglones', 'number'),
        columna('pacientes', 'Pacientes', 'number'),
        columna('porcentaje', 'Porcentaje', 'percent'),
      ],
      top.filas,
      top.total,
    ),
    notes,
  });
};

/* ── Proyección ────────────────────────────────────────────────────────────── */

/** Medicamentos desde la vista materializada, que viene agregada por día. */
const proyectarDesdeVista = async (
  deps: ReportDeps,
  ctx: ReportContext,
): Promise<FilaMedicamento[]> => {
  const filas = await deps.db
    .select({
      medicationName: mvPrescriptions.medicationName,
      prescriptions: mvPrescriptions.prescriptions,
      items: mvPrescriptions.items,
      patients: mvPrescriptions.patients,
    })
    .from(mvPrescriptions)
    .where(enRango(mvPrescriptions.day, ctx.range));
  return filas;
};

/** Medicamentos calculados en vivo desde los renglones, con los filtros cruzados. */
const proyectarDesdeHechos = async (
  deps: ReportDeps,
  ctx: ReportContext,
): Promise<FilaMedicamento[]> => {
  const filas = await deps.db
    .select({
      medicationName: factPrescriptionItem.medicationName,
      prescriptions: sql<number>`count(distinct ${factPrescriptionItem.prescriptionId})::int`,
      items: sql<number>`count(*)::int`,
      patients: sql<number>`count(distinct ${factPrescriptionItem.patientId})::int`,
    })
    .from(factPrescriptionItem)
    .innerJoin(
      factPrescription,
      eq(factPrescription.prescriptionId, factPrescriptionItem.prescriptionId),
    )
    .leftJoin(dimPatient, eq(dimPatient.patientId, factPrescriptionItem.patientId))
    .where(
      and(
        ne(factPrescription.status, 'anulada'),
        enRango(factPrescriptionItem.issuedAt, ctx.range),
        ...condicionesDePaciente(ctx.filters, ctx.range.to),
      ),
    )
    // Sin el día en el `group by`: en vivo se puede contar exacto y la forma de la
    // fila es la misma que la de la vista.
    .groupBy(factPrescriptionItem.medicationName);
  return filas;
};

/** Récipes emitidos y anulados del período (KPIs que no salen de los renglones). */
const contarRecetas = async (deps: ReportDeps, ctx: ReportContext): Promise<TotalesRecetas> => {
  const filas = await deps.db
    .select({
      recetas: sql<number>`count(*)::int`,
      anuladas: sql<number>`(count(*) filter (where ${factPrescription.status} = 'anulada'))::int`,
    })
    .from(factPrescription)
    .leftJoin(dimPatient, eq(dimPatient.patientId, factPrescription.patientId))
    .where(
      and(
        enRango(factPrescription.issuedAt, ctx.range),
        ...condicionesDePaciente(ctx.filters, ctx.range.to),
      ),
    );
  const fila = filas[0];
  return { recetas: fila?.recetas ?? 0, anuladas: fila?.anuladas ?? 0 };
};

export const buildPrescriptionsReport = async (
  deps: ReportDeps,
  ctx: ReportContext,
): Promise<ReportDocument> => {
  const [filas, totales] = await Promise.all([
    hayFiltrosDePaciente(ctx.filters)
      ? proyectarDesdeHechos(deps, ctx)
      : proyectarDesdeVista(deps, ctx),
    contarRecetas(deps, ctx),
  ]);
  return componerRecetas(filas, totales, ctx);
};
