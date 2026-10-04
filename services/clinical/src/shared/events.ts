import type { DomainAuditPayload } from '@odontocrm/contracts';
import { outboxEvents, toOutboxInsert } from '@odontocrm/db';
import { createDomainEvent, type EventTopic } from '@odontocrm/events';

import type { ClinicalDb } from '../db/client.js';
import type { ActorContext } from './context.js';

export const PRODUCER = 'clinical';

type Tx = Pick<ClinicalDb, 'insert'>;

export interface PublishInput {
  topic: EventTopic;
  /** Identificador del agregado (la historia clínica). */
  aggregateId: string;
  payload: Record<string, unknown>;
  actor: ActorContext;
}

/**
 * Escribe el evento en el **outbox** dentro de la misma transacción que el cambio
 * de datos: o se guardan los dos, o no se guarda ninguno. El publicador del
 * servicio lo entrega después a la cola compartida, donde identity lo convierte
 * en auditoría.
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
  /** Tipo de entidad auditada; por defecto, la historia clínica. */
  entityType?: 'medical_record' | 'clinical_session' | 'prescription';
  changedFields?: string[];
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  reason?: string | null;
  actor: ActorContext;
}

/**
 * Carga de auditoría genérica: identity la registra tal cual (la misma forma que
 * usan la agenda y el odontograma). Sin esto, una transición clínica no dejaría
 * rastro en `/auditoria`.
 */
export const auditPayload = (input: AuditInput): Record<string, unknown> => ({
  entityType: input.entityType ?? 'medical_record',
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
