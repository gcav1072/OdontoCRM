import { checkConnection } from '@odontocrm/db';
import { buildServer, isProduction } from '@odontocrm/kernel';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';

import type { IdentityConfig } from './config.js';

export interface CreateIdentityServerOptions {
  config: IdentityConfig;
  pool: pg.Pool;
}

/**
 * Servidor del servicio de identidad. En la Fase 1 se registran aquí los
 * plugins de autenticación, roles y auditoría; en la Fase 0 expone únicamente
 * el comportamiento común (`/health`, `/ready`, errores RFC 7807).
 */
export const createIdentityServer = (options: CreateIdentityServerOptions): FastifyInstance =>
  buildServer({
    service: 'identity',
    version: options.config.SERVICE_VERSION,
    logLevel: options.config.LOG_LEVEL,
    prettyLogs: options.config.LOG_PRETTY,
    production: isProduction(options.config),
    checks: [
      {
        name: 'database',
        run: () => checkConnection(options.pool),
      },
    ],
  });
