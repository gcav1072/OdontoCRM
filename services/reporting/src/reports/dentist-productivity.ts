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
 * Reporte de **productividad por odontólogo**: cuántas citas lleva cada doctor,
 * cuántas atiende y cuántas se pierden.
 *
 * El nombre viene del hecho (`fact_appointment.dentist_name`), que llega **en el
 * evento**; como el odontólogo de la cita es **opcional**, las citas sin doctor se
 * agrupan bajo «Sin asignar» —no es un error, la secretaría puede agendar sin él—.
 */

export interface FilaOdontologo {
  label: string;
  citas: number;
  attended: number;
  noShow: number;
  cancelled: number;
}

export const SIN_ODONTOLOGO = 'Sin asignar';

/**
 * Compone el documento. **Pura**: las tasas y la tabla se prueban sin base de datos.
 */
export const componerProductividadOdontologos = (
  filas: readonly FilaOdontologo[],
  ctx: ReportContext,
): ReportDocument => {
  const ordenadas = [...filas].sort((izquierda, derecha) => derecha.attended - izquierda.attended);
  const total = ordenadas.reduce((suma, fila) => suma + fila.citas, 0);
  const atendidas = ordenadas.reduce((suma, fila) => suma + fila.attended, 0);
  const inasistencias = ordenadas.reduce((suma, fila) => suma + fila.noShow, 0);
  const masProductivo = ordenadas[0] ?? null;

  const puntos = ordenadas.flatMap((fila) => [
    punto(fila.label, fila.citas, 'citas'),
    punto(fila.label, fila.attended, 'atendidas'),
  ]);

  const filasTabla: ReportRow[] = ordenadas.map((fila) => ({
    odontologo: fila.label,
    citas: fila.citas,
    atendidas: fila.attended,
    inasistencias: fila.noShow,
    canceladas: fila.cancelled,
    tasaAsistencia: porcentaje(fila.attended, fila.citas),
    particion: porcentaje(fila.citas, total),
  }));

  const notes: string[] = [];
  const filtros = notaDeFiltros(ctx.filters, ctx.range.to);
  if (filtros !== null) notes.push(filtros);
  if (total === 0) notes.push(sinDatos(ctx));
  notes.push(
    'El odontólogo de la cita es opcional: las citas sin doctor asignado se agrupan bajo «Sin asignar».',
  );

  return documento('dentist-productivity', ctx, {
    kpis: [
      kpi('Citas', total, { hint: `${String(atendidas)} atendidas` }),
      kpi('Odontólogos', ordenadas.length, {
        hint: ordenadas.length === 0 ? null : `más productivo: ${masProductivo?.label ?? '—'}`,
      }),
      kpi('Asistencia', porcentaje(atendidas, total), {
        unit: '%',
        hint: `${String(atendidas)} citas atendidas`,
        tone: 'good',
      }),
      kpi('Inasistencias', porcentaje(inasistencias, total), {
        unit: '%',
        hint: `${String(inasistencias)} citas`,
        tone: inasistencias > 0 ? 'warn' : 'neutral',
      }),
    ],
    series: [
      serie('odontologos', 'Citas por odontólogo', 'bar', puntos, {
        xLabel: 'odontólogo',
        yLabel: 'citas',
      }),
    ],
    table: tabla(
      [
        columna('odontologo', 'Odontólogo'),
        columna('citas', 'Citas', 'number'),
        columna('atendidas', 'Atendidas', 'number'),
        columna('inasistencias', 'Inasistencias', 'number'),
        columna('canceladas', 'Canceladas', 'number'),
        columna('tasaAsistencia', 'Asistencia', 'percent'),
        columna('particion', 'Participación', 'percent'),
      ],
      filasTabla,
    ),
    notes,
  });
};

export const buildDentistProductivityReport = async (
  deps: ReportDeps,
  ctx: ReportContext,
): Promise<ReportDocument> => {
  const label = sql<string>`coalesce(${factAppointment.dentistName}, ${SIN_ODONTOLOGO})`;
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

  return componerProductividadOdontologos(filas, ctx);
};
