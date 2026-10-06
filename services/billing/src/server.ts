import { checkConnection } from '@odontocrm/db';
import { buildServer, isProduction } from '@odontocrm/kernel';
import type { FastifyInstance } from 'fastify';

import type { BillingConfig } from './config.js';
import type { BillingDatabaseHandle } from './db/client.js';
import { registerBillingRoutes } from './routes/billing-routes.js';
import type { BillingServices } from './services.js';
import { createBillingPatientLookup } from './shared/patient-client.js';

export interface CreateBillingServerOptions {
  config: BillingConfig;
  database: BillingDatabaseHandle;
  /** Se inyecta en las pruebas; si no, cada servidor tiene el suyo. */
  services?: Partial<Omit<BillingServices, 'config' | 'db' | 'pool'>>;
}

/**
 * Servidor del servicio de facturación: la caja (borradores pendientes, revisión del borrador y el
 * arancel) y, con el dinero, los cobros, la tasa del día y los libros.
 *
 * Rutas públicas bajo `/api/v1/billing` (el gateway reenvía sin recortar el prefijo).
 */
export const createBillingServer = async (
  options: CreateBillingServerOptions,
): Promise<FastifyInstance> => {
  const { config, database } = options;

  const app = buildServer({
    service: 'billing',
    version: config.SERVICE_VERSION,
    logLevel: config.LOG_LEVEL,
    prettyLogs: config.LOG_PRETTY,
    production: isProduction(config),
    checks: [
      {
        name: 'database',
        run: () => checkConnection(database.pool),
      },
    ],
  });

  const services: BillingServices = {
    config,
    db: database.db,
    pool: database.pool,
    patientLookup: options.services?.patientLookup ?? createBillingPatientLookup(config),
    lastError: options.services?.lastError ?? null,
  };

  registerBillingRoutes(app, services);

  return app;
};
