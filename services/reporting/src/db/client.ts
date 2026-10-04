import { checkConnection, createDatabase, outboxEvents, type Database } from '@odontocrm/db';

import type { ReportingConfig } from '../config.js';
import * as domain from './schema.js';

/**
 * Esquema completo de la base de reportes: dominio + outbox compartido.
 *
 * El outbox lo usa **solo** la prueba de integración (el read model no publica
 * eventos: no tiene nada que contar). Se declara igual porque la tabla existe en la
 * base —la crea la migración— y así la prueba puede escribir eventos con el mismo
 * contrato que los servicios reales.
 */
export const reportingSchema = { ...domain, outboxEvents };

export type ReportingSchema = typeof reportingSchema;
export type ReportingDb = Database<ReportingSchema>;

export interface ReportingDatabaseHandle {
  db: ReportingDb;
  pool: ReturnType<typeof createDatabase<ReportingSchema>>['pool'];
  close: () => Promise<void>;
}

export const createReportingDatabase = (
  config: Pick<ReportingConfig, 'DATABASE_URL' | 'DATABASE_POOL_MAX'>,
): ReportingDatabaseHandle => {
  const handle = createDatabase({
    connectionString: config.DATABASE_URL,
    applicationName: 'odontocrm-reporting',
    schema: reportingSchema,
    maxConnections: config.DATABASE_POOL_MAX,
  });

  return { db: handle.db, pool: handle.pool, close: handle.close };
};

export { checkConnection };
