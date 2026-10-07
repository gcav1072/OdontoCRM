import { createDomainEvent, EVENT_TOPICS, type DomainEvent } from '@odontocrm/events';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createBoss,
  DEAD_LETTER_QUEUE,
  ensureDeadLetterQueue,
  startBoss,
  stopBoss,
} from './boss.js';
import { deadLetterStats, insertDeadLetter, listRecentDeadLetters } from './dead-letter.js';
import { startDeadLetterWatcher } from './dead-letter-watcher.js';

/**
 * El vigilante de la cola de descarte, contra **PostgreSQL y pg-boss de verdad**.
 *
 * Es la prueba que importa de esta mejora: lo que se quiere demostrar es que un evento que
 * agota sus reintentos **no se pierde en silencio** —queda apuntado con su motivo y dispara
 * el aviso—, y eso solo se comprueba dejando fallar un trabajo de verdad. Con dobles se
 * probaría la traducción del registro, no que `pg-boss` copie el trabajo a la cola de
 * descarte (que es la pieza que se podría estar usando mal).
 *
 * Se ejecuta solo si existe `TEST_DATABASE_URL` (la base de eventos del entorno):
 *
 *   $env:TEST_DATABASE_URL = (leer EVENTS_DATABASE_URL de services/identity/.env)
 */
const connectionString = process.env['TEST_DATABASE_URL'];
const describeWithDatabase = connectionString === undefined ? describe.skip : describe;

/** Cola propia de la prueba: los servicios trabajan las suyas. */
const COLA = `domain-events.prueba-dlq-${String(Date.now()).slice(-6)}`;

describeWithDatabase('cola de descarte (pg-boss real)', () => {
  let boss: Awaited<ReturnType<typeof createBoss>>;
  let pool: pg.Pool;

  beforeAll(async () => {
    if (connectionString === undefined) throw new Error('sin TEST_DATABASE_URL');
    pool = new pg.Pool({ connectionString, application_name: 'odontocrm-test-dlq' });
    boss = createBoss({
      connectionString,
      applicationName: 'odontocrm-test-dlq',
      maxConnections: 2,
    });
    await startBoss(boss);
    // La cola de la prueba falla **a la primera** (`retryLimit: 0`): así el trabajo pasa a la
    // cola de descarte en segundos y no hay que esperar cinco reintentos con retroceso.
    await ensureDeadLetterQueue(boss);
    await boss.createQueue(COLA, { retryLimit: 0, deadLetter: DEAD_LETTER_QUEUE });
  }, 30_000);

  afterAll(async () => {
    if (!boss) return;
    // La fila de la prueba se borra por su cola de origen: es lo único que la distingue.
    await pool
      .query(`delete from events.dead_letter_events where source_queue = $1`, [COLA])
      .catch(() => undefined);
    await boss.deleteQueue(COLA).catch(() => undefined);
    await stopBoss(boss);
    await pool.end();
  });

  /** Un evento cualquiera: lo que importa es que falle la entrega, no su contenido. */
  const unEvento = (): DomainEvent =>
    createDomainEvent({
      topic: EVENT_TOPICS.patientCreated,
      aggregateId: globalThis.crypto.randomUUID(),
      producer: 'prueba-dlq',
      payload: { patientId: globalThis.crypto.randomUUID(), nombre: 'Paciente de prueba' },
    });

  /** Espera a que se cumpla la condición, con tope de tiempo. */
  const esperarA = async (condicion: () => boolean, ms: number, que: string): Promise<void> => {
    const limite = Date.now() + ms;
    while (!condicion()) {
      if (Date.now() > limite) throw new Error(`tiempo agotado esperando ${que}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  };

  it('un evento que agota sus reintentos queda apuntado con su motivo y avisa', async () => {
    if (connectionString === undefined) throw new Error('sin TEST_DATABASE_URL');

    const avisos: {
      eventId: string | null;
      eventType: string | null;
      error: string | null;
      esNuevo: boolean;
    }[] = [];
    const watcher = await startDeadLetterWatcher({
      boss,
      connectionString,
      applicationName: 'odontocrm-test-dlq-watcher',
      onDeadLetter: (record, esNuevo) => {
        avisos.push({
          eventId: record.eventId,
          eventType: record.eventType,
          error: record.error,
          esNuevo,
        });
      },
    });

    /** Lo que «falla»: un consumidor que revienta con todos los eventos que recibe. */
    let falladorId = '';
    try {
      falladorId = await boss.work(COLA, async () => {
        throw new Error('la proyección no pudo escribir');
      });

      const evento = unEvento();
      await boss.send(COLA, evento);

      // El trabajo falla, `pg-boss` lo copia a la cola de descarte y el vigilante lo apunta.
      // Se espera **al de este evento** y no al primero que llegue: la cola de descarte la
      // comparten todos los servicios y en una base de desarrollo puede haber más de uno.
      await esperarA(
        () => avisos.some((aviso) => aviso.eventId === evento.eventId),
        15_000,
        'el aviso del evento perdido',
      );
      await esperarA(() => watcher.apuntados() >= 1, 5_000, 'el apunte en la tabla');

      const aviso = avisos.find((entrada) => entrada.eventId === evento.eventId);
      expect(aviso?.eventType).toBe(EVENT_TOPICS.patientCreated);
      expect(aviso?.error).toContain('la proyección no pudo escribir');
      expect(aviso?.esNuevo).toBe(true);

      // Y está en la tabla, con el sobre completo: es lo que se mira dentro de un mes.
      const filas = await listRecentDeadLetters(pool, 50);
      const fila = filas.find((entrada) => entrada.eventId === evento.eventId);
      expect(fila).toBeDefined();
      expect(fila?.sourceQueue).toBe(COLA);
      expect(fila?.producer).toBe('prueba-dlq');
      expect(fila?.error).toContain('la proyección no pudo escribir');
      expect((fila?.payload as { payload?: { nombre?: string } })?.payload?.nombre).toBe(
        'Paciente de prueba',
      );

      // El resumen que enseña el tablero cuenta lo mismo.
      const resumen = await deadLetterStats(pool);
      expect(resumen.total).toBeGreaterThanOrEqual(1);
      expect(resumen.porCola.some((entrada) => entrada.cola === COLA)).toBe(true);
    } finally {
      if (falladorId !== '')
        await boss.offWork(COLA, { id: falladorId, wait: true }).catch(() => undefined);
      await watcher.stop();
    }
  }, 60_000);

  it('apuntar dos veces el mismo trabajo no duplica la fila ni el aviso', async () => {
    if (connectionString === undefined) throw new Error('sin TEST_DATABASE_URL');

    const registro = {
      jobId: `prueba-duplicado-${String(Date.now())}`,
      sourceQueue: COLA,
      sourceJobId: null,
      eventId: globalThis.crypto.randomUUID(),
      eventType: EVENT_TOPICS.patientCreated,
      producer: 'prueba-dlq',
      aggregateId: null,
      payload: { prueba: true },
      error: 'fallo de prueba',
      retryCount: 0,
      failedAt: new Date().toISOString(),
      recordedAt: new Date().toISOString(),
    };

    // La primera vez se escribe; la segunda no (y por eso quien llama no repite el aviso).
    await expect(insertDeadLetter(pool, registro)).resolves.toBe(true);
    await expect(insertDeadLetter(pool, registro)).resolves.toBe(false);

    const { rows } = await pool.query<{ total: number }>(
      `select count(1)::int as total from events.dead_letter_events where job_id = $1`,
      [registro.jobId],
    );
    expect(rows[0]?.total).toBe(1);

    await pool.query(`delete from events.dead_letter_events where job_id = $1`, [registro.jobId]);
  }, 30_000);
});
