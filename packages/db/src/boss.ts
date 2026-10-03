import { PgBoss } from 'pg-boss';

import { DOMAIN_EVENTS_QUEUE, type DomainEvent } from '@odontocrm/events';

export { DOMAIN_EVENTS_QUEUE };
export type { DomainEvent };

export interface CreateBossOptions {
  connectionString: string;
  /** Esquema donde pg-boss crea sus tablas; separado del esquema del servicio. */
  schema?: string;
  maxConnections?: number;
  applicationName?: string;
}

/**
 * Crea el cliente de `pg-boss`. Con el patrón outbox + cola sobre PostgreSQL no
 * hace falta RabbitMQ ni Redis: la cola vive en la misma base del servicio.
 */
export const createBoss = (options: CreateBossOptions): PgBoss =>
  new PgBoss({
    connectionString: options.connectionString,
    schema: options.schema ?? 'pgboss',
    max: options.maxConnections ?? 4,
    application_name: options.applicationName ?? 'odontocrm-events',
  });

/** Arranca pg-boss (crea/actualiza su esquema si hace falta). */
export const startBoss = async (boss: PgBoss): Promise<PgBoss> => boss.start();

export const stopBoss = async (boss: PgBoss): Promise<void> => {
  await boss.stop({ graceful: true, timeout: 5_000 });
};

/**
 * Declara la cola de eventos de dominio. `createQueue` es idempotente (crea o
 * actualiza las opciones), así que puede llamarse en cada arranque.
 *
 * Retención: los trabajos completados se borran a los 7 días (suficiente para
 * auditar entregas sin que las tablas crezcan sin control) y los fallidos se
 * reintentan hasta 5 veces con retroceso exponencial.
 */
export const ensureDomainEventsQueue = async (boss: PgBoss): Promise<void> => {
  await boss.createQueue(DOMAIN_EVENTS_QUEUE, {
    deleteAfterSeconds: 7 * 24 * 60 * 60,
    expireInSeconds: 5 * 60,
    retryLimit: 5,
    retryBackoff: true,
    retryDelay: 60,
  });
};

/** Entrega un evento de dominio a la cola (usado como `enqueue` del outbox). */
export const enqueueDomainEvent = async (boss: PgBoss, event: DomainEvent): Promise<void> => {
  const jobId = await boss.send(DOMAIN_EVENTS_QUEUE, event as unknown as object, {
    singletonKey: event.eventId,
  });
  if (jobId === null) {
    throw new Error(`La cola ${DOMAIN_EVENTS_QUEUE} rechazó el evento ${event.eventId}`);
  }
};

export type DomainEventHandler = (events: DomainEvent[]) => Promise<void>;

/** Opciones del trabajador de la cola: lotes grandes y sondeo frecuente. */
export interface DomainEventWorkerOptions {
  /** Cuántos eventos se llevan por ciclo (por defecto 50). */
  batchSize?: number;
  /** Cada cuántos segundos se sondea la cola (por defecto 1). */
  pollingIntervalSeconds?: number;
}

/**
 * Registra el consumidor de la cola. El manejador recibe un lote y debe ser
 * idempotente: deduplica por `eventId` antes de aplicar efectos.
 *
 * El tamaño del lote importa: con el valor por defecto (un evento por ciclo y
 * sondeo cada 2 s) un pico de 150 eventos tardaba minutos en vaciarse, y la
 * auditoría aparecía con retraso. Con 50 por ciclo y sondeo cada segundo la cola
 * se vacía en segundos.
 */
export const registerDomainEventHandler = async (
  boss: PgBoss,
  handler: DomainEventHandler,
  options: DomainEventWorkerOptions = {},
): Promise<string> => {
  await ensureDomainEventsQueue(boss);
  return boss.work<DomainEvent, void>(
    DOMAIN_EVENTS_QUEUE,
    {
      batchSize: options.batchSize ?? 50,
      pollingIntervalSeconds: options.pollingIntervalSeconds ?? 1,
    },
    async (jobs) => {
      await handler(jobs.map((job) => job.data));
    },
  );
};
