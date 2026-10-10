import { createOutboxCheck, createPoolCheck } from '@odontocrm/db';
import { buildServer, isProduction } from '@odontocrm/kernel';
import type { FastifyInstance } from 'fastify';

import type { ScreensConfig } from './config.js';
import type { ScreensDatabaseHandle } from './db/client.js';
import { createAlertLookup, createChairCatalog } from './internal-client.js';
import { createScreenBroadcaster } from './sala/broadcast.js';
import { registerScreenRoutes } from './routes/screen-routes.js';
import type { ScreensServices } from './services.js';

export interface CreateScreensServerOptions {
  config: ScreensConfig;
  database: ScreensDatabaseHandle;
  /** Se inyecta en las pruebas; si no, cada servidor tiene el suyo. */
  services?: Omit<ScreensServices, 'config' | 'db' | 'pool'>;
}

/**
 * Servidor del servicio de pantallas: dispositivos kiosko, estado de la sala de
 * espera y del consultorio, y flujo **SSE** para que las pantallas se actualicen
 * en vivo.
 *
 * Rutas públicas bajo `/api/v1/screens` (el gateway reenvía sin recortar el
 * prefijo; el kiosko entra con su token de dispositivo canjeado en identity) y
 * rutas internas bajo `/internal/v1`.
 */
export const createScreensServer = async (
  options: CreateScreensServerOptions,
): Promise<FastifyInstance> => {
  const { config, database } = options;

  const app = buildServer({
    service: 'screens',
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

  const services: ScreensServices = {
    config,
    db: database.db,
    pool: database.pool,
    broadcast: options.services?.broadcast ?? createScreenBroadcaster(),
    lastError: options.services?.lastError ?? null,
    alertLookup: options.services?.alertLookup ?? createAlertLookup(config),
    chairCatalog: options.services?.chairCatalog ?? createChairCatalog(config),
  };

  registerScreenRoutes(app, services);

  return app;
};
