import { createOutboxCheck, createPoolCheck } from '@odontocrm/db';
import { buildServer, isProduction } from '@odontocrm/kernel';
import { createDiskBlobStore, parseEncryptionKey } from '@odontocrm/storage';
import type { FastifyInstance } from 'fastify';

import type { BillingConfig } from './config.js';
import type { BillingDatabaseHandle } from './db/client.js';
import { createPdfRenderer } from './pdf-renderer.js';
import { registerBillingRoutes } from './routes/billing-routes.js';
import { registerBookRoutes } from './routes/book-routes.js';
import { registerDocumentRoutes } from './routes/document-routes.js';
import { registerFormRoutes } from './routes/form-routes.js';
import { registerRateRoutes } from './routes/rate-routes.js';
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
      // El pool con sus cifras (conexiones en uso, en espera) y el outbox con lo que
      // lleva sin publicar: el panel del administrador los enseña, y un servicio que
      // responde con el outbox atascado deja de parecer sano.
      createPoolCheck('database', database.pool, { max: config.DATABASE_POOL_MAX }),
      createOutboxCheck('outbox', database.pool),
    ],
  });

  const services: BillingServices = {
    config,
    db: database.db,
    pool: database.pool,
    patientLookup: options.services?.patientLookup ?? createBillingPatientLookup(config),
    blobStore:
      options.services?.blobStore ??
      createDiskBlobStore({
        rootDir: config.STORAGE_DIR,
        encryptionKey: parseEncryptionKey(config.STORAGE_ENCRYPTION_KEY),
      }),
    pdf:
      options.services?.pdf ??
      createPdfRenderer({
        executablePath: config.PDF_CHROMIUM_PATH,
        timeoutMs: config.PDF_TIMEOUT_MS,
      }),
    kickOutbox: options.services?.kickOutbox,
    lastError: options.services?.lastError ?? null,
  };

  registerBillingRoutes(app, services);
  registerRateRoutes(app, services);
  registerBookRoutes(app, services);
  registerDocumentRoutes(app, services);
  registerFormRoutes(app, services);

  return app;
};
