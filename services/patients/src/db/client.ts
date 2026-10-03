import { checkConnection, createDatabase, outboxEvents, type Database } from '@odontocrm/db';

import type { PatientsConfig } from '../config.js';
import * as domain from './schema.js';

/** Esquema completo de la base de pacientes: dominio + outbox compartido. */
export const patientsSchema = { ...domain, outboxEvents };

export type PatientsSchema = typeof patientsSchema;
export type PatientsDb = Database<PatientsSchema>;

export interface PatientsDatabaseHandle {
  db: PatientsDb;
  pool: ReturnType<typeof createDatabase<PatientsSchema>>['pool'];
  close: () => Promise<void>;
}

export const createPatientsDatabase = (
  config: Pick<PatientsConfig, 'DATABASE_URL' | 'DATABASE_POOL_MAX'>,
): PatientsDatabaseHandle => {
  const handle = createDatabase({
    connectionString: config.DATABASE_URL,
    applicationName: 'odontocrm-patients',
    schema: patientsSchema,
    maxConnections: config.DATABASE_POOL_MAX,
  });

  return { db: handle.db, pool: handle.pool, close: handle.close };
};

export { checkConnection };
