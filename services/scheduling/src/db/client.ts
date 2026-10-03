import { checkConnection, createDatabase, outboxEvents, type Database } from '@odontocrm/db';

import type { SchedulingConfig } from '../config.js';
import * as domain from './schema.js';

/** Esquema completo de la base de agenda: dominio + outbox compartido. */
export const schedulingSchema = { ...domain, outboxEvents };

export type SchedulingSchema = typeof schedulingSchema;
export type SchedulingDb = Database<SchedulingSchema>;

export interface SchedulingDatabaseHandle {
  db: SchedulingDb;
  pool: ReturnType<typeof createDatabase<SchedulingSchema>>['pool'];
  close: () => Promise<void>;
}

export const createSchedulingDatabase = (
  config: Pick<SchedulingConfig, 'DATABASE_URL' | 'DATABASE_POOL_MAX'>,
): SchedulingDatabaseHandle => {
  const handle = createDatabase({
    connectionString: config.DATABASE_URL,
    applicationName: 'odontocrm-scheduling',
    schema: schedulingSchema,
    maxConnections: config.DATABASE_POOL_MAX,
  });

  return { db: handle.db, pool: handle.pool, close: handle.close };
};

export { checkConnection };
