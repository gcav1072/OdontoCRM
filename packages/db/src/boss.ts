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
export const ensureDomainEventsQueue = async (
  boss: PgBoss,
  queue: string = DOMAIN_EVENTS_QUEUE,
): Promise<void> => {
  await boss.createQueue(queue, {
    deleteAfterSeconds: 7 * 24 * 60 * 60,
    expireInSeconds: 5 * 60,
    retryLimit: 5,
    retryBackoff: true,
    retryDelay: 60,
  });
};

/** Cola propia de un consumidor concreto (`domain-events.<servicio>`). */
export const consumerQueueName = (service: string): string => `${DOMAIN_EVENTS_QUEUE}.${service}`;

/**
 * Entrega un evento a **todas** las colas de consumidores (usado por el outbox).
 *
 * pg-boss da cada trabajo a **un solo** trabajador: con una única cola compartida,
 * los servicios se repartirían los eventos en vez de recibirlos todos (identity
 * auditaba unos y notifications no se enteraba de otros). Cada servicio declara su
 * cola (`domain-events.<servicio>`) y aquí se publica una copia en cada una, así
 * que todos ven todos los eventos y añadir un consumidor no toca a los demás.
 */
export const enqueueDomainEvent = async (boss: PgBoss, event: DomainEvent): Promise<void> => {
  const known = (await boss.getQueues()).map((queue) => queue.name);
  const targets = known.filter(
    (name) => name === DOMAIN_EVENTS_QUEUE || name.startsWith(`${DOMAIN_EVENTS_QUEUE}.`),
  );

  const queues = targets.length === 0 ? [DOMAIN_EVENTS_QUEUE] : targets;
  const results = await Promise.all(
    queues.map((queue) =>
      boss.send(queue, event as unknown as object, {
        // La misma clave en cada cola: si el outbox reintenta, no se duplica.
        singletonKey: event.eventId,
      }),
    ),
  );

  if (results.every((jobId) => jobId === null)) {
    throw new Error(`Ninguna cola aceptó el evento ${event.eventId}`);
  }
};

export type DomainEventHandler = (events: DomainEvent[]) => Promise<void>;

/** Opciones del trabajador de la cola: lotes grandes y sondeo frecuente. */
export interface DomainEventWorkerOptions {
  /** Cola propia del servicio (`domain-events.<servicio>`). */
  queue: string;
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
  options: DomainEventWorkerOptions,
): Promise<string> => {
  await ensureDomainEventsQueue(boss, options.queue);
  return boss.work<DomainEvent, void>(
    options.queue,
    {
      batchSize: options.batchSize ?? 50,
      pollingIntervalSeconds: options.pollingIntervalSeconds ?? 1,
    },
    async (jobs) => {
      await handler(jobs.map((job) => job.data));
    },
  );
};
