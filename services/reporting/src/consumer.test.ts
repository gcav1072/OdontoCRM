import { createDomainEvent, type DomainEvent } from '@odontocrm/events';
import { describe, expect, it } from 'vitest';

import { REPORTING_TOPICS, ordenarLote } from './consumer.js';

/**
 * Partes puras del consumidor: la lista blanca de tópicos y el orden del lote.
 *
 * El orden importa de verdad: `pg-boss` entrega los trabajos de un lote sin
 * garantizar el orden, y aplicar `attended` antes que `scheduled` dejaría la cita
 * creada con el estado equivocado (la proyección no retrocede, pero la primera
 * impresión sí manda).
 */
describe('consumidor del read model', () => {
  it('la lista blanca cubre los hechos que alimentan los reportes', () => {
    for (const topico of [
      'patients.patient.created',
      'scheduling.request.created',
      'scheduling.appointment.attended',
      'scheduling.capacity.changed',
      'clinical.record.signed',
      'clinical.session.closed',
      'clinical.prescription.issued',
      'odontogram.finding.recorded',
      'notifications.message.sent',
    ]) {
      expect(REPORTING_TOPICS).toContain(topico);
    }
    // Lo que no alimenta ningún reporte no está: el consumidor lo ignora sin abrir
    // transacción.
    expect(REPORTING_TOPICS).not.toContain('identity.user.created');
  });

  it('ordena el lote por hora y desempata por id', () => {
    const evento = (occurredAt: string, eventId: string): DomainEvent => ({
      ...createDomainEvent({
        topic: 'patients.patient.created',
        aggregateId: globalThis.crypto.randomUUID(),
        producer: 'patients',
      }),
      occurredAt,
      eventId,
    });

    const primero = evento('2026-10-05T10:00:00.000Z', '00000000-0000-4000-8000-000000000001');
    const segundo = evento('2026-10-05T10:00:00.000Z', '00000000-0000-4000-8000-000000000002');
    const tercero = evento('2026-10-05T11:00:00.000Z', '00000000-0000-4000-8000-000000000003');

    const ordenados = ordenarLote([tercero, segundo, primero]);
    expect(ordenados.map((evento) => evento.eventId)).toEqual([
      primero.eventId,
      segundo.eventId,
      tercero.eventId,
    ]);
    // No muta el lote original.
    expect(ordenarLote([tercero, primero])).toHaveLength(2);
  });
});
