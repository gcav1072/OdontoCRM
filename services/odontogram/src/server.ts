import { createOutboxCheck, createPoolCheck } from '@odontocrm/db';
import { buildServer, isProduction } from '@odontocrm/kernel';
import type { FastifyInstance } from 'fastify';

import type { OdontogramConfig } from './config.js';
import type { OdontogramDatabaseHandle } from './db/client.js';
import { registerInternalRoutes } from './routes/internal-routes.js';
import { registerOdontogramRoutes } from './routes/odontogram-routes.js';
import type { OdontogramServices } from './services.js';
import type { PatientSnapshotLookup } from './shared/patient-client.js';

export interface CreateOdontogramServerOptions {
  config: OdontogramConfig;
  database: OdontogramDatabaseHandle;
  patientLookup: PatientSnapshotLookup;
  /** Gancho para adelantar los eventos (lo conecta `index.ts` con el publicador). */
  kickOutbox?: (() => void) | undefined;
}

/**
 * Servidor del odontograma: lectura por excepción, registro de hallazgos (de cara
 * y de pieza completa), histórico append-only, constancia de impresión y el
 * resumen interno que consumirá la Fase 9.
 *
 * Rutas públicas bajo `/api/v1/odontogram` (el gateway reenvía sin recortar) y
 * rutas internas bajo `/internal/v1` con el secreto compartido.
 */
export const createOdontogramServer = async (
  options: CreateOdontogramServerOptions,
): Promise<FastifyInstance> => {
  const { config, database } = options;

  const app = buildServer({
    service: 'odontogram',
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

  const services: OdontogramServices = {
    config,
    db: database.db,
    pool: database.pool,
    patientLookup: options.patientLookup,
    ...(options.kickOutbox === undefined ? {} : { kickOutbox: options.kickOutbox }),
  };

  registerInternalRoutes(app, services);
  registerOdontogramRoutes(app, services);

  return app;
};
