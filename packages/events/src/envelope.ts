import { z } from 'zod';

import { EVENT_TOPIC_VALUES, type EventTopic, type ServiceName } from './topics.js';

/**
 * Sobre común de todos los eventos de dominio. Es el contrato que se guarda en
 * `outbox_events`, se envía por `pg-boss` y consumen los demás servicios.
 */
export const domainEventSchema = z.object({
  eventId: z.uuid(),
  eventType: z.enum(EVENT_TOPIC_VALUES as unknown as [EventTopic, ...EventTopic[]]),
  version: z.number().int().min(1).default(1),
  occurredAt: z.iso.datetime({ offset: true }),
  aggregateId: z.uuid(),
  producer: z.string().min(1),
  actorId: z.uuid().nullable().default(null),
  correlationId: z.string().min(1).nullable().default(null),
  payload: z.record(z.string(), z.unknown()),
});

export type DomainEvent = z.infer<typeof domainEventSchema>;

export interface CreateDomainEventInput {
  topic: EventTopic;
  aggregateId: string;
  producer: ServiceName | string;
  payload?: Record<string, unknown>;
  actorId?: string | null;
  correlationId?: string | null;
  occurredAt?: Date;
}

/** Construye un evento listo para guardar en el outbox. */
export const createDomainEvent = (input: CreateDomainEventInput): DomainEvent => ({
  eventId: globalThis.crypto.randomUUID(),
  eventType: input.topic,
  version: 1,
  occurredAt: (input.occurredAt ?? new Date()).toISOString(),
  aggregateId: input.aggregateId,
  producer: input.producer,
  actorId: input.actorId ?? null,
  correlationId: input.correlationId ?? null,
  payload: input.payload ?? {},
});

/** Valida un evento que llega de la cola; lanza si el sobre está malformado. */
export const parseDomainEvent = (value: unknown): DomainEvent => domainEventSchema.parse(value);
