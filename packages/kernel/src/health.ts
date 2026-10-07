import type { HealthCheckResult, HealthReport } from '@odontocrm/contracts';
import { readinessStatusCode } from '@odontocrm/contracts';
import type { FastifyInstance } from 'fastify';

import { sanitizeMessage } from './errors.js';

/** Verificación de una dependencia (base de datos, cola, bot de Telegram…). */
export interface HealthCheck {
  name: string;
  /**
   * Comprueba la dependencia. Si **devuelve un objeto**, sus claves viajan como
   * `details` en el informe (conexiones del pool, eventos sin publicar del outbox…):
   * el panel del administrador enseña así las cifras, no solo el «ok». Devolver
   * `undefined` es lo normal en un chequeo que solo confirma que responde.
   *
   * Los detalles son para mirarlos: **nunca** credenciales ni cadenas de conexión.
   */
  run: () => Promise<Record<string, unknown> | void> | Record<string, unknown> | void;
  timeoutMs?: number;
}

export interface HealthRoutesOptions {
  service: string;
  version: string;
  checks?: HealthCheck[];
  /** En producción los fallos no revelan detalles internos. */
  production?: boolean;
}

const DEFAULT_TIMEOUT_MS = 2_000;

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Sin respuesta después de ${String(timeoutMs)} ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

/** Un objeto plano (y no un `null` ni un array): lo que se admite como `details`. */
const esRegistro = (valor: unknown): valor is Record<string, unknown> =>
  typeof valor === 'object' && valor !== null && !Array.isArray(valor);

const runCheck = async (check: HealthCheck, production: boolean): Promise<HealthCheckResult> => {
  const startedAt = performance.now();
  const timeoutMs = check.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  try {
    const resultado = await withTimeout(Promise.resolve(check.run()), timeoutMs);
    return {
      name: check.name,
      status: 'ok',
      latencyMs: Math.round(performance.now() - startedAt),
      // Un chequeo que devuelve cifras (pool, outbox) las publica como detalles; el que
      // solo confirma que responde no añade nada.
      ...(esRegistro(resultado) ? { details: resultado } : {}),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Error desconocido';
    return {
      name: check.name,
      status: 'error',
      latencyMs: Math.round(performance.now() - startedAt),
      message: production ? 'Dependencia no disponible' : sanitizeMessage(message),
    };
  }
};

const buildReport = async (options: HealthRoutesOptions): Promise<HealthReport> => {
  const checks = options.checks ?? [];
  const results = await Promise.all(
    checks.map((check) => runCheck(check, options.production ?? false)),
  );
  const hasError = results.some((result) => result.status === 'error');

  return {
    service: options.service,
    version: options.version,
    status: hasError ? 'error' : 'ok',
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
    checks: results,
  };
};

/**
 * `GET /health`  → vive mientras el proceso viva (para el gestor de procesos).
 * `GET /ready`   → 503 si una dependencia falla (para que el gateway no envíe tráfico).
 */
export const registerHealthRoutes = (app: FastifyInstance, options: HealthRoutesOptions): void => {
  app.get('/health', async () => ({
    service: options.service,
    version: options.version,
    status: 'ok' as const,
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  }));

  app.get('/ready', async (_request, reply) => {
    const report = await buildReport(options);
    return reply.status(readinessStatusCode(report)).send(report);
  });
};
