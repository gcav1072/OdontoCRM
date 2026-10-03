import { patientAuditPayloadSchema } from '@odontocrm/contracts';
import { EVENT_TOPICS, type DomainEvent } from '@odontocrm/events';

import type { IdentityDb } from '../db/client.js';
import { processedEvents } from '../db/schema.js';
import { writeAuditEvent } from './audit-service.js';

export interface ConsumeSummary {
  /** `true` si el evento produjo un registro de auditoría. */
  processed: boolean;
  reason?: 'duplicado' | 'tipo_no_consumido' | 'carga_invalida';
}

/**
 * Traduce eventos de dominio a la auditoría de identity.
 *
 * Es **idempotente**: el marcador de `processed_events` se escribe después de
 * validar la carga y antes de auditar, así que un reintento de la cola no duplica
 * el registro y un evento con carga inválida no queda marcado como procesado
 * (se reintenta y, si sigue fallando, termina en el registro de errores).
 */
export const handleDomainEvent = async (
  db: IdentityDb,
  event: DomainEvent,
): Promise<ConsumeSummary> => {
  const isPatientCreated = event.eventType === EVENT_TOPICS.patientCreated;
  const isPatientUpdated = event.eventType === EVENT_TOPICS.patientUpdated;

  if (!isPatientCreated && !isPatientUpdated) {
    return { processed: false, reason: 'tipo_no_consumido' };
  }

  const payload = patientAuditPayloadSchema.safeParse(event.payload);
  if (!payload.success) {
    return { processed: false, reason: 'carga_invalida' };
  }

  const marker = await db
    .insert(processedEvents)
    .values({
      eventId: event.eventId,
      eventType: event.eventType,
      producer: event.producer,
    })
    .onConflictDoNothing()
    .returning({ eventId: processedEvents.eventId });

  if (marker.length === 0) return { processed: false, reason: 'duplicado' };

  const data = payload.data;
  const action =
    data.action === 'created'
      ? 'patient_created'
      : data.action === 'status_changed'
        ? 'patient_status_changed'
        : 'patient_updated';

  await writeAuditEvent(db, {
    action,
    entityType: 'patient',
    entityId: data.patientId,
    actorId: data.actorId,
    actorUsername: data.actorUsername,
    before: data.before,
    after: data.after,
    changedFields: data.changedFields,
    reason: data.reason,
    ip: data.ip,
    userAgent: data.userAgent,
    requestId: data.requestId,
  });

  return { processed: true };
};
