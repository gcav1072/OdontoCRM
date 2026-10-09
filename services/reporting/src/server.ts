import { createOutboxCheck, createPoolCheck } from '@odontocrm/db';
import { buildServer, createLetterheadLookup, isProduction } from '@odontocrm/kernel';
import type { FastifyInstance } from 'fastify';

import type { ReportingConfig } from './config.js';
import type { ReportingDatabaseHandle } from './db/client.js';
import { createPdfRenderer } from './pdf-renderer.js';
import { registerReportRoutes } from './routes/report-routes.js';
import type { ReportingServices } from './services.js';

export interface CreateReportingServerOptions {
  config: ReportingConfig;
  database: ReportingDatabaseHandle;
  /** Se inyecta en las pruebas; si no, cada servidor tiene el suyo. */
  services?: Partial<Omit<ReportingServices, 'config' | 'db' | 'pool'>>;
}

/**
 * Servidor del servicio de reportes: el tablero del día, los seis reportes del
 * catálogo con sus filtros y su exportación (CSV y PDF), y las dos rutas internas
 * (refresco manual y diagnóstico del read model).
 *
 * Rutas públicas bajo `/api/v1/reports` (el gateway reenvía sin recortar el prefijo)
 * y rutas internas bajo `/internal/v1/reporting`.
 */
export const createReportingServer = async (
  options: CreateReportingServerOptions,
): Promise<FastifyInstance> => {
  const { config, database } = options;

  const app = buildServer({
    service: 'reporting',
    version: config.SERVICE_VERSION,
    logLevel: config.LOG_LEVEL,
    prettyLogs: config.LOG_PRETTY,
    production: isProduction(config),
    checks: [
      // El pool con sus cifras (conexiones en uso, en espera) y el outbox con lo que
      // lleva sin publicar: el panel del administrador los enseña, y un servicio que
      // responde con el outbox atascado deja de parecer sano.
      createPoolCheck('database', database.pool, { max: config.DATABASE_POOL_MAX }),
      createOutboxCheck('outbox', database.pool),
    ],
  });

  const services: ReportingServices = {
    config,
    db: database.db,
    pool: database.pool,
    pdf:
      options.services?.pdf ??
      createPdfRenderer({
        executablePath: config.PDF_CHROMIUM_PATH,
        timeoutMs: config.PDF_TIMEOUT_MS,
      }),
    letterheadLookup: options.services?.letterheadLookup ?? createLetterheadLookup(config),
    lastError: options.services?.lastError ?? null,
  };

  registerReportRoutes(app, services);

  return app;
};
