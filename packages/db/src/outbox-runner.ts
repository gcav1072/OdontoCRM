import type { PgBoss } from 'pg-boss';
import type pg from 'pg';

import { enqueueDomainEvent } from './boss.js';
import { dispatchOutbox, type DispatchOutboxResult } from './outbox.js';

export interface OutboxRunnerOptions {
  pool: pg.Pool;
  boss: PgBoss;
  /** Cada cuánto se revisan los pendientes (por defecto 2 s). */
  intervalMs?: number;
  /** Tamaño del lote por ciclo. */
  batchSize?: number;
  onError?: (error: unknown) => void;
  /** Se llama después de cada ciclo con el resultado (para logs o métricas). */
  onCycle?: (result: DispatchOutboxResult) => void;
}

export interface OutboxRunner {
  /** Ejecuta un ciclo ahora mismo (útil en pruebas y al arrancar). */
  flush: () => Promise<DispatchOutboxResult>;
  /**
   * Adelanta un ciclo **sin esperarlo**: si ya hay uno en curso no hace nada.
   *
   * Lo usan los cambios que tienen que verse ya en otra pantalla (un llamado al
   * displaylobby): sin esto, el aviso esperaría hasta `intervalMs` a que el
   * temporizador mirara el outbox.
   */
  kick: () => void;
  start: () => void;
  stop: () => Promise<void>;
}

/**
 * Publicador del outbox: cada pocos segundos toma los eventos pendientes de la
 * base del servicio y los entrega a la cola `domain-events` de pg-boss.
 *
 * Un ciclo nunca solapa con el siguiente y `stop()` espera al que esté en curso,
 * para que el apagado ordenado no deje un evento a medias.
 */
export const createOutboxRunner = (options: OutboxRunnerOptions): OutboxRunner => {
  const intervalMs = Math.max(500, options.intervalMs ?? 2_000);
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<DispatchOutboxResult> | undefined;

  const flush = async (): Promise<DispatchOutboxResult> => {
    const client = await options.pool.connect();
    try {
      return await dispatchOutbox({
        client,
        enqueue: (event) => enqueueDomainEvent(options.boss, event),
        ...(options.batchSize === undefined ? {} : { batchSize: options.batchSize }),
      });
    } finally {
      client.release();
    }
  };

  const cycle = async (): Promise<void> => {
    if (running !== undefined) return;
    running = flush()
      .then((result) => {
        if (result.claimed > 0) options.onCycle?.(result);
        return result;
      })
      .catch((error: unknown) => {
        options.onError?.(error);
        return { claimed: 0, published: 0, failed: 0 };
      })
      .finally(() => {
        running = undefined;
      });
    await running;
  };

  return {
    flush,
    kick: () => {
      void cycle();
    },
    start: () => {
      if (timer !== undefined) return;
      timer = setInterval(() => {
        void cycle();
      }, intervalMs);
      // No debe mantener vivo el proceso por sí solo.
      timer.unref?.();
    },
    stop: async () => {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
      if (running !== undefined) await running.catch(() => undefined);
    },
  };
};
