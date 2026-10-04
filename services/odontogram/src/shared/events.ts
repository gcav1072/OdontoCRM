import type { DomainAuditPayload } from '@odontocrm/contracts';
import { outboxEvents, toOutboxInsert } from '@odontocrm/db';
import { createDomainEvent, type EventTopic } from '@odontocrm/events';

import type { OdontogramDb } from '../db/client.js';
import type { ActorContext } from './context.js';

export const PRODUCER = 'odontogram';

type Tx = Pick<OdontogramDb, 'insert'>;

export interface PublishInput {
  topic: EventTopic;
  /**
   * Identificador del agregado: **el odontograma** (no la pieza ni el hallazgo),
   * porque `createDomainEvent` exige un UUID y la pieza es un número FDI.
   */
  aggregateId: string;
  payload: Record<string, unknown>;
  actor: ActorContext;
}

/**
 * Escribe el evento en el **outbox** dentro de la misma transacción que el cambio
 * de datos: o se guardan los dos, o no se guarda ninguno. El publicador del
 * servicio lo entrega después a la cola compartida, donde identity lo convierte
 * en auditoría (y la Fase 9, en su read model de reportes).
 */
export const publish = async (tx: Tx, input: PublishInput): Promise<unknown> =>
  tx.insert(outboxEvents).values(
    toOutboxInsert(
      createDomainEvent({
        topic: input.topic,
        aggregateId: input.aggregateId,
        producer: PRODUCER,
        actorId: input.actor.actorId,
        correlationId: input.actor.requestId,
        payload: input.payload,
      }),
    ),
  );

export interface AuditInput {
  entityId: string;
  action: DomainAuditPayload['action'];
  summary: string;
  changedFields?: string[];
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  reason?: string | null;
  actor: ActorContext;
}

/**
 * Carga de auditoría genérica (`entityType: 'odontogram'`): identity la registra
 * tal cual, así que cada cambio del odontograma deja rastro en `/auditoria` con
 * su actor y su antes/después.
 */
export const auditPayload = (input: AuditInput): Record<string, unknown> => ({
  entityType: 'odontogram',
  entityId: input.entityId,
  action: input.action,
  summary: input.summary,
  changedFields: input.changedFields ?? [],
  before: input.before ?? null,
  after: input.after ?? null,
  reason: input.reason ?? null,
  actorId: input.actor.actorId,
  actorUsername: input.actor.actorUsername,
  ip: input.actor.ip,
  userAgent: input.actor.userAgent,
  requestId: input.actor.requestId,
});
