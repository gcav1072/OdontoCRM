import { checkConnection, createDatabase, outboxEvents, type Database } from '@odontocrm/db';

import type { OdontogramConfig } from '../config.js';
import * as domain from './schema.js';

/** Esquema completo de la base del odontograma: dominio + outbox compartido. */
export const odontogramSchema = { ...domain, outboxEvents };

export type OdontogramSchema = typeof odontogramSchema;
export type OdontogramDb = Database<OdontogramSchema>;

export interface OdontogramDatabaseHandle {
  db: OdontogramDb;
  pool: ReturnType<typeof createDatabase<OdontogramSchema>>['pool'];
  close: () => Promise<void>;
}

export const createOdontogramDatabase = (
  config: Pick<OdontogramConfig, 'DATABASE_URL' | 'DATABASE_POOL_MAX'>,
): OdontogramDatabaseHandle => {
  const handle = createDatabase({
    connectionString: config.DATABASE_URL,
    applicationName: 'odontocrm-odontogram',
    schema: odontogramSchema,
    maxConnections: config.DATABASE_POOL_MAX,
  });

  return { db: handle.db, pool: handle.pool, close: handle.close };
};

export { checkConnection };
