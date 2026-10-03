import { checkConnection } from '@odontocrm/db';
import { buildServer, isProduction } from '@odontocrm/kernel';
import type { FastifyInstance } from 'fastify';

import type { NotificationsConfig } from './config.js';
import type { NotificationsDatabaseHandle } from './db/client.js';
import { registerNotificationRoutes } from './routes.js';
import type { NotificationsServices } from './services.js';

export interface CreateNotificationsServerOptions {
  config: NotificationsConfig;
  database: NotificationsDatabaseHandle;
  services: Omit<NotificationsServices, 'config' | 'db' | 'pool'>;
}

/**
 * Servidor del servicio de notificaciones: bandeja de envíos, plantillas
 * editables, vinculación de chats y descarga del `.ics`.
 *
 * El bot (poller de Telegram) y la cola de envíos corren en el mismo proceso, en
 * segundo plano: el poller es **uno solo** por diseño (Telegram no admite dos).
 */
export const createNotificationsServer = async (
  options: CreateNotificationsServerOptions,
): Promise<FastifyInstance> => {
  const { config, database, services } = options;

  const app = buildServer({
    service: 'notifications',
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

  registerNotificationRoutes(app, {
    ...services,
    config,
    db: database.db,
    pool: database.pool,
  });

  return app;
};
