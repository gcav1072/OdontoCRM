import { domainAuditPayloadSchema } from '@odontocrm/contracts';
import { outboxEvents, toOutboxInsert } from '@odontocrm/db';
import { EVENT_TOPICS, createDomainEvent } from '@odontocrm/events';
import { stableUuid } from '@odontocrm/kernel';

import type { NotificationsDb } from '../../db/client.js';
import type { WhatsAppSessionAudit } from './sesion.js';

/**
 * Publica en el outbox la auditoría de la sesión de WhatsApp (ADR 0073).
 * Identity la consume igual que el resto y la deja en `audit_events`.
 *
 * `domainAuditPayloadSchema.entityId` exige UUID y la sesión se identifica por
 * un texto (`principal`), así que se deriva con `stableUuid`, que es la regla
 * del proyecto para agregados sin id propio.
 */
const TOPIC_POR_ACCION = [
  { accion: 'whatsapp_session_paired' as const, topic: EVENT_TOPICS.whatsappSessionPaired },
  {
    accion: 'whatsapp_session_logged_out' as const,
    topic: EVENT_TOPICS.whatsappSessionLoggedOut,
  },
  { accion: 'whatsapp_session_lost' as const, topic: EVENT_TOPICS.whatsappSessionLost },
];

export const createWhatsAppAuditPublisher = (
  db: NotificationsDb,
  sessionId: string,
): ((evento: WhatsAppSessionAudit) => Promise<void>) => {
  const entityId = stableUuid(`whatsapp-session:${sessionId}`);
  return async (evento) => {
    const topic = TOPIC_POR_ACCION.find((item) => item.accion === evento.accion)?.topic;
    if (topic === undefined) return;

    const payload = domainAuditPayloadSchema.parse({
      entityType: 'whatsapp_session',
      entityId,
      action: evento.accion,
      summary: evento.detalle,
      changedFields: [],
      before: null,
      after: { estado: evento.accion.replace('whatsapp_session_', '') },
      reason: null,
      actorId: evento.actorId ?? null,
      actorUsername: evento.actorUsername ?? null,
      ip: null,
      userAgent: null,
      requestId: null,
    });

    await db.insert(outboxEvents).values(
      toOutboxInsert(
        createDomainEvent({
          topic,
          aggregateId: entityId,
          producer: 'notifications',
          payload,
        }),
      ),
    );
  };
};
