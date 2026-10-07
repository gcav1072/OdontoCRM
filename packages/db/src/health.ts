import type pg from 'pg';

/**
 * Comprobaciones de salud con **cifras**, para los `/ready` de los servicios.
 *
 * El chequeo «la base responde» dice si hay conexión, pero no si el pool está al
 * límite: nueve servicios con diez conexiones cada uno agotan un PostgreSQL pequeño
 * mucho antes de dar error, y el síntoma que llega es «va lento» sin causa visible.
 * Lo mismo con el outbox: un servicio que responde pero lleva media hora sin publicar
 * está fallando aunque su `/ready` diga «ok».
 *
 * Vivían en cada `server.ts` como una consulta suelta; aquí devuelven `details` y el
 * gateway los junta en el panel del administrador.
 *
 * El tipo `HealthCheck` se declara **estructuralmente** y no se importa del kernel: el
 * paquete de datos no depende del kernel (es al revés), y una comprobación es un nombre
 * y una función —no hace falta arrastrar el kernel para eso—.
 */

export interface DetailedHealthCheck {
  name: string;
  run: () => Promise<Record<string, unknown> | void> | Record<string, unknown> | void;
}

/**
 * Pool de conexiones: cuántas hay abiertas, cuántas libres y sobre todo **cuántas
 * peticiones esperan** (`waiting`). Un `waiting` que crece es la antesala de un
 * timeout de conexión.
 *
 * `max` se pasa desde fuera porque `pg` no lo publica una vez creado el pool: quien
 * lo construye lo sabe (viene de `DATABASE_POOL_MAX`).
 */
export const createPoolCheck = (
  name: string,
  pool: pg.Pool,
  options: { max?: number } = {},
): DetailedHealthCheck => ({
  name,
  run: async () => {
    // `select 1` primero: es la comprobación de verdad (el pool puede tener conexiones
    // abiertas y estar todas muertas).
    await pool.query('select 1');
    const total = pool.totalCount;
    const idle = pool.idleCount;
    return {
      total,
      idle,
      enUso: total - idle,
      waiting: pool.waitingCount,
      ...(options.max === undefined ? {} : { max: options.max }),
    };
  },
});

/**
 * Outbox: eventos escritos que todavía no se han publicado en la cola.
 *
 * Un pendiente es normal durante unos segundos (el publicador mira cada 2 s); lo que
 * no lo es es un pendiente **viejo**, y eso es lo que dice `masAntiguoSegundos`.
 */
export const createOutboxCheck = (name: string, pool: pg.Pool): DetailedHealthCheck => ({
  name,
  run: async () => {
    const { rows } = await pool.query<{ pendientes: number; mas_antiguo: Date | null }>(
      `select count(1)::int as pendientes, min(occurred_at) as mas_antiguo
         from outbox_events
        where published_at is null`,
    );
    const fila = rows[0];
    const pendientes = fila?.pendientes ?? 0;
    const masAntiguo = fila?.mas_antiguo ?? null;
    return {
      pendientes,
      masAntiguoSegundos:
        masAntiguo === null
          ? null
          : Math.max(0, Math.round((Date.now() - masAntiguo.getTime()) / 1000)),
    };
  },
});
