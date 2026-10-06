import type { HealthCheck } from '@odontocrm/kernel';

import type { GatewayConfig } from './config.js';

/** Los servicios internos y la variable donde vive su URL. */
const SERVICIOS = [
  ['identity', 'IDENTITY_URL'],
  ['patients', 'PATIENTS_URL'],
  ['scheduling', 'SCHEDULING_URL'],
  ['notifications', 'NOTIFICATIONS_URL'],
  ['clinical', 'CLINICAL_URL'],
  ['odontogram', 'ODONTOGRAM_URL'],
  ['screens', 'SCREENS_URL'],
  ['reporting', 'REPORTING_URL'],
  ['billing', 'BILLING_URL'],
] as const;

/** Servicios internos configurados (una URL vacía significa «no está desplegado»). */
export const upstreamsOf = (config: GatewayConfig): { name: string; url: string }[] =>
  SERVICIOS.flatMap(([name, variable]) => {
    const url = config[variable];
    return typeof url === 'string' && url !== '' ? [{ name, url }] : [];
  });

/**
 * Chequeos de `/ready` de la puerta: **que sus servicios contesten**.
 *
 * El gateway no tiene base de datos y su `/ready` vivía siempre en 200 aunque no
 * hubiera un solo servicio detrás: un tablero de estado que lo mirara se creería
 * todo bien. Ahora pregunta por `/health` de cada servicio configurado, con un tope
 * corto para no colgar el chequeo.
 *
 * Es **alcanzabilidad**, no salud profunda: si un servicio responde en `/health`
 * pero tiene la base caída, eso lo dice su propio `/ready` (y el tablero,
 * `npm run estado`, lo enseña con detalle).
 */
export const buildUpstreamChecks = (
  config: GatewayConfig,
  fetchImpl: typeof fetch = fetch,
): HealthCheck[] =>
  upstreamsOf(config).map((upstream) => ({
    name: upstream.name,
    timeoutMs: 1_500,
    run: async () => {
      const response = await fetchImpl(`${upstream.url}/health`, {
        signal: AbortSignal.timeout(1_500),
      });
      if (!response.ok) {
        throw new Error(`${upstream.name} respondió ${String(response.status)} en /health`);
      }
    },
  }));
