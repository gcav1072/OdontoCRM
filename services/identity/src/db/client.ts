import { createDatabase, type Database } from '@odontocrm/db';
import { outboxEvents } from '@odontocrm/db';

import type { IdentityConfig } from '../config.js';
import * as domain from './schema.js';

/**
 * Esquema completo de la base de identidad: las tablas del dominio más la tabla
 * de outbox que comparte todo el sistema. Se arma aquí (y no en `schema.ts`)
 * para que drizzle-kit vea cada tabla una sola vez al generar migraciones.
 */
export const identitySchema = { ...domain, outboxEvents };

export type IdentitySchema = typeof identitySchema;
export type IdentityDb = Database<IdentitySchema>;

export interface IdentityDatabaseHandle {
  db: IdentityDb;
  pool: ReturnType<typeof createDatabase<IdentitySchema>>['pool'];
  close: () => Promise<void>;
}

/** Abre el pool y el cliente de Drizzle del servicio de identidad. */
export const createIdentityDatabase = (
  config: Pick<IdentityConfig, 'DATABASE_URL' | 'DATABASE_POOL_MAX'>,
): IdentityDatabaseHandle => {
  const handle = createDatabase({
    connectionString: config.DATABASE_URL,
    applicationName: 'odontocrm-identity',
    schema: identitySchema,
    maxConnections: config.DATABASE_POOL_MAX,
  });

  return { db: handle.db, pool: handle.pool, close: handle.close };
};
