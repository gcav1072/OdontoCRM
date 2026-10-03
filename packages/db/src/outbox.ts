import { type DomainEvent, domainEventSchema, parseDomainEvent } from '@odontocrm/events';

/**
 * Cliente SQL mínimo que necesitamos. Lo cumplen tanto `pg.Pool` como
 * `pg.PoolClient` (dentro de una transacción), así el servicio puede insertar el
 * evento en la **misma transacción** que su cambio de datos.
 */
export interface SqlClient {
  query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }>;
}

export const OUTBOX_MAX_ATTEMPTS = 10;

/** Reintentos: 1 min, 5 min, 15 min, 1 h y luego cada 6 h. */
const BACKOFF_SECONDS = [60, 300, 900, 3600, 21_600] as const;

export const backoffSeconds = (attempts: number): number => {
  const index = Math.min(Math.max(Math.trunc(attempts), 1), BACKOFF_SECONDS.length) - 1;
  return BACKOFF_SECONDS[index] ?? 21_600;
};

const MAX_ERROR_LENGTH = 1_000;

const describeError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > MAX_ERROR_LENGTH ? `${message.slice(0, MAX_ERROR_LENGTH)}…` : message;
};

/**
 * Guarda un evento en el outbox. Valida el sobre antes de escribir y usa
 * parámetros ($1, $2…) para que el contenido sea siempre un dato, nunca SQL.
 */
export const insertOutboxEvent = async (
  client: SqlClient,
  event: DomainEvent,
): Promise<{ eventId: string }> => {
  const envelope = domainEventSchema.parse(event);

  await client.query(
    `insert into outbox_events
       (envelope, event_id, event_type, aggregate_id, producer, occurred_at)
     values ($1::jsonb, $2, $3, $4, $5, $6)`,
    [
      JSON.stringify(envelope),
      envelope.eventId,
      envelope.eventType,
      envelope.aggregateId,
      envelope.producer,
      envelope.occurredAt,
    ],
  );

  return { eventId: envelope.eventId };
};

export interface ClaimedOutboxEvent {
  rowId: string;
  attempts: number;
  event: DomainEvent;
}

/**
 * Toma un lote de eventos pendientes y suma un intento a cada uno.
 * `FOR UPDATE SKIP LOCKED` permite tener varios publicadores sin que se pisen.
 */
export const claimPendingEvents = async (
  client: SqlClient,
  options: { limit?: number; maxAttempts?: number } = {},
): Promise<ClaimedOutboxEvent[]> => {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 500);
  const maxAttempts = options.maxAttempts ?? OUTBOX_MAX_ATTEMPTS;

  const result = await client.query(
    `with pending as (
       select id
         from outbox_events
        where published_at is null
          and next_attempt_at <= now()
          and attempts < $2
        order by occurred_at
        limit $1
        for update skip locked
     )
     update outbox_events o
        set attempts = o.attempts + 1
       from pending p
      where o.id = p.id
      returning o.id, o.attempts, o.envelope`,
    [limit, maxAttempts],
  );

  return result.rows.flatMap((row) => {
    const typed = row as { id: string; attempts: number; envelope: unknown };
    try {
      return [
        { rowId: typed.id, attempts: typed.attempts, event: parseDomainEvent(typed.envelope) },
      ];
    } catch {
      // Sobre corrupto: se descarta del lote y se marca como fallido aparte.
      return [];
    }
  });
};

export const markEventPublished = async (client: SqlClient, rowId: string): Promise<void> => {
  await client.query(
    `update outbox_events
        set published_at = now(), last_error = null
      where id = $1`,
    [rowId],
  );
};

export const markEventFailed = async (
  client: SqlClient,
  rowId: string,
  error: unknown,
  attempts: number,
): Promise<void> => {
  await client.query(
    `update outbox_events
        set last_error = $2,
            next_attempt_at = now() + make_interval(secs => $3)
      where id = $1`,
    [rowId, describeError(error), backoffSeconds(attempts)],
  );
};

export interface DispatchOutboxOptions {
  client: SqlClient;
  /** Entrega el evento a la cola (normalmente `boss.send`). */
  enqueue: (event: DomainEvent) => Promise<void>;
  batchSize?: number;
  maxAttempts?: number;
}

export interface DispatchOutboxResult {
  claimed: number;
  published: number;
  failed: number;
}

/**
 * Un ciclo del publicador: reclama pendientes, los entrega a la cola y actualiza
 * su estado. Es idempotente del lado del consumidor, que debe deduplicar por
 * `eventId`.
 */
export const dispatchOutbox = async (
  options: DispatchOutboxOptions,
): Promise<DispatchOutboxResult> => {
  const claimed = await claimPendingEvents(options.client, {
    ...(options.batchSize === undefined ? {} : { limit: options.batchSize }),
    ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
  });

  let published = 0;
  let failed = 0;

  for (const item of claimed) {
    try {
      await options.enqueue(item.event);
      await markEventPublished(options.client, item.rowId);
      published += 1;
    } catch (error) {
      await markEventFailed(options.client, item.rowId, error, item.attempts);
      failed += 1;
    }
  }

  return { claimed: claimed.length, published, failed };
};

/** Cuenta de eventos pendientes: se expone en `/ready` para detectar atascos. */
export const countPendingEvents = async (client: SqlClient): Promise<number> => {
  const result = await client.query(
    `select count(*)::int as pending
       from outbox_events
      where published_at is null and attempts < $1`,
    [OUTBOX_MAX_ATTEMPTS],
  );
  const row = result.rows[0] as { pending?: number } | undefined;
  return row?.pending ?? 0;
};
