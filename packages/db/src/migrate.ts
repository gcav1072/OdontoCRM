import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type pg from 'pg';

export interface RunMigrationsOptions {
  connectionString: string;
  applicationName: string;
  migrationsFolder: string;
  /** Nombre de la tabla de control de migraciones dentro del esquema `drizzle`. */
  migrationsTable?: string;
}

/**
 * Aplica las migraciones versionadas del servicio (`services/<svc>/migrations`).
 * Es idempotente: si ya están aplicadas, no hace nada.
 */
export const runMigrations = async (options: RunMigrationsOptions): Promise<void> => {
  const pool = new (await import('pg')).default.Pool({
    connectionString: options.connectionString,
    application_name: `${options.applicationName}-migrator`,
    max: 1,
  });

  try {
    const db: NodePgDatabase = drizzle(pool);
    await migrate(db, {
      migrationsFolder: options.migrationsFolder,
      ...(options.migrationsTable === undefined
        ? {}
        : { migrationsTable: options.migrationsTable }),
    });
  } finally {
    await pool.end();
  }
};

/** Crea el esquema donde Drizzle guarda su tabla de control. */
export const ensureMigrationSchema = async (pool: pg.Pool): Promise<void> => {
  await pool.query('create schema if not exists drizzle');
};
