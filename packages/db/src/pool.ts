import pg from 'pg';

const { Pool } = pg;

export interface CreatePoolOptions {
  connectionString: string;
  /** Nombre que aparece en `pg_stat_activity` para saber quién abrió la conexión. */
  applicationName: string;
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
  statementTimeoutMillis?: number;
}

/**
 * Crea el pool de conexiones del servicio. Los valores por defecto asumen un
 * consultorio pequeño (2–5 usuarios + 2 pantallas), no un clúster grande.
 */
export const createPool = (options: CreatePoolOptions): pg.Pool => {
  const pool = new Pool({
    connectionString: options.connectionString,
    application_name: options.applicationName,
    max: options.max ?? 10,
    idleTimeoutMillis: options.idleTimeoutMillis ?? 30_000,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 5_000,
    statement_timeout: options.statementTimeoutMillis ?? 30_000,
  });

  // Sin este manejador, un error de una conexión inactiva tumba el proceso.
  pool.on('error', (error) => {
    // eslint-disable-next-line no-console -- el pool puede fallar antes de que exista un logger
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'Error inesperado en una conexión inactiva de PostgreSQL',
        applicationName: options.applicationName,
        error: error.message,
      }),
    );
  });

  return pool;
};

/** Comprueba la conexión y devuelve la versión del servidor (sin datos sensibles). */
export const pingDatabase = async (pool: pg.Pool): Promise<string> => {
  const result = await pool.query<{ version: string }>('select version() as version');
  return result.rows[0]?.version ?? 'desconocida';
};
