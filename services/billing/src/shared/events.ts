import type { DomainAuditPayload } from '@odontocrm/contracts';
import { outboxEvents, toOutboxInsert } from '@odontocrm/db';
import { createDomainEvent, type EventTopic } from '@odontocrm/events';

import type { BillingDb } from '../db/client.js';
import type { ActorContext } from './context.js';

export const PRODUCER = 'billing';

type Tx = Pick<BillingDb, 'insert'>;

export interface PublishInput {
  topic: EventTopic;
  /** Identificador del agregado: la factura, el cobro o la tasa. */
  aggregateId: string;
  payload: Record<string, unknown>;
  actor: ActorContext;
}

/**
 * Escribe el evento en el **outbox** dentro de la misma transacción que el cambio de datos: o se
 * guardan los dos, o no se guarda ninguno. El publicador del servicio lo entrega después a la cola
 * compartida, donde identity lo convierte en auditoría.
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
  /** Qué se auditó; por defecto, un documento de cobro (la factura). */
  entityType?: 'invoice' | 'payment' | 'credit_note' | 'exchange_rate' | 'catalog_item';
  changedFields?: string[];
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  reason?: string | null;
  actor: ActorContext;
}

/**
 * Carga de auditoría: identity la registra tal cual (la misma forma que usan la agenda, la clínica y
 * el odontograma). Sin esto, un acto de dinero no dejaría rastro en `/auditoria` (B10).
 */
export const auditPayload = (input: AuditInput): Record<string, unknown> => ({
  entityType: input.entityType ?? 'invoice',
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
