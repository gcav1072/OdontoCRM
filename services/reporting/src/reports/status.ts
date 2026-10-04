import { desc, sql } from 'drizzle-orm';

import type { ReportingConfig } from '../config.js';
import type { ReportingDb } from '../db/client.js';
import { reportRefreshes } from '../db/schema.js';

/**
 * Estado del read model para la ruta interna de diagnóstico
 * (`GET /internal/v1/reporting/status`): cuántas filas hay en cada tabla y vista,
 * cuándo entró el último evento y cuándo se refrescó por última vez.
 *
 * Sirve para responder «¿por qué este reporte sale vacío?» sin abrir `psql`:
 * normalmente es que el servicio acaba de arrancar y todavía no ha llegado ningún
 * evento, o que el refresco falló (queda dicho en `report_refreshes`).
 */

export interface ReadModelStatus {
  service: 'reporting';
  generatedAt: string;
  refreshHour: number;
  /** Eventos de dominio ya aplicados y hora del último. */
  processedEvents: { total: number; lastProcessedAt: string | null };
  tables: Record<string, number>;
  views: Record<string, number>;
  lastRefresh: {
    startedAt: string;
    finishedAt: string | null;
    trigger: string;
    views: number;
    ok: boolean;
    error: string | null;
  } | null;
}

const TABLAS = [
  'dim_patient',
  'dim_day_capacity',
  'fact_request',
  'fact_appointment',
  'fact_clinical_session',
  'fact_prescription',
  'fact_prescription_item',
  'fact_tooth_finding',
] as const;

const VISTAS = [
  'mv_daily_kpis',
  'mv_funnel',
  'mv_demographics',
  'mv_oral_health',
  'mv_prescriptions',
] as const;

const NOMBRES = [...TABLAS, ...VISTAS];

/**
 * Un `count(*)` por tabla y vista, en **una sola** consulta. Los nombres van como
 * identificadores (`sql.identifier`, que los entrecomilla) y son constantes de este
 * archivo, nunca entrada del usuario.
 */
const contarTodo = async (db: ReportingDb): Promise<Record<string, number>> => {
  const partes = NOMBRES.map(
    (nombre) =>
      sql`(select count(*)::int from ${sql.identifier(nombre)}) as ${sql.identifier(nombre)}`,
  );
  const resultado = await db.execute(sql`select ${sql.join(partes, sql`, `)}`);
  const fila = resultado.rows[0] ?? {};
  return Object.fromEntries(NOMBRES.map((nombre) => [nombre, Number(fila[nombre] ?? 0)]));
};

export const readModelStatus = async (
  db: ReportingDb,
  config: Pick<ReportingConfig, 'REPORTING_REFRESH_HOUR'>,
): Promise<ReadModelStatus> => {
  const [conteos, procesados, refrescos] = await Promise.all([
    contarTodo(db),
    db.execute(
      sql`select count(*)::int as total, max(processed_at) as ultimo from processed_events`,
    ),
    db
      .select({
        startedAt: reportRefreshes.startedAt,
        finishedAt: reportRefreshes.finishedAt,
        trigger: reportRefreshes.trigger,
        views: reportRefreshes.views,
        ok: reportRefreshes.ok,
        error: reportRefreshes.error,
      })
      .from(reportRefreshes)
      .orderBy(desc(reportRefreshes.startedAt))
      .limit(1),
  ]);

  const filaProcesados = procesados.rows[0] ?? {};
  const ultimo = filaProcesados['ultimo'];
  const refresco = refrescos[0] ?? null;

  return {
    service: 'reporting',
    generatedAt: new Date().toISOString(),
    refreshHour: config.REPORTING_REFRESH_HOUR,
    processedEvents: {
      total: Number(filaProcesados['total'] ?? 0),
      lastProcessedAt: ultimo instanceof Date ? ultimo.toISOString() : null,
    },
    tables: Object.fromEntries(TABLAS.map((nombre) => [nombre, conteos[nombre] ?? 0])),
    views: Object.fromEntries(VISTAS.map((nombre) => [nombre, conteos[nombre] ?? 0])),
    lastRefresh:
      refresco === null
        ? null
        : {
            startedAt: refresco.startedAt.toISOString(),
            finishedAt: refresco.finishedAt?.toISOString() ?? null,
            trigger: refresco.trigger,
            views: refresco.views,
            ok: refresco.ok,
            error: refresco.error,
          },
  };
};
