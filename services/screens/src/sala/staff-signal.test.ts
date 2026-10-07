import {
  createDomainEvent,
  EVENT_TOPICS,
  type DomainEvent,
  type EventTopic,
} from '@odontocrm/events';
import { describe, expect, it } from 'vitest';

import { STAFF_TOPICS, staffSignals } from './staff-signal.js';

/**
 * El canal del personal manda **avisos**, no estado: la interfaz que escucha ya tiene los
 * datos y lo único que necesita saber es qué la dejó vieja. Esta es la parte que decide
 * *cuándo* suena, así que se prueba sin base de datos ni cola.
 */

const paciente = '11111111-1111-4111-8111-111111111111';
const factura = '22222222-2222-4222-8222-222222222222';

const evento = (topic: EventTopic, aggregateId = paciente, ocurridoEn?: string): DomainEvent =>
  createDomainEvent({
    topic,
    aggregateId,
    producer: 'clinical',
    ...(ocurridoEn === undefined ? {} : { occurredAt: new Date(ocurridoEn) }),
  });

describe('los avisos al personal', () => {
  it('un evento interesante produce un aviso con su tema, su hora y su agregado', () => {
    const avisos = staffSignals([evento(EVENT_TOPICS.sessionClosed)]);
    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toMatchObject({ topic: EVENT_TOPICS.sessionClosed, aggregateId: paciente });
    expect(typeof avisos[0]?.at).toBe('string');
  });

  it('lo que no le interesa a nadie no suena', () => {
    // El alta de un usuario no cambia ninguna pantalla de recepción ni de caja.
    expect(staffSignals([evento(EVENT_TOPICS.userCreated)])).toEqual([]);
  });

  it('varios eventos del MISMO tema suenan una sola vez', () => {
    const avisos = staffSignals([
      evento(EVENT_TOPICS.invoiceIssued, factura),
      evento(EVENT_TOPICS.invoiceIssued, factura),
      evento(EVENT_TOPICS.invoiceIssued, factura),
    ]);
    expect(avisos).toHaveLength(1);
  });

  it('conserva el primero de cada tema, no el último', () => {
    const primero = '2026-10-07T10:00:00.000Z';
    const ultimo = '2026-10-07T11:00:00.000Z';
    // El lote llega desordenado a propósito: el aviso tiene que ser del más antiguo.
    const avisos = staffSignals([
      evento(EVENT_TOPICS.appointmentCalled, paciente, ultimo),
      evento(EVENT_TOPICS.appointmentCalled, paciente, primero),
    ]);
    expect(avisos[0]?.at).toBe(primero);
  });

  it('temas distintos del mismo lote producen un aviso cada uno, en orden de hora', () => {
    // El lote llega desordenado: los avisos salen por **hora del evento**, no por el orden
    // en que pg-boss los entregó (entre eventos del mismo instante el orden es indiferente:
    // cada aviso solo invalida una caché).
    const avisos = staffSignals([
      evento(EVENT_TOPICS.invoiceIssued, factura, '2026-10-07T11:00:00.000Z'),
      evento(EVENT_TOPICS.sessionClosed, paciente, '2026-10-07T10:00:00.000Z'),
      evento(EVENT_TOPICS.appointmentAttended, paciente, '2026-10-07T12:00:00.000Z'),
    ]);
    expect(avisos.map((senal) => senal.topic)).toEqual([
      EVENT_TOPICS.sessionClosed,
      EVENT_TOPICS.invoiceIssued,
      EVENT_TOPICS.appointmentAttended,
    ]);
  });

  it('un lote vacío no manda nada', () => {
    expect(staffSignals([])).toEqual([]);
  });

  it('la lista de temas es la que dice qué despierta a la interfaz', () => {
    // Si alguien añade un tema al canal sin querer, esto lo obliga a ser deliberado.
    expect(STAFF_TOPICS).toContain(EVENT_TOPICS.sessionClosed);
    expect(STAFF_TOPICS).toContain(EVENT_TOPICS.invoiceIssued);
    expect(STAFF_TOPICS).toContain(EVENT_TOPICS.appointmentCalled);
    expect(STAFF_TOPICS).not.toContain(EVENT_TOPICS.userCreated);
    // Sin duplicados: un tema repetido en la lista haría que `staffSignals` se confunda.
    expect(new Set(STAFF_TOPICS).size).toBe(STAFF_TOPICS.length);
  });
});
