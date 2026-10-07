import { createOutboxCheck, createPoolCheck } from '@odontocrm/db';
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
 * editables, vinculación de canales, webhook de los canales que empujan y
 * descarga del `.ics`.
 *
 * El asistente (los adaptadores de Telegram y WhatsApp) y la cola de envíos
 * corren en el mismo proceso, en segundo plano: el sondeo de Telegram es **uno
 * solo** por diseño (Telegram no admite dos).
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
      // El pool con sus cifras (conexiones en uso, en espera) y el outbox con lo que
      // lleva sin publicar: el panel del administrador los enseña, y un servicio que
      // responde con el outbox atascado deja de parecer sano.
      createPoolCheck('database', database.pool, { max: config.DATABASE_POOL_MAX }),
      createOutboxCheck('outbox', database.pool),
    ],
  });

  /**
   * El webhook de WhatsApp se firma sobre los **bytes exactos** del cuerpo: si se
   * re-serializara el JSON, la firma no cuadraría. Se conserva el texto crudo en
   * la petición y se parsea igual que antes (el resto de rutas no cambia).
   */
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    const raw = typeof body === 'string' ? body : String(body);
    (request as { rawBody?: string }).rawBody = raw;
    if (raw.trim() === '') {
      done(null, undefined);
      return;
    }
    try {
      done(null, JSON.parse(raw));
    } catch (error) {
      done(error as Error, undefined);
    }
  });

  registerNotificationRoutes(app, {
    ...services,
    config,
    db: database.db,
    pool: database.pool,
  });

  return app;
};
