import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type pg from 'pg';

import { createPool } from './pool.js';

export type Database<TSchema extends Record<string, unknown> = Record<string, never>> =
  NodePgDatabase<TSchema>;

export interface CreateDatabaseOptions<TSchema extends Record<string, unknown>> {
  connectionString: string;
  applicationName: string;
  schema: TSchema;
  maxConnections?: number;
}

export interface DatabaseHandle<TSchema extends Record<string, unknown>> {
  pool: pg.Pool;
  db: Database<TSchema>;
  close: () => Promise<void>;
}

/**
 * Abre el pool y el cliente de Drizzle del servicio. Todas las consultas pasan
 * por Drizzle o por parámetros ($1, $2): nunca se concatena SQL con texto.
 */
export const createDatabase = <TSchema extends Record<string, unknown>>(
  options: CreateDatabaseOptions<TSchema>,
): DatabaseHandle<TSchema> => {
  const pool = createPool({
    connectionString: options.connectionString,
    applicationName: options.applicationName,
    ...(options.maxConnections === undefined ? {} : { max: options.maxConnections }),
  });

  const db = drizzle(pool, { schema: options.schema });

  return {
    pool,
    db,
    close: async () => {
      await pool.end();
    },
  };
};

/** Consulta mínima para el endpoint `/ready`: no devuelve datos del usuario. */
export const checkConnection = async (pool: pg.Pool): Promise<void> => {
  await pool.query('select 1');
};
