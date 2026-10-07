import multipart from '@fastify/multipart';
import { createOutboxCheck, createPoolCheck } from '@odontocrm/db';
import { buildServer, isProduction } from '@odontocrm/kernel';
import type { FastifyInstance } from 'fastify';

import type { PatientsConfig } from './config.js';
import type { PatientsDatabaseHandle } from './db/client.js';
import type { BlobStore } from '@odontocrm/storage';
import { registerFileRoutes } from './routes/file-routes.js';
import { registerInternalRoutes } from './routes/internal-routes.js';
import { registerPatientRoutes } from './routes/patient-routes.js';
import type { PatientsServices } from './services.js';

export interface CreatePatientsServerOptions {
  config: PatientsConfig;
  database: PatientsDatabaseHandle;
  blobStore: BlobStore;
}

/**
 * Servidor del servicio de pacientes: registro con identificación fuerte,
 * edición auditada con motivo, búsqueda y archivos (radiografías, fotos, PDF).
 *
 * Rutas públicas bajo `/api/v1/patients` (el gateway reenvía sin recortar) y
 * rutas internas bajo `/internal/v1` con el secreto compartido.
 */
export const createPatientsServer = async (
  options: CreatePatientsServerOptions,
): Promise<FastifyInstance> => {
  const { config, database, blobStore } = options;

  const app = buildServer({
    service: 'patients',
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

  await app.register(multipart, {
    attachFieldsToBody: true,
    limits: {
      fileSize: config.MAX_FILE_BYTES,
      files: 1,
      fields: 10,
      fieldSize: 1024 * 8,
    },
  });

  const services: PatientsServices = {
    config,
    db: database.db,
    pool: database.pool,
    blobStore,
  };

  registerInternalRoutes(app, services);
  registerPatientRoutes(app, services);
  registerFileRoutes(app, services);

  return app;
};
