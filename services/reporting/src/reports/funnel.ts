import type { ReportDocument, ReportGranularity, ReportRow } from '@odontocrm/contracts';
import { and, eq, sql } from 'drizzle-orm';

import { dimPatient, factAppointment, factRequest } from '../db/schema.js';
import { mvFunnel } from '../db/views.js';
import {
  columna,
  condicionesDePaciente,
  diaTexto,
  documento,
  enRango,
  etiquetaDePeriodo,
  hayFiltrosDePaciente,
  kpi,
  notaDeFiltros,
  periodosDelRango,
  periodoDe,
  porcentaje,
  punto,
  serie,
  sinDatos,
  tabla,
  tasaInasistencia,
  type ReportContext,
  type ReportDeps,
} from './shared.js';

/**
 * Reporte del **embudo** y de la tasa de inasistencia (plan §13, Fase 9):
 * solicitudes → programadas → notificadas → atendidas, con la inasistencia al lado.
 *
 * La fecha de cada etapa es la que le toca:
 *  - **solicitudes** por su fecha de solicitud (`fact_request.requested_at`);
 *  - **citas** (programadas, notificadas, atendidas e inasistencias) por la fecha de
 *    la cita (`fact_appointment.appointment_date`).
 *
 * Así el embudo de una semana se lee de arriba abajo sin que una cita pedida en
 * septiembre y atendida en octubre descuadre las dos semanas.
 */

/** Una fila por día: es la forma que devuelven la vista materializada y las tablas. */
export interface FilaDiaEmbudo {
  day: string;
  requests: number;
  scheduled: number;
  notified: number;
  attended: number;
  noShow: number;
  cancelled: number;
}

export interface TotalesEmbudo {
  solicitudes: number;
  programadas: number;
  notificadas: number;
  atendidas: number;
  inasistencias: number;
  canceladas: number;
}

const vacio = (): TotalesEmbudo => ({
  solicitudes: 0,
  programadas: 0,
  notificadas: 0,
  atendidas: 0,
  inasistencias: 0,
  canceladas: 0,
});

const sumarFila = (totales: TotalesEmbudo, fila: FilaDiaEmbudo): TotalesEmbudo => ({
  solicitudes: totales.solicitudes + fila.requests,
  programadas: totales.programadas + fila.scheduled,
  notificadas: totales.notificadas + fila.notified,
  atendidas: totales.atendidas + fila.attended,
  inasistencias: totales.inasistencias + fila.noShow,
  canceladas: totales.canceladas + fila.cancelled,
});

/** Agrupa los días en períodos (día, semana o mes) sumando cada etapa. */
export const agruparEmbudo = (
  filas: readonly FilaDiaEmbudo[],
  granularidad: ReportGranularity,
): Map<string, TotalesEmbudo> => {
  const porPeriodo = new Map<string, TotalesEmbudo>();
  for (const fila of filas) {
    const periodo = periodoDe(fila.day, granularidad);
    porPeriodo.set(periodo, sumarFila(porPeriodo.get(periodo) ?? vacio(), fila));
  }
  return porPeriodo;
};

export const totalesDe = (filas: readonly FilaDiaEmbudo[]): TotalesEmbudo =>
  filas.reduce(sumarFila, vacio());

/**
 * Compone el documento desde las filas por día. Es **pura** a propósito: la parte
 * que puede estar mal (agrupar, sumar, calcular tasas y ordenar) se prueba sin base
 * de datos.
 */
export const componerEmbudo = (
  filas: readonly FilaDiaEmbudo[],
  ctx: ReportContext,
): ReportDocument => {
  const granularidad = ctx.filters.granularity;
  const porPeriodo = agruparEmbudo(filas, granularidad);
  const totales = totalesDe(filas);

  // Los períodos sin actividad salen con ceros: una semana sin citas es un dato, no
  // un hueco en la gráfica.
  const periodos = periodosDelRango(ctx.range, granularidad);
  const medidas: readonly { clave: keyof TotalesEmbudo; etiqueta: string }[] = [
    { clave: 'solicitudes', etiqueta: 'solicitudes' },
    { clave: 'programadas', etiqueta: 'programadas' },
    { clave: 'notificadas', etiqueta: 'notificadas' },
    { clave: 'atendidas', etiqueta: 'atendidas' },
  ];

  const puntos = periodos.flatMap((periodo) => {
    const delPeriodo = porPeriodo.get(periodo) ?? vacio();
    return medidas.map((medida) =>
      punto(etiquetaDePeriodo(periodo, granularidad), delPeriodo[medida.clave], medida.etiqueta),
    );
  });

  const puntosTasa = periodos.map((periodo) => {
    const delPeriodo = porPeriodo.get(periodo) ?? vacio();
    return punto(
      etiquetaDePeriodo(periodo, granularidad),
      tasaInasistencia(delPeriodo.atendidas, delPeriodo.inasistencias),
    );
  });

  const filasTabla: ReportRow[] = periodos.map((periodo) => {
    const delPeriodo = porPeriodo.get(periodo) ?? vacio();
    return {
      periodo: etiquetaDePeriodo(periodo, granularidad),
      solicitudes: delPeriodo.solicitudes,
      programadas: delPeriodo.programadas,
      notificadas: delPeriodo.notificadas,
      atendidas: delPeriodo.atendidas,
      inasistencias: delPeriodo.inasistencias,
      canceladas: delPeriodo.canceladas,
      tasa: tasaInasistencia(delPeriodo.atendidas, delPeriodo.inasistencias),
    };
  });

  const tasa = tasaInasistencia(totales.atendidas, totales.inasistencias);
  const notes: string[] = [];
  const filtros = notaDeFiltros(ctx.filters, ctx.range.to);
  if (filtros !== null) notes.push(filtros);
  if (filas.length === 0) notes.push(sinDatos(ctx));
  notes.push(
    'Las solicitudes se cuentan por su fecha de solicitud y las citas por la fecha de la cita.',
  );
  if (totales.inasistencias > 0) {
    notes.push(
      `La tasa de inasistencia es inasistencias sobre las citas que debían ocurrir (atendidas + inasistencias): ${String(totales.inasistencias)} de ${String(totales.atendidas + totales.inasistencias)}.`,
    );
  }

  return documento('funnel', ctx, {
    kpis: [
      kpi('Solicitudes', totales.solicitudes, { hint: 'tickets recibidos en el período' }),
      kpi('Citas programadas', totales.programadas, {
        hint: `${String(totales.canceladas)} canceladas o reprogramadas`,
      }),
      kpi('Avisadas al paciente', totales.notificadas),
      kpi('Atendidas', totales.atendidas, { tone: totales.atendidas > 0 ? 'good' : 'neutral' }),
      kpi('Conseguir cita', porcentaje(totales.programadas, totales.solicitudes), {
        unit: '%',
        hint: 'solicitudes que terminaron con cita',
      }),
      kpi('Tasa de inasistencia', tasa, {
        unit: '%',
        hint: `${String(totales.inasistencias)} inasistencias`,
        tone: tasa >= 15 ? 'bad' : tasa > 0 ? 'warn' : 'good',
      }),
    ],
    series: [
      serie('embudo', 'Embudo por período', 'bar', puntos, {
        xLabel: 'período',
        yLabel: 'cantidad',
      }),
      serie('inasistencia', 'Tasa de inasistencia por período', 'line', puntosTasa, {
        xLabel: 'período',
        yLabel: '%',
      }),
    ],
    table: tabla(
      [
        columna('periodo', 'Período'),
        columna('solicitudes', 'Solicitudes', 'number'),
        columna('programadas', 'Programadas', 'number'),
        columna('notificadas', 'Avisadas', 'number'),
        columna('atendidas', 'Atendidas', 'number'),
        columna('inasistencias', 'Inasistencias', 'number'),
        columna('canceladas', 'Canceladas', 'number'),
        columna('tasa', 'Tasa de inasistencia', 'percent'),
      ],
      filasTabla,
    ),
    notes,
  });
};

/* ── Proyección ────────────────────────────────────────────────────────────── */

/**
 * Días desde la **vista materializada** (pre-agregada y ya refrescada). Solo sirve
 * cuando no hay filtros de paciente: la vista no tiene esa dimensión.
 */
const proyectarDesdeVista = async (
  deps: ReportDeps,
  ctx: ReportContext,
): Promise<FilaDiaEmbudo[]> => {
  const filas = await deps.db
    .select({
      day: diaTexto(mvFunnel.day),
      requests: mvFunnel.requests,
      scheduled: mvFunnel.scheduled,
      notified: mvFunnel.notified,
      attended: mvFunnel.attended,
      noShow: mvFunnel.noShow,
      cancelled: mvFunnel.cancelled,
    })
    .from(mvFunnel)
    .where(enRango(mvFunnel.day, ctx.range));
  return filas;
};

/**
 * Días calculados en vivo desde los hechos, cruzando `dim_patient` para que los
 * filtros de edad, sexo y estado se combinen de verdad.
 */
const proyectarDesdeHechos = async (
  deps: ReportDeps,
  ctx: ReportContext,
): Promise<FilaDiaEmbudo[]> => {
  const condiciones = condicionesDePaciente(ctx.filters, ctx.range.to);
  const solicitudEn = sql`${factRequest.requestedAt}::date`;

  const citas = deps.db
    .select({
      day: diaTexto(factAppointment.appointmentDate),
      scheduled: sql<number>`count(*)::int`,
      notified: sql<number>`(count(*) filter (where ${factAppointment.notifiedAt} is not null))::int`,
      attended: sql<number>`(count(*) filter (where ${factAppointment.status} = 'atendido'))::int`,
      noShow: sql<number>`(count(*) filter (where ${factAppointment.status} = 'no_asistio'))::int`,
      cancelled: sql<number>`(count(*) filter (where ${factAppointment.status} in ('cancelada', 'reprogramada')))::int`,
    })
    .from(factAppointment)
    .leftJoin(dimPatient, eq(dimPatient.patientId, factAppointment.patientId))
    .where(and(enRango(factAppointment.appointmentDate, ctx.range), ...condiciones))
    .groupBy(factAppointment.appointmentDate);

  const solicitudes = deps.db
    .select({
      day: diaTexto(solicitudEn),
      requests: sql<number>`count(*)::int`,
    })
    .from(factRequest)
    .leftJoin(dimPatient, eq(dimPatient.patientId, factRequest.patientId))
    .where(and(enRango(solicitudEn, ctx.range), ...condiciones))
    // Por posición: `requested_at::date` repetido en el `group by` llevaría otro
    // parámetro y PostgreSQL no lo vería como la misma expresión.
    .groupBy(sql`1`);

  const [filasCitas, filasSolicitudes] = await Promise.all([citas, solicitudes]);

  // Los dos hechos se juntan por día en memoria: son como mucho los días del rango
  // (1.095 con el tope del contrato) y una consulta por día no tendría sentido.
  const porDia = new Map<string, FilaDiaEmbudo>();
  const dia = (day: string): FilaDiaEmbudo => {
    const existente = porDia.get(day) ?? {
      day,
      requests: 0,
      scheduled: 0,
      notified: 0,
      attended: 0,
      noShow: 0,
      cancelled: 0,
    };
    porDia.set(day, existente);
    return existente;
  };

  for (const fila of filasSolicitudes) dia(fila.day).requests += fila.requests;
  for (const fila of filasCitas) {
    const acumulado = dia(fila.day);
    acumulado.scheduled += fila.scheduled;
    acumulado.notified += fila.notified;
    acumulado.attended += fila.attended;
    acumulado.noShow += fila.noShow;
    acumulado.cancelled += fila.cancelled;
  }

  return [...porDia.values()].sort((izquierda, derecha) =>
    izquierda.day.localeCompare(derecha.day),
  );
};

export const buildFunnelReport = async (
  deps: ReportDeps,
  ctx: ReportContext,
): Promise<ReportDocument> => {
  const filas = hayFiltrosDePaciente(ctx.filters)
    ? await proyectarDesdeHechos(deps, ctx)
    : await proyectarDesdeVista(deps, ctx);
  return componerEmbudo(filas, ctx);
};
