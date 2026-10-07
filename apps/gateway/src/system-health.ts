import type {
  HealthCheckResult,
  HealthReport,
  HealthStatus,
  SystemHealthReport,
  SystemHealthService,
} from '@odontocrm/contracts';

import { upstreamsOf } from './upstreams.js';
import type { GatewayConfig } from './config.js';

/** Tope de cada consulta: el panel tiene que contestar rápido aunque un servicio esté caído. */
const READY_TIMEOUT_MS = 2_500;

/**
 * Ruta propia de la puerta donde se publica el informe (no se proxya a ningún servicio).
 *
 * No está en `PUBLIC_PATHS` —al revés que `/api/v1/meta`— porque enseña las entrañas de la
 * instalación (puertos internos, conexiones, outbox): la ve el **administrador** y nadie más.
 */
export const SYSTEM_HEALTH_PATH = '/api/v1/system/health/detailed';

/**
 * Estado consolidado del sistema para el **panel del administrador**.
 *
 * El gateway no tiene base de datos ni cola: lo que aporta aquí es la **agregación**
 * —pregunta a los servicios a la vez y junta sus informes con la latencia de cada uno—,
 * que es lo que no se puede hacer desde fuera sin conocer los nueve puertos internos.
 *
 * Se pregunta a `/ready` y no a `/health`: el primero trae los chequeos (pool de la base,
 * outbox, cola) y es el que falla cuando un servicio responde pero está averiado. Nunca
 * se lanza por un servicio caído —lo que se quiere saber es **cuál**—, así que un fallo se
 * convierte en `reachable: false` con su motivo.
 */
export const collectSystemHealth = async (
  config: GatewayConfig,
  options: {
    fetchImpl?: typeof fetch;
    /** Datos propios de la puerta (los pone el servidor, que sí los conoce). */
    gateway: { service: string; version: string; uptimeSeconds: number; timestamp: string };
  },
): Promise<SystemHealthReport> => {
  const consultar = options.fetchImpl ?? fetch;
  const upstreams = upstreamsOf(config);

  const servicios = await Promise.all(
    upstreams.map(async (upstream): Promise<SystemHealthService> => {
      const startedAt = performance.now();
      try {
        const respuesta = await consultar(`${upstream.url}/ready`, {
          signal: AbortSignal.timeout(READY_TIMEOUT_MS),
        });
        const latenciaMs = Math.round(performance.now() - startedAt);
        // Un 503 trae cuerpo igual (el informe con el chequeo que falla); cualquier
        // otra respuesta se trata como «contestó pero no entendí».
        const cuerpo = (await respuesta.json().catch(() => null)) as Partial<HealthReport> | null;
        if (cuerpo === null || typeof cuerpo.service !== 'string') {
          return {
            name: upstream.name,
            url: upstream.url,
            reachable: true,
            status: respuesta.ok ? 'ok' : 'error',
            version: null,
            uptimeSeconds: null,
            latencyMs: latenciaMs,
            checks: [],
            error: `respuesta inesperada (HTTP ${String(respuesta.status)})`,
          };
        }

        return {
          name: upstream.name,
          url: upstream.url,
          reachable: true,
          status: cuerpo.status ?? (respuesta.ok ? 'ok' : 'error'),
          version: cuerpo.version ?? null,
          uptimeSeconds: cuerpo.uptimeSeconds ?? null,
          latencyMs: latenciaMs,
          checks: Array.isArray(cuerpo.checks) ? (cuerpo.checks as HealthCheckResult[]) : [],
          error: null,
        };
      } catch (error) {
        return {
          name: upstream.name,
          url: upstream.url,
          reachable: false,
          status: 'error',
          version: null,
          uptimeSeconds: null,
          latencyMs: Math.round(performance.now() - startedAt),
          checks: [],
          // El motivo del sistema (ENOTFOUND, ECONNREFUSED, timeout) es lo que orienta.
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );

  const conOutboxAtrasado = servicios.filter((servicio) => {
    const outbox = servicio.checks.find((check) => check.name === 'outbox');
    const pendientes = outbox?.details?.['pendientes'];
    return outbox?.status === 'error' || (typeof pendientes === 'number' && pendientes > 0);
  }).length;

  const latencias = servicios.map((servicio) => servicio.latencyMs);
  const totals: SystemHealthReport['totals'] = {
    ok: servicios.filter((servicio) => servicio.reachable && servicio.status !== 'error').length,
    error: servicios.filter((servicio) => servicio.reachable && servicio.status === 'error').length,
    unreachable: servicios.filter((servicio) => !servicio.reachable).length,
    conOutboxAtrasado,
    latenciaMediaMs:
      latencias.length === 0
        ? 0
        : Math.round(latencias.reduce((total, latencia) => total + latencia, 0) / latencias.length),
  };

  return {
    gateway: { ...options.gateway, status: estadoDeLaPuerta(totals) },
    services: servicios,
    totals,
    checkedAt: new Date().toISOString(),
  };
};

/**
 * Estado de la puerta según lo que encontró: si no se alcanza ningún servicio, la
 * puerta no sirve para nada (`error`); si falta alguno, la clínica funciona a medias
 * (`degraded`).
 */
const estadoDeLaPuerta = (totals: SystemHealthReport['totals']): HealthStatus => {
  if (totals.unreachable === 0 && totals.error === 0) return 'ok';
  if (totals.ok === 0) return 'error';
  return 'degraded';
};
