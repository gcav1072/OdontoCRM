import type { ReportDocument, ReportRow } from '@odontocrm/contracts';
import { and, eq, sql } from 'drizzle-orm';

import { dimPatient, factAppointment } from '../db/schema.js';
import {
  columna,
  condicionesDePaciente,
  documento,
  enRango,
  kpi,
  notaDeFiltros,
  porcentaje,
  punto,
  serie,
  sinDatos,
  tabla,
  type ReportContext,
  type ReportDeps,
} from './shared.js';

/**
 * Reporte de **ocupación por consultorio** (multisillón): cuántas citas lleva cada
 * sillón, cuántas atiende y cuántas se pierden.
 *
 * El nombre del consultorio lo guarda el hecho (`fact_appointment.chair_label`), que
 * llega **en el evento** de la cita: el read model no lee la agenda ni resuelve ids. Las
 * citas sin consultorio (datos anteriores a la migración multisillón, o eventos viejos)
 * se agrupan bajo «Sin consultorio» en vez de perderse.
 */

export interface FilaConsultorio {
  label: string;
  citas: number;
  attended: number;
  noShow: number;
  cancelled: number;
}

export const SIN_CONSULTORIO = 'Sin consultorio';

/**
 * Compone el documento. **Pura**: las tasas y la tabla se prueban sin base de datos.
 */
export const componerOcupacionConsultorios = (
  filas: readonly FilaConsultorio[],
  ctx: ReportContext,
): ReportDocument => {
  const ordenadas = [...filas].sort((izquierda, derecha) => derecha.citas - izquierda.citas);
  const total = ordenadas.reduce((suma, fila) => suma + fila.citas, 0);
  const atendidas = ordenadas.reduce((suma, fila) => suma + fila.attended, 0);
  const inasistencias = ordenadas.reduce((suma, fila) => suma + fila.noShow, 0);
  const masOcupado = ordenadas[0] ?? null;

  const puntos = ordenadas.flatMap((fila) => [
    punto(fila.label, fila.citas, 'citas'),
    punto(fila.label, fila.attended, 'atendidas'),
  ]);

  const filasTabla: ReportRow[] = ordenadas.map((fila) => ({
    consultorio: fila.label,
    citas: fila.citas,
    atendidas: fila.attended,
    inasistencias: fila.noShow,
    canceladas: fila.cancelled,
    tasaInasistencia: porcentaje(fila.noShow, fila.citas),
    participacion: porcentaje(fila.citas, total),
  }));

  const notes: string[] = [];
  const filtros = notaDeFiltros(ctx.filters, ctx.range.to);
  if (filtros !== null) notes.push(filtros);
  if (total === 0) notes.push(sinDatos(ctx));
  notes.push(
    'Las citas sin consultorio asignado (anteriores a la migración multisillón) se agrupan bajo «Sin consultorio».',
  );

  return documento('chair-occupancy', ctx, {
    kpis: [
      kpi('Citas', total, { hint: `${String(atendidas)} atendidas` }),
      kpi('Consultorios', ordenadas.length, {
        hint: ordenadas.length === 0 ? null : `más ocupado: ${masOcupado?.label ?? '—'}`,
      }),
      kpi('Atendidas', porcentaje(atendidas, total), {
        unit: '%',
        hint: `${String(atendidas)} citas`,
        tone: 'good',
      }),
      kpi('Inasistencias', porcentaje(inasistencias, total), {
        unit: '%',
        hint: `${String(inasistencias)} citas`,
        tone: inasistencias > 0 ? 'warn' : 'neutral',
      }),
    ],
    series: [
      serie('consultorios', 'Citas por consultorio', 'bar', puntos, {
        xLabel: 'consultorio',
        yLabel: 'citas',
      }),
    ],
    table: tabla(
      [
        columna('consultorio', 'Consultorio'),
        columna('citas', 'Citas', 'number'),
        columna('atendidas', 'Atendidas', 'number'),
        columna('inasistencias', 'Inasistencias', 'number'),
        columna('canceladas', 'Canceladas', 'number'),
        columna('tasaInasistencia', 'Inasistencia', 'percent'),
        columna('participacion', 'Participación', 'percent'),
      ],
      filasTabla,
    ),
    notes,
  });
};

export const buildChairOccupancyReport = async (
  deps: ReportDeps,
  ctx: ReportContext,
): Promise<ReportDocument> => {
  const label = sql<string>`coalesce(${factAppointment.chairLabel}, ${SIN_CONSULTORIO})`;
  const filas = await deps.db
    .select({
      label,
      citas: sql<number>`count(*)::int`,
      attended: sql<number>`(count(*) filter (where ${factAppointment.status} = 'atendido'))::int`,
      noShow: sql<number>`(count(*) filter (where ${factAppointment.status} = 'no_asistio'))::int`,
      cancelled: sql<number>`(count(*) filter (where ${factAppointment.status} = 'cancelada'))::int`,
    })
    .from(factAppointment)
    .leftJoin(dimPatient, eq(dimPatient.patientId, factAppointment.patientId))
    .where(
      and(
        enRango(factAppointment.appointmentDate, ctx.range),
        ...condicionesDePaciente(ctx.filters, ctx.range.to),
      ),
    )
    .groupBy(sql`1`)
    .orderBy(sql`1`);

  return componerOcupacionConsultorios(filas, ctx);
};
