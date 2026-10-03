import { checkConnection, createDatabase, outboxEvents, type Database } from '@odontocrm/db';

import type { NotificationsConfig } from '../config.js';
import * as domain from './schema.js';

/** Esquema completo de la base de notificaciones: dominio + outbox compartido. */
export const notificationsSchema = { ...domain, outboxEvents };

export type NotificationsSchema = typeof notificationsSchema;
export type NotificationsDb = Database<NotificationsSchema>;

export interface NotificationsDatabaseHandle {
  db: NotificationsDb;
  pool: ReturnType<typeof createDatabase<NotificationsSchema>>['pool'];
  close: () => Promise<void>;
}

export const createNotificationsDatabase = (
  config: Pick<NotificationsConfig, 'DATABASE_URL' | 'DATABASE_POOL_MAX'>,
): NotificationsDatabaseHandle => {
  const handle = createDatabase({
    connectionString: config.DATABASE_URL,
    applicationName: 'odontocrm-notifications',
    schema: notificationsSchema,
    maxConnections: config.DATABASE_POOL_MAX,
  });

  return { db: handle.db, pool: handle.pool, close: handle.close };
};

export { checkConnection };
