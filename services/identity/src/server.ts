import { createOutboxCheck, createPoolCheck } from '@odontocrm/db';
import { buildServer, isProduction, type PrivateKey } from '@odontocrm/kernel';
import cookie from '@fastify/cookie';
import type { FastifyInstance } from 'fastify';

import type { IdentityConfig } from './config.js';
import type { IdentityDatabaseHandle } from './db/client.js';
import { registerAuditRoutes } from './routes/audit-routes.js';
import { registerAuthRoutes } from './routes/auth-routes.js';
import { registerDeviceRoutes } from './routes/device-routes.js';
import { registerUserRoutes } from './routes/user-routes.js';
import type { IdentityServices } from './services.js';

export interface CreateIdentityServerOptions {
  config: IdentityConfig;
  database: IdentityDatabaseHandle;
  /** Clave privada EdDSA para firmar los JWT de acceso. */
  privateKey: PrivateKey;
}

/**
 * Servidor del servicio de identidad: usuarios, roles y permisos, autenticación
 * con refresh rotativo, dispositivos kiosko y auditoría.
 *
 * Todas las rutas cuelgan de su prefijo público (`/api/v1/auth`, `/api/v1/users`,
 * `/api/v1/audit`, `/api/v1/devices`); el gateway reenvía sin recortar la ruta,
 * así que cada servicio es dueño de su prefijo y no hay colisiones.
 */
export const createIdentityServer = async (
  options: CreateIdentityServerOptions,
): Promise<FastifyInstance> => {
  const { config, database, privateKey } = options;

  const app = buildServer({
    service: 'identity',
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

  // Necesario para leer y escribir la cookie de refresco.
  await app.register(cookie);

  const services: IdentityServices = {
    config,
    db: database.db,
    pool: database.pool,
    privateKey,
  };

  registerAuthRoutes(app, services);
  registerUserRoutes(app, services);
  registerAuditRoutes(app, services);
  registerDeviceRoutes(app, services);

  return app;
};
