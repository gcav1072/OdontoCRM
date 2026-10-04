import { AGE_BUCKETS, type ReportDocument, type ReportRow } from '@odontocrm/contracts';
import { and, eq, isNull, sql } from 'drizzle-orm';

import { dimPatient } from '../db/schema.js';
import { mvDemographics } from '../db/views.js';
import {
  columna,
  condicionesDePaciente,
  diaTexto,
  documento,
  edadSql,
  etiquetaDeTramo,
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
 * Reporte **demográfico** (plan §13, Fase 9): pirámide de edad por sexo y tabla por
 * tramo, con el rango de edad y el resto de los filtros comunes.
 *
 * **Qué significa el rango de fechas aquí:** cuenta las **altas** del período
 * (`dim_patient.created_at`, la fecha del evento `patients.patient.created`, que se
 * publica en la misma transacción que el alta). La pirámide describe a esos
 * pacientes, con la edad cumplida al último día del rango. Está dicho en las notas
 * del documento para que nadie lea la pirámide como «los pacientes de siempre».
 *
 * Los pacientes **sin fecha de nacimiento** no se pueden clasificar en un tramo: se
 * cuentan aparte (tramo `sin-fecha`) y se avisa, en vez de inventarles una edad.
 */

export interface FilaDemografia {
  day: string;
  bucket: string;
  sex: string;
  status: string;
  patients: number;
}

export const SEXO_DESCONOCIDO = 'O';

/**
 * Compone el documento. **Pura**: la pirámide, los porcentajes y el recuento de los
 * pacientes sin fecha se prueban sin base de datos.
 */
export const componerDemografia = (
  filas: readonly FilaDemografia[],
  ficticios: number,
  ctx: ReportContext,
): ReportDocument => {
  const total = filas.reduce((suma, fila) => suma + fila.patients, 0);
  const sinFecha = filas
    .filter((fila) => fila.bucket === 'sin-fecha')
    .reduce((suma, fila) => suma + fila.patients, 0);
  const conTramo = filas.filter((fila) => fila.bucket !== 'sin-fecha');
  const clasificados = conTramo.reduce((suma, fila) => suma + fila.patients, 0);

  const porTramo = new Map<string, Map<string, number>>();
  for (const fila of conTramo) {
    const porSexo = porTramo.get(fila.bucket) ?? new Map<string, number>();
    porSexo.set(fila.sex, (porSexo.get(fila.sex) ?? 0) + fila.patients);
    porTramo.set(fila.bucket, porSexo);
  }

  const sexos = [...new Set(conTramo.map((fila) => fila.sex))].sort();

  // La pirámide: un punto por tramo y sexo, con el grupo en `M`/`F`/`O` porque la
  // interfaz traduce esos grupos a «Masculino»/«Femenino»/«Otro».
  const puntos = AGE_BUCKETS.flatMap((tramo) => {
    const porSexo = porTramo.get(tramo.key) ?? new Map<string, number>();
    const presentes = sexos.length === 0 ? [SEXO_DESCONOCIDO] : sexos;
    return presentes.map((sexo) => punto(tramo.label, porSexo.get(sexo) ?? 0, sexo));
  });

  const puntosSexo = sexos.map((sexo) =>
    punto(
      sexo,
      conTramo.filter((fila) => fila.sex === sexo).reduce((suma, fila) => suma + fila.patients, 0),
      sexo,
    ),
  );

  const filasTabla: ReportRow[] = AGE_BUCKETS.map((tramo) => {
    const porSexo = porTramo.get(tramo.key) ?? new Map<string, number>();
    const delTramo = [...porSexo.values()].reduce((suma, valor) => suma + valor, 0);
    return {
      tramo: etiquetaDeTramo(tramo.key),
      masculino: porSexo.get('M') ?? 0,
      femenino: porSexo.get('F') ?? 0,
      otro: porSexo.get('O') ?? 0,
      total: delTramo,
      porcentaje: porcentaje(delTramo, clasificados),
    };
  });
  if (sinFecha > 0) {
    filasTabla.push({
      tramo: 'Sin fecha de nacimiento',
      masculino: 0,
      femenino: 0,
      otro: 0,
      total: sinFecha,
      porcentaje: porcentaje(sinFecha, total),
    });
  }

  const menores = conTramo
    .filter((fila) => fila.bucket === '0-12' || fila.bucket === '13-17')
    .reduce((suma, fila) => suma + fila.patients, 0);
  const mayores = conTramo
    .filter((fila) => fila.bucket === '66+')
    .reduce((suma, fila) => suma + fila.patients, 0);
  const femenino = conTramo
    .filter((fila) => fila.sex === 'F')
    .reduce((suma, fila) => suma + fila.patients, 0);

  const notes: string[] = [];
  const filtros = notaDeFiltros(ctx.filters, ctx.range.to);
  if (filtros !== null) notes.push(filtros);
  if (total === 0) notes.push(sinDatos(ctx));
  notes.push(
    `La pirámide es una foto: cuenta los pacientes dados de alta hasta el ${ctx.range.to} y la edad se calcula a esa fecha.`,
  );
  if (sinFecha > 0) {
    notes.push(
      `${String(sinFecha)} paciente(s) no tienen fecha de nacimiento: salen en la tabla como «sin fecha» y quedan fuera de la pirámide.`,
    );
  }
  if (ficticios > 0) {
    notes.push(
      `${String(ficticios)} de los pacientes son del modo test (cédulas 90.000.000+): están incluidos en las cifras.`,
    );
  }

  return documento('demographics', ctx, {
    kpis: [
      kpi('Pacientes', total, {
        hint: `altas hasta el ${ctx.range.to} con los filtros aplicados`,
      }),
      kpi('Menores de 18', porcentaje(menores, clasificados), {
        unit: '%',
        hint: `${String(menores)} pacientes`,
      }),
      kpi('De 66 años o más', porcentaje(mayores, clasificados), {
        unit: '%',
        hint: `${String(mayores)} pacientes`,
      }),
      kpi('Femenino', porcentaje(femenino, clasificados), {
        unit: '%',
        hint: `${String(femenino)} pacientes`,
      }),
      kpi('Sin fecha de nacimiento', sinFecha, {
        tone: sinFecha > 0 ? 'warn' : 'neutral',
      }),
    ],
    series: [
      serie('piramide', 'Pirámide de edad por sexo', 'pyramid', puntos, {
        xLabel: 'tramo de edad',
        yLabel: 'pacientes',
      }),
      serie('sexo', 'Distribución por sexo', 'pie', puntosSexo),
    ],
    table: tabla(
      [
        columna('tramo', 'Tramo de edad'),
        columna('masculino', 'Masculino', 'number'),
        columna('femenino', 'Femenino', 'number'),
        columna('otro', 'Otro', 'number'),
        columna('total', 'Total', 'number'),
        columna('porcentaje', 'Porcentaje', 'percent'),
      ],
      filasTabla,
    ),
    notes,
  });
};

/* ── Proyección ────────────────────────────────────────────────────────────── */

/** Pirámide desde la vista materializada (sin filtros de paciente). */
const proyectarDesdeVista = async (
  deps: ReportDeps,
  ctx: ReportContext,
): Promise<FilaDemografia[]> => {
  const filas = await deps.db
    .select({
      day: diaTexto(mvDemographics.day),
      bucket: mvDemographics.bucket,
      sex: mvDemographics.sex,
      status: mvDemographics.status,
      patients: mvDemographics.patients,
    })
    .from(mvDemographics)
    // Foto acumulada: las altas **hasta** el último día del rango (sin cota
    // inferior), que es lo que hace que la pirámide describa a la población entera.
    .where(sql`${mvDemographics.day} <= ${ctx.range.to}::date`);
  return filas;
};

/** Pirámide calculada en vivo, con la edad al último día del rango. */
const proyectarDesdeHechos = async (
  deps: ReportDeps,
  ctx: ReportContext,
): Promise<FilaDemografia[]> => {
  const bucket = sql<string>`case
    when ${dimPatient.birthDate} is null then 'sin-fecha'
    when ${edadSql(ctx.range.to)} <= 12 then '0-12'
    when ${edadSql(ctx.range.to)} <= 17 then '13-17'
    when ${edadSql(ctx.range.to)} <= 40 then '18-40'
    when ${edadSql(ctx.range.to)} <= 65 then '41-65'
    else '66+'
  end`;
  const sexo = sql<string>`coalesce(${dimPatient.sex}, 'O')`;

  const filas = await deps.db
    .select({
      day: diaTexto(dimPatient.createdAt),
      bucket,
      sex: sexo,
      status: dimPatient.status,
      patients: sql<number>`count(*)::int`,
    })
    .from(dimPatient)
    .where(
      and(
        sql`${dimPatient.createdAt}::date <= ${ctx.range.to}::date`,
        isNull(dimPatient.deletedAt),
        ...condicionesDePaciente(ctx.filters, ctx.range.to),
      ),
    )
    // Agrupación **por posición** (1, 2, 3, 4): PostgreSQL compara las expresiones
    // del `group by` con las del `select` y no las reconocería iguales al repetirlas,
    // porque cada repetición lleva sus propios parámetros (`$1` frente a `$8`).
    .groupBy(sql`1, 2, 3, 4`);
  return filas;
};

/** Pacientes del modo test con alta hasta la fecha final (se avisa en las notas). */
const contarFicticios = async (deps: ReportDeps, ctx: ReportContext): Promise<number> => {
  const filas = await deps.db
    .select({ total: sql<number>`count(*)::int` })
    .from(dimPatient)
    .where(
      and(
        sql`${dimPatient.createdAt}::date <= ${ctx.range.to}::date`,
        isNull(dimPatient.deletedAt),
        eq(dimPatient.isFictitious, true),
      ),
    );
  return filas[0]?.total ?? 0;
};

export const buildDemographicsReport = async (
  deps: ReportDeps,
  ctx: ReportContext,
): Promise<ReportDocument> => {
  const [filas, ficticios] = await Promise.all([
    hayFiltrosDePaciente(ctx.filters)
      ? proyectarDesdeHechos(deps, ctx)
      : proyectarDesdeVista(deps, ctx),
    contarFicticios(deps, ctx),
  ]);
  return componerDemografia(filas, ficticios, ctx);
};
