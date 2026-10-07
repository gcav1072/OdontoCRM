import type { JobWithMetadata } from 'pg-boss';
import type pg from 'pg';

import type { DomainEvent } from '@odontocrm/events';

/**
 * Registro duradero de los eventos que **agotaron sus reintentos**.
 *
 * La cola de descarte de `pg-boss` es un buzón: guarda el trabajo fallido un tiempo y su
 * retención es la que es. Esto es otra cosa —el archivo—: una fila por evento perdido, con
 * el sobre completo, el motivo del fallo y de qué cola venía, para poder mirarlo dentro de
 * un mes y saber qué se dejó de hacer.
 *
 * Vive en la base de **eventos** (la compartida, `odonto_events`), no en la de cada
 * servicio: el fallo es de la entrega —que es común— y así el vigilante esté donde esté
 * apunta en el mismo sitio y no hay seis listas distintas de lo mismo.
 *
 * El esquema `events` es propio de esta tabla; `pg-boss` usa el suyo (`pgboss`), así que no
 * se pisan. No hay migración: la base de eventos no tiene servicio dueño que migre, así que
 * el DDL es **idempotente y se aplica al arrancar el vigilante** (con el error de carrera
 * tolerado, que seis servicios arrancando a la vez la crean a la vez).
 *
 * El nombre de la tabla va **literal** en cada consulta en vez de en una constante
 * interpolada: la barrera anti SQL-injection del proyecto prohíbe cualquier plantilla con
 * interpolación dentro de un `query(...)`, y una regla solo sirve si no tiene excepciones
 * que alguien pueda imitar por costumbre.
 */

/** Una fila del registro, tal como la escribimos. */
export interface DeadLetterRecord {
  /** Id del trabajo **en la cola de descarte**: la clave de idempotencia. */
  jobId: string;
  /** Cola en la que falló (`domain-events.clinical`). */
  sourceQueue: string | null;
  /** Id del trabajo original, para cruzarlo con los registros de `pg-boss`. */
  sourceJobId: string | null;
  eventId: string | null;
  eventType: string | null;
  producer: string | null;
  aggregateId: string | null;
  /** Sobre completo del evento (lo que no se pudo entregar). */
  payload: unknown;
  /** Motivo del fallo tal como lo dejó `pg-boss`. */
  error: string | null;
  /** Reintentos que consumió el evento antes de darse por perdido. */
  retryCount: number;
  failedAt: string;
  recordedAt: string;
}

/** Resumen del registro, para el tablero de estado y el panel del administrador. */
export interface DeadLetterStats {
  total: number;
  ultimas24h: number;
  masReciente: string | null;
  porCola: { cola: string | null; total: number }[];
}

/** Descripción legible del `sourceOutput` de `pg-boss`, que es un objeto o una cadena. */
const describeOutput = (output: unknown): string | null => {
  if (output === null || output === undefined) return null;
  if (typeof output === 'string') return output;
  if (typeof output === 'object') {
    const valor =
      (output as { message?: unknown; error?: unknown }).message ??
      (output as { error?: unknown }).error;
    if (typeof valor === 'string') return valor;
    try {
      return JSON.stringify(output);
    } catch {
      return null;
    }
  }
  return String(output);
};

/**
 * Traduce un trabajo de la cola de descarte a la fila del registro.
 *
 * Los metadatos (`sourceName`, `sourceOutput`…) son la razón de que el manejador se
 * registre con `includeMetadata`: sin ellos habría que adivinar de qué cola vino y por qué
 * falló, que es justo lo que hace falta para arreglarlo.
 */
export const toDeadLetterRecord = (job: JobWithMetadata<DomainEvent>): DeadLetterRecord => {
  const evento = job.data as DomainEvent | undefined;
  const recordedAt = new Date();
  return {
    jobId: job.id,
    sourceQueue: job.sourceName ?? null,
    sourceJobId: job.sourceId ?? null,
    eventId: typeof evento?.eventId === 'string' ? evento.eventId : null,
    eventType: typeof evento?.eventType === 'string' ? evento.eventType : null,
    producer: typeof evento?.producer === 'string' ? evento.producer : null,
    aggregateId: typeof evento?.aggregateId === 'string' ? evento.aggregateId : null,
    payload: (evento ?? null) as unknown,
    error: describeOutput(job.sourceOutput),
    retryCount: job.sourceRetryCount ?? job.retryCount,
    // La hora del fallo original (si `pg-boss` la conservó), no la de ahora: es cuando se
    // dejó de hacer lo que el evento pedía.
    failedAt: (job.sourceCreatedOn ?? recordedAt).toISOString(),
    recordedAt: recordedAt.toISOString(),
  };
};

/**
 * Crea el esquema y la tabla si no están. Idempotente y seguro con varios servicios
 * arrancando a la vez: el error de carrera (ya existe) se traga, porque significa que otro
 * llegó primero y el objetivo —que la tabla esté— se cumple igual.
 */
export const ensureDeadLetterTable = async (pool: pg.Pool): Promise<void> => {
  try {
    await pool.query(
      `create schema if not exists events;
       create table if not exists events.dead_letter_events (
         id uuid primary key default gen_random_uuid(),
         job_id text not null unique,
         source_queue text,
         source_job_id text,
         event_id uuid,
         event_type text,
         producer text,
         aggregate_id uuid,
         payload jsonb not null,
         error text,
         retry_count integer not null default 0,
         failed_at timestamptz not null,
         recorded_at timestamptz not null default now()
       );
       create index if not exists idx_dead_letter_recorded
         on events.dead_letter_events (recorded_at desc);
       create index if not exists idx_dead_letter_type
         on events.dead_letter_events (event_type, recorded_at desc);`,
    );
  } catch (error) {
    // 42P07 = la tabla ya existe; 23505 = dos servicios creándola a la vez (el índice o el
    // tipo de la tabla chocan). En los dos casos el resultado es el que se buscaba.
    const code = (error as { code?: string }).code;
    if (code !== '42P07' && code !== '23505') throw error;
  }
};

/**
 * Apunta un evento perdido. Devuelve `true` **solo si lo escribió ahora**: si el trabajo ya
 * estaba apuntado (un reintento del vigilante, u otro servicio que lo vio antes), devuelve
 * `false` y quien llama no repite el aviso.
 */
export const insertDeadLetter = async (
  pool: pg.Pool,
  record: DeadLetterRecord,
): Promise<boolean> => {
  const { rowCount } = await pool.query(
    `insert into events.dead_letter_events
       (job_id, source_queue, source_job_id, event_id, event_type, producer, aggregate_id,
        payload, error, retry_count, failed_at, recorded_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     on conflict (job_id) do nothing`,
    [
      record.jobId,
      record.sourceQueue,
      record.sourceJobId,
      record.eventId,
      record.eventType,
      record.producer,
      record.aggregateId,
      JSON.stringify(record.payload),
      record.error,
      record.retryCount,
      record.failedAt,
      record.recordedAt,
    ],
  );
  return rowCount === 1;
};

/** Resumen del registro: cuántos hay, cuántos son de hoy y de qué colas vienen. */
export const deadLetterStats = async (pool: pg.Pool): Promise<DeadLetterStats> => {
  const { rows } = await pool.query<{
    total: number;
    ultimas_24h: number;
    mas_reciente: Date | null;
  }>(
    `select count(1)::int as total,
            count(1) filter (where recorded_at > now() - interval '24 hours')::int as ultimas_24h,
            max(recorded_at) as mas_reciente
       from events.dead_letter_events`,
  );
  const { rows: porCola } = await pool.query<{ source_queue: string | null; total: number }>(
    `select source_queue, count(1)::int as total
       from events.dead_letter_events
      group by source_queue
      order by total desc`,
  );

  const fila = rows[0];
  return {
    total: fila?.total ?? 0,
    ultimas24h: fila?.ultimas_24h ?? 0,
    masReciente:
      fila?.mas_reciente === null || fila?.mas_reciente === undefined
        ? null
        : fila.mas_reciente.toISOString(),
    porCola: porCola.map((entrada) => ({ cola: entrada.source_queue, total: entrada.total })),
  };
};

/** Los últimos eventos perdidos, para mirarlos a mano (herramientas de consola). */
export const listRecentDeadLetters = async (
  pool: pg.Pool,
  limit = 20,
): Promise<(DeadLetterRecord & { id: string })[]> => {
  const { rows } = await pool.query(
    `select id, job_id, source_queue, source_job_id, event_id, event_type, producer, aggregate_id,
            payload, error, retry_count, failed_at, recorded_at
       from events.dead_letter_events
      order by recorded_at desc
      limit $1`,
    [Math.min(Math.max(Math.trunc(limit), 1), 200)],
  );

  return rows.map((fila) => ({
    id: String(fila.id),
    jobId: String(fila.job_id),
    sourceQueue: fila.source_queue ?? null,
    sourceJobId: fila.source_job_id ?? null,
    eventId: fila.event_id ?? null,
    eventType: fila.event_type ?? null,
    producer: fila.producer ?? null,
    aggregateId: fila.aggregate_id ?? null,
    payload: fila.payload,
    error: fila.error ?? null,
    retryCount: fila.retry_count ?? 0,
    failedAt: new Date(fila.failed_at).toISOString(),
    recordedAt: new Date(fila.recorded_at).toISOString(),
  }));
};
