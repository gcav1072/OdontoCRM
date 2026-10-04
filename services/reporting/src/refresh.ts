import { sql, type SQL } from 'drizzle-orm';

import type { ReportingDb } from './db/client.js';
import { reportRefreshes } from './db/schema.js';
import { MATERIALIZED_VIEWS, type MaterializedView } from './db/views.js';

/**
 * Refresco de las vistas materializadas y su traza en `report_refreshes`.
 *
 * Se usa `REFRESH MATERIALIZED VIEW` **normal**, no `CONCURRENTLY`: el normal es
 * transaccional y atómico, así que una vista nunca queda a medio poblar. El
 * `CONCURRENTLY` no bloquea a quien lee, pero si falla a mitad deja la vista
 * ilegible («materialized view has not been populated») y el tablero se cae entero.
 * Los índices únicos de cada vista ya están puestos para poder cambiarlo el día que
 * el bloqueo moleste de verdad.
 *
 * Las sentencias van escritas una a una (nada de SQL armado con el nombre de la
 * vista) porque el proyecto prohíbe construir SQL por concatenación.
 */
const REFRESH_SQL: Readonly<Record<MaterializedView, SQL>> = {
  mv_daily_kpis: sql`refresh materialized view "mv_daily_kpis"`,
  mv_funnel: sql`refresh materialized view "mv_funnel"`,
  mv_demographics: sql`refresh materialized view "mv_demographics"`,
  mv_oral_health: sql`refresh materialized view "mv_oral_health"`,
  mv_prescriptions: sql`refresh materialized view "mv_prescriptions"`,
};

/** Quién pidió el refresco: un lote de eventos, el job nocturno o la ruta interna. */
export const REFRESH_TRIGGERS = ['evento', 'nocturno', 'manual'] as const;
export type RefreshTrigger = (typeof REFRESH_TRIGGERS)[number];

export interface RefreshResult {
  ok: boolean;
  views: MaterializedView[];
  error: string | null;
  startedAt: string;
  finishedAt: string;
}

/**
 * Refresca las vistas indicadas (todas, si no se dice otra cosa) y deja la fila de
 * traza. **No lanza**: el fallo se registra con `ok = false` y se devuelve, para que
 * un refresco que no cuaja no tire abajo el lote de eventos que ya está aplicado (los
 * hechos están escritos; lo único que queda viejo es la foto pre-agregada).
 */
export const refreshMaterializedViews = async (
  db: ReportingDb,
  options: { views?: readonly MaterializedView[]; trigger: RefreshTrigger },
): Promise<RefreshResult> => {
  const views = options.views ?? MATERIALIZED_VIEWS;
  const startedAt = new Date().toISOString();
  let error: string | null = null;

  for (const view of views) {
    try {
      await db.execute(REFRESH_SQL[view]);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
      break;
    }
  }

  const finishedAt = new Date().toISOString();
  await db
    .insert(reportRefreshes)
    .values({
      startedAt: new Date(startedAt),
      finishedAt: new Date(finishedAt),
      trigger: options.trigger,
      views: views.length,
      ok: error === null,
      error,
    })
    .catch(() => undefined);

  return { ok: error === null, views: [...views], error, startedAt, finishedAt };
};

/**
 * Milisegundos que faltan para la próxima vez que sean las `hour` en punto, en la
 * zona horaria del proceso (`TZ`, que en el consultorio es `America/Caracas`).
 *
 * Se calcula cada vez en vez de usar un `setInterval` de 24 h: un intervalo fijo se
 * desvía con los cambios de hora y con los reinicios del servicio.
 */
export const msUntilNextHour = (hour: number, now: Date = new Date()): number => {
  const proxima = new Date(now);
  proxima.setHours(hour, 0, 0, 0);
  if (proxima.getTime() <= now.getTime()) proxima.setDate(proxima.getDate() + 1);
  return proxima.getTime() - now.getTime();
};

export interface NightlyRefresh {
  /** Programa el próximo refresco (idempotente: llamarlo dos veces no duplica). */
  start: () => void;
  stop: () => void;
}

/**
 * Job nocturno: a la hora configurada refresca **todas** las vistas y se vuelve a
 * programar para el día siguiente. Existe porque los eventos no cuentan todo lo que
 * cambia con el tiempo: la pirámide de edad, por ejemplo, envejece sola.
 */
export const scheduleNightlyRefresh = (options: {
  hour: number;
  run: () => Promise<unknown>;
  onError?: (error: unknown) => void;
}): NightlyRefresh => {
  let timer: NodeJS.Timeout | undefined;

  const programar = (): void => {
    timer = setTimeout(() => {
      timer = undefined;
      void options
        .run()
        .catch((error: unknown) => options.onError?.(error))
        .finally(programar);
    }, msUntilNextHour(options.hour));
    // El temporizador no debe mantener vivo el proceso por sí solo.
    timer.unref?.();
  };

  return {
    start: () => {
      if (timer === undefined) programar();
    },
    stop: () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
};
