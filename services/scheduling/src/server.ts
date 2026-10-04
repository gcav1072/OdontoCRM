import { checkConnection } from '@odontocrm/db';
import { buildServer, isProduction } from '@odontocrm/kernel';
import type { FastifyInstance } from 'fastify';

import type { SchedulingConfig } from './config.js';
import type { SchedulingDatabaseHandle } from './db/client.js';
import { registerAgendaRoutes } from './routes/agenda-routes.js';
import { registerAppointmentRoutes } from './routes/appointment-routes.js';
import { registerInternalRoutes } from './routes/internal-routes.js';
import { registerRequestRoutes } from './routes/request-routes.js';
import type { SchedulingServices } from './services.js';
import { createClinicalSessionLookup } from './shared/clinical-client.js';

export interface CreateSchedulingServerOptions {
  config: SchedulingConfig;
  database: SchedulingDatabaseHandle;
  /** Gancho para adelantar los eventos (lo conecta `index.ts` con el publicador). */
  kickOutbox?: (() => void) | undefined;
}

/**
 * Servidor del servicio de agenda: solicitudes con ticket, cupo diario editable,
 * franjas de la jornada, asignación (franja u hora manual, con sobrecupo
 * autorizado), reprogramación, cancelación, inasistencia y avisos en lote.
 *
 * Rutas públicas bajo `/api/v1/requests`, `/api/v1/agenda` y `/api/v1/appointments`
 * (el gateway reenvía sin recortar el prefijo) y rutas internas bajo `/internal/v1`.
 */
export const createSchedulingServer = async (
  options: CreateSchedulingServerOptions,
): Promise<FastifyInstance> => {
  const { config, database } = options;

  const app = buildServer({
    service: 'scheduling',
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

  const services: SchedulingServices = {
    config,
    db: database.db,
    pool: database.pool,
    sessionLookup: createClinicalSessionLookup(config),
    ...(options.kickOutbox === undefined ? {} : { kickOutbox: options.kickOutbox }),
  };

  registerInternalRoutes(app, services);
  registerRequestRoutes(app, services);
  registerAgendaRoutes(app, services);
  registerAppointmentRoutes(app, services);

  return app;
};
