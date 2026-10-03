import { type DomainEvent, domainEventSchema } from '@odontocrm/events';

import type { NewOutboxEventRow } from './schema/outbox.js';

/**
 * Fila lista para insertar con Drizzle **dentro de la transacción** del cambio de
 * datos (patrón outbox). Valida el sobre del evento y extrae las columnas que se
 * indexan aparte del JSON completo.
 *
 *   await db.transaction(async (tx) => {
 *     await tx.update(patients).set(...)…;
 *     await tx.insert(outboxEvents).values(toOutboxInsert(event));
 *   });
 */
export const toOutboxInsert = (event: DomainEvent): Omit<NewOutboxEventRow, 'id'> => {
  const envelope = domainEventSchema.parse(event);
  return {
    envelope: envelope as unknown as Record<string, unknown>,
    eventId: envelope.eventId,
    eventType: envelope.eventType,
    aggregateId: envelope.aggregateId,
    producer: envelope.producer,
    occurredAt: new Date(envelope.occurredAt),
  };
};
