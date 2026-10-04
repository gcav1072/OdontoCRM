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
 * Servicios que **consumen** eventos: los que registran un manejador de la cola
 * (`registerDomainEventHandler`). Son cinco; `scheduling`, `clinical` y
 * `odontogram` solo publican, y el gateway es borde puro.
 *
 * La lista tiene que ser exacta en los dos sentidos: si falta un consumidor, sus
 * eventos se pierden cuando la pila arranca desordenada; si sobra uno, se le crea
 * una cola que nadie trabaja y el tablero de estado la denuncia para siempre. Hay
 * una prueba que la compara con el código de los servicios (`boss.test.ts`).
 */
export const EVENT_CONSUMERS: readonly string[] = [
  'identity',
  'patients',
  'notifications',
  'screens',
  'reporting',
];

/**
 * Declara **todas** las colas de consumidores antes de publicar.
 *
 * Existe por un fallo medido en la puesta en marcha del 2026-10-04: la lista de
 * colas es una foto y `enqueueDomainEvent` publica solo donde ya hay cola, así que
 * los eventos que un servicio publicaba **mientras otro todavía arrancaba** no
 * llegaban nunca a ese consumidor (con la pila recién levantada, los 10 primeros
 * altas de paciente y los 30 primeros hallazgos se quedaron sin proyectar en
 * reportes; el mismo agujero afectaba a la auditoría y a las pantallas). Ahora el
 * publicador garantiza las colas conocidas **antes** de su primer envío, y el
 * orden de arranque deja de importar.
 */
export const ensureConsumerQueues = async (
  boss: PgBoss,
  /** Nombres de cola **completos**; por defecto, la de cada consumidor conocido. */
  queues: readonly string[] = EVENT_CONSUMERS.map(consumerQueueName),
): Promise<void> => {
  await Promise.all(queues.map((queue) => ensureDomainEventsQueue(boss, queue)));
};

/** Lo mínimo que necesita el publicador: así se puede probar con un doble. */
export interface DomainEventQueueClient {
  getQueues(): Promise<{ name: string }[]>;
  send(name: string, data: object, options?: { singletonKey?: string }): Promise<string | null>;
}

/**
 * Entrega un evento a **todas** las colas de consumidores (usado por el outbox).
 *
 * pg-boss da cada trabajo a **un solo** trabajador: con una única cola compartida,
 * los servicios se repartirían los eventos en vez de recibirlos todos (identity
 * auditaba unos y notifications no se enteraba de otros). Cada servicio declara su
 * cola (`domain-events.<servicio>`) y aquí se publica una copia en cada una, así
 * que todos ven todos los eventos y añadir un consumidor no toca a los demás.
 *
 * Se publica **solo en colas de consumidor** (`domain-events.<algo>`). La cola
 * padre `domain-events` no la trabaja nadie en este despliegue: recibía una copia
 * por evento que se quedaba en `created` para siempre (la retención de pg-boss solo
 * borra las completadas) y llegó a acumular más de mil trabajos muertos. Solo se
 * usa como último recurso, cuando no hay ninguna cola de consumidor declarada.
 *
 * ⚠️ **La lista de colas es una foto, y las colas pueden desaparecer después.**
 * Entre `getQueues()` y `send()` cabe una eliminación (en las pruebas, cada suite
 * borra su cola al terminar mientras otra sigue publicando; en operación, un
 * `deleteQueue` a mano), y el `insert` de pg-boss revienta con una violación de
 * clave foránea contra `queue`. Cuando eso pasa, la foto está caducada: se vuelve a
 * pedir la lista y se reintenta **una vez**, así el evento no se queda atascado ni
 * pierde su intento por una cola que ya no existe.
 */
export const enqueueDomainEvent = async (
  boss: DomainEventQueueClient,
  event: DomainEvent,
  /** Cola concreta (una suite de pruebas con su propia cola); si falta, todas. */
  onlyQueue?: string,
): Promise<void> => {
  const consumersOf = async (): Promise<string[]> =>
    onlyQueue === undefined
      ? (await boss.getQueues())
          .map((queue) => queue.name)
          .filter((name) => name.startsWith(`${DOMAIN_EVENTS_QUEUE}.`))
      : [onlyQueue];

  const publishTo = async (queues: readonly string[]): Promise<(string | null)[]> => {
    const objetivo = queues.length > 0 ? queues : [DOMAIN_EVENTS_QUEUE];
    return Promise.all(
      objetivo.map((queue) =>
        boss.send(queue, event as unknown as object, {
          // La misma clave en cada cola: si el outbox reintenta, no se duplica.
          singletonKey: event.eventId,
        }),
      ),
    );
  };

  const first = await consumersOf();
  let results: (string | null)[];
  try {
    results = await publishTo(first);
  } catch (error) {
    // Foto caducada: se descarta y se reintenta con la lista de colas de ahora.
    const refreshed = await consumersOf();
    const descartadas = first.filter((queue) => !refreshed.includes(queue));
    if (descartadas.length === 0) throw error;
    results = await publishTo(refreshed);
  }

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
