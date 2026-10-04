import { checkConnection } from '@odontocrm/db';
import { buildServer, isProduction } from '@odontocrm/kernel';
import type { FastifyInstance } from 'fastify';

import type { ClinicalConfig } from './config.js';
import type { ClinicalDatabaseHandle } from './db/client.js';
import { registerClinicalRoutes } from './routes/clinical-routes.js';
import { registerInternalRoutes } from './routes/internal-routes.js';
import type { ClinicalServices } from './services.js';
import type { PatientSnapshotLookup } from './shared/patient-client.js';

export interface CreateClinicalServerOptions {
  config: ClinicalConfig;
  database: ClinicalDatabaseHandle;
  patientLookup: PatientSnapshotLookup;
  /** Gancho para adelantar los eventos (lo conecta `index.ts` con el publicador). */
  kickOutbox?: (() => void) | undefined;
}

/**
 * Servidor del servicio clínico: historia clínica por secciones, catálogos
 * tipificados, firma, adendas, consentimiento y constancia de impresión.
 *
 * Rutas públicas bajo `/api/v1/clinical` (el gateway reenvía sin recortar) y
 * rutas internas bajo `/internal/v1` con el secreto compartido.
 */
export const createClinicalServer = async (
  options: CreateClinicalServerOptions,
): Promise<FastifyInstance> => {
  const { config, database } = options;

  const app = buildServer({
    service: 'clinical',
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

  const services: ClinicalServices = {
    config,
    db: database.db,
    pool: database.pool,
    patientLookup: options.patientLookup,
    ...(options.kickOutbox === undefined ? {} : { kickOutbox: options.kickOutbox }),
  };

  registerInternalRoutes(app, services);
  registerClinicalRoutes(app, services);

  return app;
};
