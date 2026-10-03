import { createDomainEvent, EVENT_TOPICS } from '@odontocrm/events';
import { describe, expect, it } from 'vitest';

import { backoffSeconds, OUTBOX_MAX_ATTEMPTS } from './outbox.js';

describe('reintentos del outbox', () => {
  it('crece con los intentos y se estanca en el máximo', () => {
    expect(backoffSeconds(1)).toBe(60);
    expect(backoffSeconds(2)).toBe(300);
    expect(backoffSeconds(3)).toBe(900);
    expect(backoffSeconds(4)).toBe(3_600);
    expect(backoffSeconds(5)).toBe(21_600);
    expect(backoffSeconds(50)).toBe(21_600);
  });

  it('tolera intentos en cero o negativos sin devolver valores absurdos', () => {
    expect(backoffSeconds(0)).toBe(60);
    expect(backoffSeconds(-3)).toBe(60);
  });

  it('declara un tope de intentos razonable', () => {
    expect(OUTBOX_MAX_ATTEMPTS).toBeGreaterThanOrEqual(5);
    expect(OUTBOX_MAX_ATTEMPTS).toBeLessThanOrEqual(20);
  });
});

describe('sobre de evento del outbox', () => {
  it('acepta los eventos que produce el catálogo', () => {
    const event = createDomainEvent({
      topic: EVENT_TOPICS.patientCreated,
      aggregateId: globalThis.crypto.randomUUID(),
      producer: 'patients',
    });

    expect(JSON.parse(JSON.stringify(event))).toMatchObject({
      eventType: 'patients.patient.created',
      producer: 'patients',
    });
  });
});
