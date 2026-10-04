import {
  resolveReportRange,
  type ReportDocument,
  type ReportFilters,
  type ReportKey,
  type ReportRange,
  type ReportSummary,
} from '@odontocrm/contracts';
import { desc, eq, sql } from 'drizzle-orm';

import { dimPatient, reportRefreshes } from '../db/schema.js';
import { mvDailyKpis } from '../db/views.js';
import { buildCapacityReport } from './capacity.js';
import { buildClinicalProfileReport } from './clinical-profile.js';
import { buildDemographicsReport } from './demographics.js';
import { buildFunnelReport } from './funnel.js';
import { buildOralHealthReport } from './oral-health.js';
import { buildPrescriptionsReport } from './prescriptions.js';
import { type ReportContext, type ReportDeps } from './shared.js';

/**
 * Catálogo de reportes servido por el servicio: una función por clave del contrato.
 * Añadir un reporte es añadirlo también a `REPORT_KEYS` (el catálogo es cerrado).
 */
const CONSTRUCTORES: Readonly<
  Record<ReportKey, (deps: ReportDeps, ctx: ReportContext) => Promise<ReportDocument>>
> = {
  funnel: buildFunnelReport,
  capacity: buildCapacityReport,
  demographics: buildDemographicsReport,
  'clinical-profile': buildClinicalProfileReport,
  'oral-health': buildOralHealthReport,
  prescriptions: buildPrescriptionsReport,
};

export const buildReportDocument = async (
  key: ReportKey,
  deps: ReportDeps,
  ctx: ReportContext,
): Promise<ReportDocument> => CONSTRUCTORES[key](deps, ctx);

/**
 * Fecha de hoy (`aaaa-mm-dd`) en la zona del consultorio (`TZ`). Se arma con las
 * partes del formateador y no con `toISOString()`: a las 8 de la noche en Caracas ya
 * es «mañana» en UTC, y el rango por defecto del reporte tiene que terminar hoy
 * donde está la clínica.
 */
export const hoyEnElConsultorio = (zona: string, ahora: Date = new Date()): string => {
  let anio = '';
  let mes = '';
  let dia = '';
  for (const parte of new Intl.DateTimeFormat('en-CA', {
    timeZone: zona,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(ahora)) {
    if (parte.type === 'year') anio = parte.value;
    else if (parte.type === 'month') mes = parte.value;
    else if (parte.type === 'day') dia = parte.value;
  }
  return `${anio}-${mes}-${dia}`;
};

/**
 * Resuelve el rango del reporte. El contrato lanza un `Error` normal cuando el rango
 * está invertido o pasa del tope de días; la ruta lo convierte en un 400 con el
 * mensaje del contrato (aquí solo se propaga).
 */
export const rangoDeFiltros = (filters: ReportFilters, hoy: string): ReportRange =>
  resolveReportRange(filters, hoy);

/* ── Tablero del día ───────────────────────────────────────────────────────── */

interface ConteoDePacientes {
  active: number;
  waiting: number;
  newThisMonth: number;
}

const contarPacientes = async (deps: ReportDeps, hoy: string): Promise<ConteoDePacientes> => {
  const filas = await deps.db
    .select({
      active: sql<number>`(count(*) filter (where ${dimPatient.status} = 'activo'))::int`,
      waiting: sql<number>`(count(*) filter (where ${dimPatient.status} = 'en_espera_cita'))::int`,
      newThisMonth: sql<number>`(count(*) filter (where ${dimPatient.createdAt} >= date_trunc('month', ${hoy}::date)))::int`,
    })
    .from(dimPatient)
    .where(sql`${dimPatient.deletedAt} is null`);
  return filas[0] ?? { active: 0, waiting: 0, newThisMonth: 0 };
};

const ultimoRefresco = async (deps: ReportDeps): Promise<string | null> => {
  const filas = await deps.db
    .select({ finishedAt: reportRefreshes.finishedAt })
    .from(reportRefreshes)
    .where(eq(reportRefreshes.ok, true))
    .orderBy(desc(reportRefreshes.startedAt))
    .limit(1);
  return filas[0]?.finishedAt?.toISOString() ?? null;
};

/**
 * Tablero del día: sale de `mv_daily_kpis` (una fila por día, ya pre-agregada) más el
 * conteo de pacientes de `dim_patient`. Es lo primero que se pinta al abrir
 * `/reportes` y no depende de los filtros.
 */
export const buildReportSummary = async (
  deps: ReportDeps,
  hoy: string,
  generatedAt: string = new Date().toISOString(),
): Promise<ReportSummary> => {
  const [dias, pacientes, refreshedAt] = await Promise.all([
    deps.db
      .select({
        capacity: mvDailyKpis.capacity,
        assigned: mvDailyKpis.assigned,
        scheduled: mvDailyKpis.scheduled,
        attended: mvDailyKpis.attended,
        noShow: mvDailyKpis.noShow,
        cancelled: mvDailyKpis.cancelled,
        notificationsSent: mvDailyKpis.notificationsSent,
        notificationsFailed: mvDailyKpis.notificationsFailed,
      })
      .from(mvDailyKpis)
      .where(eq(mvDailyKpis.day, hoy))
      .limit(1),
    contarPacientes(deps, hoy),
    ultimoRefresco(deps),
  ]);

  const dia = dias[0] ?? null;
  const assigned = dia?.assigned ?? 0;
  const scheduled = dia?.scheduled ?? 0;
  const attended = dia?.attended ?? 0;
  const noShow = dia?.noShow ?? 0;
  const cancelled = dia?.cancelled ?? 0;
  // El cupo del día: el explícito o, si nadie lo fijó a mano, las citas asignadas.
  // El cupo efectivo de la agenda (plantilla de franjas o cupo por defecto) no viaja
  // en ningún evento, así que sin este suelo el tablero diría «cupo 0, libres 0» en
  // un día con pacientes citados.
  const capacity = dia?.capacity ?? assigned;

  return {
    date: hoy,
    generatedAt,
    appointments: {
      scheduled,
      attended,
      noShow,
      // Pendientes: las que siguen en pie y todavía no tienen desenlace.
      pending: Math.max(0, scheduled - attended - noShow - cancelled),
      cancelled,
    },
    capacity: {
      capacity,
      assigned,
      freeSlots: Math.max(0, capacity - assigned),
    },
    patients: {
      active: pacientes.active,
      waiting: pacientes.waiting,
      newThisMonth: pacientes.newThisMonth,
    },
    notifications: {
      sent: dia?.notificationsSent ?? 0,
      failed: dia?.notificationsFailed ?? 0,
    },
    refreshedAt,
  };
};
