import { requireIdentity } from '@odontocrm/kernel';
import type { FastifyRequest } from 'fastify';

/**
 * Quién cambia el odontograma: viaja al **histórico append-only**
 * (`tooth_finding_history`), al outbox y de ahí a la auditoría de identity.
 */
export interface ActorContext {
  actorId: string | null;
  actorUsername: string | null;
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
}

export const actorFrom = (request: FastifyRequest): ActorContext => {
  const identity = requireIdentity(request);
  const userAgent = request.headers['user-agent'];
  return {
    actorId: identity.userId,
    actorUsername: identity.username,
    ip: request.ip ?? null,
    userAgent: typeof userAgent === 'string' ? userAgent : null,
    requestId: request.id,
  };
};

/** Actor de un canal automático (semillas y datos de prueba). */
export const systemActor = (username: string): ActorContext => ({
  actorId: null,
  actorUsername: username,
  ip: null,
  userAgent: null,
  requestId: null,
});
