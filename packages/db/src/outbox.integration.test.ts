import { createDomainEvent, EVENT_TOPICS, type DomainEvent } from '@odontocrm/events';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createBoss,
  DOMAIN_EVENTS_QUEUE,
  enqueueDomainEvent,
  ensureDomainEventsQueue,
  startBoss,
  stopBoss,
} from './boss.js';
import { claimPendingEvents, dispatchOutbox, insertOutboxEvent } from './outbox.js';

/**
 * Pruebas de integración del outbox y de la cola real.
 *
 * Se ejecutan **solo** si existe `TEST_DATABASE_URL` apuntando a una base con las
 * migraciones aplicadas (por ejemplo la de identity en desarrollo). No forman
 * parte de `npm test` por defecto:
 *
 *   $env:TEST_DATABASE_URL = (leer DATABASE_URL de services/identity/.env)
 *   node --env-file=services/identity/.env ./node_modules/vitest/vitest.mjs run `
 *     packages/db/src/outbox.integration.test.ts
 */
const connectionString = process.env['TEST_DATABASE_URL'];
const describeWithDatabase = connectionString === undefined ? describe.skip : describe;

const marker = `prueba-${String(Date.now())}`;

describeWithDatabase('outbox transaccional (PostgreSQL real)', () => {
  let client: pg.Client;

  beforeAll(async () => {
    client = new pg.Client({ connectionString, application_name: 'odontocrm-test-outbox' });
    await client.connect();
  });

  afterAll(async () => {
    await client.query('delete from outbox_events where producer = $1', [marker]);
    await client.end();
  });

  const anEvent = (topic = EVENT_TOPICS.requestCreated): DomainEvent =>
    createDomainEvent({
      topic,
      aggregateId: globalThis.crypto.randomUUID(),
      producer: marker,
      payload: { origen: 'prueba de integracion' },
    });

  it('guarda, entrega y marca como publicado dejando el rastro en la tabla', async () => {
    const event = anEvent();
    await insertOutboxEvent(client, event);

    const delivered: DomainEvent[] = [];
    const result = await dispatchOutbox({
      client,
      enqueue: (queued) => {
        delivered.push(queued);
        return Promise.resolve();
      },
    });

    expect(result.published).toBeGreaterThanOrEqual(1);
    expect(delivered.map((item) => item.eventId)).toContain(event.eventId);

    const { rows } = await client.query(
      'select published_at, attempts from outbox_events where event_id = $1',
      [event.eventId],
    );
    const row = rows[0] as { published_at: Date | null; attempts: number } | undefined;

    expect(row?.published_at).not.toBeNull();
    expect(row?.attempts).toBe(1);
  });

  it('no permite guardar dos veces el mismo eventId', async () => {
    const event = anEvent();
    await insertOutboxEvent(client, event);
    await expect(insertOutboxEvent(client, event)).rejects.toThrow();
  });

  it('reintenta más tarde y no vuelve a reclamar el evento cuando la entrega falla', async () => {
    const event = anEvent();
    await insertOutboxEvent(client, event);

    const failed = await dispatchOutbox({
      client,
      enqueue: () => Promise.reject(new Error('cola no disponible')),
    });
    expect(failed.failed).toBeGreaterThanOrEqual(1);

    const { rows } = await client.query(
      'select published_at, attempts, next_attempt_at, last_error from outbox_events where event_id = $1',
      [event.eventId],
    );
    const row = rows[0] as
      | {
          published_at: Date | null;
          attempts: number;
          next_attempt_at: Date;
          last_error: string | null;
        }
      | undefined;

    expect(row?.published_at).toBeNull();
    expect(row?.last_error).toContain('cola no disponible');
    expect(new Date(row?.next_attempt_at ?? 0).getTime()).toBeGreaterThan(Date.now());

    const claimed = await claimPendingEvents(client, { limit: 100 });
    expect(claimed.map((item) => item.event.eventId)).not.toContain(event.eventId);
  });
});

describeWithDatabase('cola pg-boss sobre PostgreSQL (real)', () => {
  it(
    'declara la cola, publica un evento y lo consume un trabajador',
    async () => {
      if (connectionString === undefined) throw new Error('sin TEST_DATABASE_URL');

      const boss = createBoss({
        connectionString,
        applicationName: 'odontocrm-test-queue',
        maxConnections: 2,
      });

      const received: DomainEvent[] = [];
      let workerId: string | undefined;

      try {
        await startBoss(boss);
        await ensureDomainEventsQueue(boss);

        workerId = await boss.work<DomainEvent, void>(DOMAIN_EVENTS_QUEUE, async (jobs) => {
          for (const job of jobs) received.push(job.data);
        });

        const event = createDomainEvent({
          topic: EVENT_TOPICS.appointmentScheduled,
          aggregateId: globalThis.crypto.randomUUID(),
          producer: marker,
          payload: { ticket: '#000123' },
        });

        await enqueueDomainEvent(boss, event);

        const deadline = Date.now() + 20_000;
        while (received.length === 0 && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 250));
        }

        expect(received.map((item) => item.eventId)).toContain(event.eventId);
      } finally {
        if (workerId !== undefined) {
          await boss.offWork(DOMAIN_EVENTS_QUEUE).catch(() => undefined);
        }
        await stopBoss(boss).catch(() => undefined);
      }
    },
    40_000,
  );
});
