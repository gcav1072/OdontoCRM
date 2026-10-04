import type { ReportDocument, ReportRow } from '@odontocrm/contracts';
import { and, eq, sql } from 'drizzle-orm';

import { dimDayCapacity, dimPatient, factAppointment } from '../db/schema.js';
import { mvDailyKpis } from '../db/views.js';
import {
  columna,
  condicionesDePaciente,
  diasDelRango,
  diaTexto,
  documento,
  enRango,
  hayFiltrosDePaciente,
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
 * Reporte de **ocupación de la agenda** (plan §13, Fase 9): cupo usado y disponible
 * por día, más las horas pico.
 *
 * El cupo es el **explícito** (`dim_day_capacity`): el que la secretaría fija a mano.
 * Cuando nadie lo ha fijado queda `null` y el día se cuenta sin cupo —la agenda lo
 * deduce de sus plantillas de franjas, pero ese dato no viaja en ningún evento y el
 * read model no lo inventa—. Los días así se avisan en las notas.
 *
 * «Asignadas» son las citas que **ocupan** el día (el mismo criterio que la agenda:
 * las canceladas y las reprogramadas liberan su hueco), y la ocupación es asignadas
 * sobre cupo.
 */

export interface FilaDiaCapacidad {
  day: string;
  capacity: number | null;
  assigned: number;
  attended: number;
  noShow: number;
}

export interface HoraPico {
  /** `HH:00`, la hora de inicio de la cita. */
  hour: string;
  citas: number;
}

/**
 * Compone el documento. **Pura**: el cálculo de la ocupación, la detección del día
 * de mayor demanda y de la hora pico se prueban sin base de datos.
 */
export const componerCapacidad = (
  filas: readonly FilaDiaCapacidad[],
  horas: readonly HoraPico[],
  ctx: ReportContext,
): ReportDocument => {
  const porDia = new Map(filas.map((fila) => [fila.day, fila]));
  const fechas = diasDelRango(ctx.range);
  const conDatos = fechas
    .map((day) => porDia.get(day))
    .filter((fila): fila is FilaDiaCapacidad => fila !== undefined);

  // El cupo **efectivo** del día: el explícito o, si nadie lo fijó a mano, sus citas
  // asignadas. El cupo real de la agenda sale de sus plantillas de franjas (o del
  // cupo por defecto) y eso **no viaja en ningún evento**, así que el read model no
  // puede conocerlo: se usa la cita asignada como suelo y se avisa en las notas. Sin
  // esto, el tablero mostraría «cupo 0, libres 0» en un día con pacientes citados.
  const cupoDe = (fila: FilaDiaCapacidad): number => fila.capacity ?? fila.assigned;

  const cupoTotal = conDatos.reduce((total, fila) => total + cupoDe(fila), 0);
  const asignadas = conDatos.reduce((total, fila) => total + fila.assigned, 0);
  const atendidas = conDatos.reduce((total, fila) => total + fila.attended, 0);
  const inasistencias = conDatos.reduce((total, fila) => total + fila.noShow, 0);
  const diasConCupo = conDatos.filter((fila) => fila.capacity !== null).length;

  const ocupacion = porcentaje(asignadas, cupoTotal);
  const diaPico = conDatos.reduce<FilaDiaCapacidad | null>(
    (mayor, fila) => (mayor === null || fila.assigned > mayor.assigned ? fila : mayor),
    null,
  );
  const horaPico = horas.reduce<HoraPico | null>(
    (mayor, hora) => (mayor === null || hora.citas > mayor.citas ? hora : mayor),
    null,
  );
  const diasCompletos = conDatos.filter(
    (fila) => fila.capacity !== null && fila.assigned >= fila.capacity,
  ).length;

  // Los días del rango salen todos (con ceros los que no tienen actividad): un
  // hueco en la gráfica se lee como «faltan datos», y no es eso.
  const puntosCitas = fechas.flatMap((day) => {
    const fila = porDia.get(day);
    return [
      punto(day, fila?.assigned ?? 0, 'asignadas'),
      punto(day, fila?.attended ?? 0, 'atendidas'),
      punto(day, fila?.noShow ?? 0, 'inasistencias'),
    ];
  });

  // La ocupación solo se dibuja donde el cupo es **conocido**: inventar un 100 % en
  // los días sin cupo fijado haría creer que el día está lleno.
  const puntosOcupacion = fechas.flatMap((day) => {
    const fila = porDia.get(day);
    return fila === undefined || fila.capacity === null
      ? []
      : [punto(day, porcentaje(fila.assigned, fila.capacity))];
  });

  const filasTabla: ReportRow[] = fechas.map((day) => {
    const fila = porDia.get(day);
    const cupo = fila?.capacity ?? null;
    return {
      fecha: day,
      cupo,
      asignadas: fila?.assigned ?? 0,
      atendidas: fila?.attended ?? 0,
      inasistencias: fila?.noShow ?? 0,
      disponibles: cupo === null ? null : Math.max(0, cupo - (fila?.assigned ?? 0)),
      ocupacion: fila === undefined || cupo === null ? null : porcentaje(fila.assigned, cupo),
    };
  });

  const notes: string[] = [];
  const filtros = notaDeFiltros(ctx.filters, ctx.range.to);
  if (filtros !== null) notes.push(filtros);
  if (conDatos.length === 0) notes.push(sinDatos(ctx));
  const sinCupo = conDatos.filter((fila) => fila.capacity === null).length;
  if (sinCupo > 0) {
    notes.push(
      `${String(sinCupo)} de los ${String(conDatos.length)} días con actividad no tienen cupo fijado a mano: el cupo efectivo lo deduce la agenda de sus plantillas de franjas y no viaja en los eventos, así que en las cifras se cuentan con sus citas asignadas y en el detalle salen sin cupo ni ocupación.`,
    );
  }
  notes.push(
    'Las citas canceladas y las reprogramadas liberan su hueco y no cuentan como asignadas.',
  );

  return documento('capacity', ctx, {
    kpis: [
      kpi('Citas asignadas', asignadas, { hint: `${String(atendidas)} atendidas` }),
      kpi('Cupo del período', cupoTotal, {
        hint: `${String(diasConCupo)} días con cupo fijado a mano`,
      }),
      kpi('Ocupación', ocupacion, {
        unit: '%',
        hint: 'asignadas sobre el cupo conocido',
        tone: ocupacion >= 90 ? 'bad' : ocupacion >= 70 ? 'warn' : 'good',
      }),
      kpi('Días completos', diasCompletos, {
        hint: 'días con el cupo lleno o sobrepasado',
        tone: diasCompletos > 0 ? 'warn' : 'neutral',
      }),
      kpi('Día de mayor demanda', diaPico?.day ?? '—', {
        hint: diaPico === null ? null : `${String(diaPico.assigned)} citas`,
      }),
      kpi('Hora pico', horaPico?.hour ?? '—', {
        hint: horaPico === null ? null : `${String(horaPico.citas)} citas empiezan a esa hora`,
      }),
      kpi('Inasistencias', inasistencias, {
        tone: inasistencias > 0 ? 'bad' : 'good',
      }),
    ],
    series: [
      serie('citas', 'Citas por día', 'stacked-bar', puntosCitas, {
        xLabel: 'día',
        yLabel: 'citas',
      }),
      serie('ocupacion', 'Ocupación por día', 'line', puntosOcupacion, {
        xLabel: 'día',
        yLabel: '%',
      }),
    ],
    table: tabla(
      [
        columna('fecha', 'Día', 'date'),
        columna('cupo', 'Cupo', 'number'),
        columna('asignadas', 'Asignadas', 'number'),
        columna('atendidas', 'Atendidas', 'number'),
        columna('inasistencias', 'Inasistencias', 'number'),
        columna('disponibles', 'Disponibles', 'number'),
        columna('ocupacion', 'Ocupación', 'percent'),
      ],
      filasTabla,
    ),
    notes,
  });
};

/* ── Proyección ────────────────────────────────────────────────────────────── */

/** Días desde la vista materializada del tablero (sin filtros de paciente). */
const proyectarDesdeVista = async (
  deps: ReportDeps,
  ctx: ReportContext,
): Promise<FilaDiaCapacidad[]> => {
  const filas = await deps.db
    .select({
      day: diaTexto(mvDailyKpis.day),
      capacity: mvDailyKpis.capacity,
      assigned: mvDailyKpis.assigned,
      attended: mvDailyKpis.attended,
      noShow: mvDailyKpis.noShow,
    })
    .from(mvDailyKpis)
    .where(enRango(mvDailyKpis.day, ctx.range));
  return filas;
};

/**
 * Días calculados en vivo: el cupo sale de `dim_day_capacity` (no depende del
 * paciente) y las citas se cruzan con `dim_patient` para combinar los filtros.
 */
const proyectarDesdeHechos = async (
  deps: ReportDeps,
  ctx: ReportContext,
): Promise<FilaDiaCapacidad[]> => {
  const condiciones = condicionesDePaciente(ctx.filters, ctx.range.to);

  const cupos = deps.db
    .select({
      day: diaTexto(dimDayCapacity.date),
      capacity: dimDayCapacity.capacity,
    })
    .from(dimDayCapacity)
    .where(enRango(dimDayCapacity.date, ctx.range));

  const citas = deps.db
    .select({
      day: diaTexto(factAppointment.appointmentDate),
      assigned: sql<number>`(count(*) filter (where ${factAppointment.status} in ('programada', 'notificada', 'en_sala_espera', 'llamado', 'en_consulta', 'atendido', 'no_asistio')))::int`,
      attended: sql<number>`(count(*) filter (where ${factAppointment.status} = 'atendido'))::int`,
      noShow: sql<number>`(count(*) filter (where ${factAppointment.status} = 'no_asistio'))::int`,
    })
    .from(factAppointment)
    .leftJoin(dimPatient, eq(dimPatient.patientId, factAppointment.patientId))
    .where(and(enRango(factAppointment.appointmentDate, ctx.range), ...condiciones))
    .groupBy(factAppointment.appointmentDate);

  const [filasCupos, filasCitas] = await Promise.all([cupos, citas]);

  const porDia = new Map<string, FilaDiaCapacidad>();
  for (const fila of filasCupos) {
    porDia.set(fila.day, {
      day: fila.day,
      capacity: fila.capacity,
      assigned: 0,
      attended: 0,
      noShow: 0,
    });
  }
  for (const fila of filasCitas) {
    const existente = porDia.get(fila.day) ?? {
      day: fila.day,
      capacity: null,
      assigned: 0,
      attended: 0,
      noShow: 0,
    };
    existente.assigned = fila.assigned;
    existente.attended = fila.attended;
    existente.noShow = fila.noShow;
    porDia.set(fila.day, existente);
  }

  return [...porDia.values()].sort((izquierda, derecha) =>
    izquierda.day.localeCompare(derecha.day),
  );
};

/** Histograma de horas de inicio: es lo que detecta la hora pico. */
const proyectarHoras = async (deps: ReportDeps, ctx: ReportContext): Promise<HoraPico[]> => {
  const hora = sql<string>`substring(${factAppointment.startTime} from 1 for 2) || ':00'`;
  const filas = await deps.db
    .select({ hour: hora, citas: sql<number>`count(*)::int` })
    .from(factAppointment)
    .leftJoin(dimPatient, eq(dimPatient.patientId, factAppointment.patientId))
    .where(
      and(
        enRango(factAppointment.appointmentDate, ctx.range),
        sql`${factAppointment.status} <> 'cancelada'`,
        ...condicionesDePaciente(ctx.filters, ctx.range.to),
      ),
    )
    // Por posición, por lo mismo que en el embudo: la expresión repetida cambia de
    // parámetro y PostgreSQL no la reconocería.
    .groupBy(sql`1`)
    .orderBy(sql`1`);
  return filas;
};

export const buildCapacityReport = async (
  deps: ReportDeps,
  ctx: ReportContext,
): Promise<ReportDocument> => {
  const [filas, horas] = await Promise.all([
    hayFiltrosDePaciente(ctx.filters)
      ? proyectarDesdeHechos(deps, ctx)
      : proyectarDesdeVista(deps, ctx),
    proyectarHoras(deps, ctx),
  ]);
  return componerCapacidad(filas, horas, ctx);
};
