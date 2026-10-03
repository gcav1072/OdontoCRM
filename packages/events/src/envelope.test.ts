import { describe, expect, it } from 'vitest';

import { createDomainEvent, domainEventSchema, parseDomainEvent } from './envelope.js';
import { EVENT_TOPIC_VALUES, EVENT_TOPICS } from './topics.js';

describe('catálogo de eventos', () => {
  it('no tiene tópicos duplicados', () => {
    expect(new Set(EVENT_TOPIC_VALUES).size).toBe(EVENT_TOPIC_VALUES.length);
  });

  it('todos los tópicos usan la convención dominio.entidad.accion', () => {
    for (const topic of EVENT_TOPIC_VALUES) {
      expect(topic).toMatch(/^[a-z]+\.[a-z_]+\.[a-z_]+$/);
    }
  });
});

describe('sobre de evento', () => {
  const aggregateId = globalThis.crypto.randomUUID();

  it('construye un evento válido y serializable', () => {
    const event = createDomainEvent({
      topic: EVENT_TOPICS.appointmentScheduled,
      aggregateId,
      producer: 'scheduling',
      payload: { ticket: '#000123' },
      actorId: null,
      correlationId: 'req-1',
    });

    expect(domainEventSchema.safeParse(event).success).toBe(true);
    expect(event.version).toBe(1);
    expect(JSON.parse(JSON.stringify(event))).toEqual(event);
  });

  it('usa la fecha recibida para que el outbox sea determinista en pruebas', () => {
    const occurredAt = new Date('2026-10-02T14:30:00.000Z');
    const event = createDomainEvent({
      topic: EVENT_TOPICS.requestCreated,
      aggregateId,
      producer: 'scheduling',
      occurredAt,
    });

    expect(event.occurredAt).toBe('2026-10-02T14:30:00.000Z');
  });

  it('rechaza eventos con tópico desconocido o id inválido', () => {
    const base = createDomainEvent({
      topic: EVENT_TOPICS.requestCreated,
      aggregateId,
      producer: 'scheduling',
    });

    expect(() => parseDomainEvent({ ...base, eventType: 'inventado.evento.raro' })).toThrow();
    expect(() => parseDomainEvent({ ...base, aggregateId: 'no-es-uuid' })).toThrow();
    expect(() => parseDomainEvent({ ...base, occurredAt: 'ayer' })).toThrow();
  });
});
