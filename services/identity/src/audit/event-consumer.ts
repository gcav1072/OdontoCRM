import { domainAuditPayloadSchema, patientAuditPayloadSchema } from '@odontocrm/contracts';
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
 * Marca el evento como procesado. Devuelve `false` si ya estaba: es lo que hace
 * **idempotente** al consumidor ante un reintento de la cola.
 */
const claim = async (db: IdentityDb, event: DomainEvent): Promise<boolean> => {
  const marker = await db
    .insert(processedEvents)
    .values({ eventId: event.eventId, eventType: event.eventType, producer: event.producer })
    .onConflictDoNothing()
    .returning({ eventId: processedEvents.eventId });

  return marker.length > 0;
};

/**
 * Traduce eventos de dominio a la auditoría de identity.
 *
 * Hay dos formas de carga:
 * 1. **Genérica** (`domainAuditPayloadSchema`): la publican los servicios nuevos
 *    (agenda, y más adelante clínica y odontograma) y ya trae la acción de
 *    auditoría y un resumen legible.
 * 2. **De pacientes**: la forma de la Fase 2, que se mantiene por compatibilidad.
 *
 * En ambos casos el marcador de `processed_events` se escribe **después** de
 * validar la carga: un evento corrupto no queda marcado como procesado (se
 * reintenta y, si sigue fallando, termina en el registro de errores).
 */
export const handleDomainEvent = async (
  db: IdentityDb,
  event: DomainEvent,
): Promise<ConsumeSummary> => {
  const generic = domainAuditPayloadSchema.safeParse(event.payload);
  if (generic.success) {
    if (!(await claim(db, event))) return { processed: false, reason: 'duplicado' };

    const data = generic.data;
    await writeAuditEvent(db, {
      action: data.action,
      entityType: data.entityType,
      entityId: data.entityId,
      summary: data.summary,
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
  }

  const isPatientCreated = event.eventType === EVENT_TOPICS.patientCreated;
  const isPatientUpdated = event.eventType === EVENT_TOPICS.patientUpdated;
  const isPatientDeleted = event.eventType === EVENT_TOPICS.patientDeleted;

  if (!isPatientCreated && !isPatientUpdated && !isPatientDeleted) {
    return { processed: false, reason: 'tipo_no_consumido' };
  }

  const payload = patientAuditPayloadSchema.safeParse(event.payload);
  if (!payload.success) {
    return { processed: false, reason: 'carga_invalida' };
  }
  if (!(await claim(db, event))) return { processed: false, reason: 'duplicado' };

  const data = payload.data;
  const action =
    data.action === 'created'
      ? 'patient_created'
      : data.action === 'status_changed'
        ? 'patient_status_changed'
        : data.action === 'deleted'
          ? 'patient_deleted'
          : 'patient_updated';

  await writeAuditEvent(db, {
    action,
    entityType: 'patient',
    entityId: data.patientId,
    summary: `Paciente ${data.fullName} (${data.document}): ${
      data.action === 'created'
        ? 'alta'
        : data.action === 'deleted'
          ? 'eliminado del registro'
          : data.action === 'status_changed'
            ? 'cambio de estado'
            : `cambio en ${data.changedFields.join(', ')}`
    }`,
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
