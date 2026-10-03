import { checkConnection, createDatabase, outboxEvents, type Database } from '@odontocrm/db';

import type { ScreensConfig } from '../config.js';
import * as domain from './schema.js';

/** Esquema completo de la base de pantallas: dominio + outbox compartido. */
export const screensSchema = { ...domain, outboxEvents };

export type ScreensSchema = typeof screensSchema;
export type ScreensDb = Database<ScreensSchema>;

export interface ScreensDatabaseHandle {
  db: ScreensDb;
  pool: ReturnType<typeof createDatabase<ScreensSchema>>['pool'];
  close: () => Promise<void>;
}

export const createScreensDatabase = (
  config: Pick<ScreensConfig, 'DATABASE_URL' | 'DATABASE_POOL_MAX'>,
): ScreensDatabaseHandle => {
  const handle = createDatabase({
    connectionString: config.DATABASE_URL,
    applicationName: 'odontocrm-screens',
    schema: screensSchema,
    maxConnections: config.DATABASE_POOL_MAX,
  });

  return { db: handle.db, pool: handle.pool, close: handle.close };
};

export { checkConnection };
