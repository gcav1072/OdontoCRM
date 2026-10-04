import { checkConnection, createDatabase, outboxEvents, type Database } from '@odontocrm/db';

import type { ClinicalConfig } from '../config.js';
import * as domain from './schema.js';

/** Esquema completo de la base clínica: dominio + outbox compartido. */
export const clinicalSchema = { ...domain, outboxEvents };

export type ClinicalSchema = typeof clinicalSchema;
export type ClinicalDb = Database<ClinicalSchema>;

export interface ClinicalDatabaseHandle {
  db: ClinicalDb;
  pool: ReturnType<typeof createDatabase<ClinicalSchema>>['pool'];
  close: () => Promise<void>;
}

export const createClinicalDatabase = (
  config: Pick<ClinicalConfig, 'DATABASE_URL' | 'DATABASE_POOL_MAX'>,
): ClinicalDatabaseHandle => {
  const handle = createDatabase({
    connectionString: config.DATABASE_URL,
    applicationName: 'odontocrm-clinical',
    schema: clinicalSchema,
    maxConnections: config.DATABASE_POOL_MAX,
  });

  return { db: handle.db, pool: handle.pool, close: handle.close };
};

export { checkConnection };
