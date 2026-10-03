import {
  allowedTransitions,
  canTransition,
  type AppointmentStatus,
  type Role,
} from '@odontocrm/contracts';
import { ConflictError, requireIdentity } from '@odontocrm/kernel';
import type { FastifyRequest } from 'fastify';

/** Quién hace el cambio: viaja al historial de estados y a la auditoría. */
export interface ActorContext {
  actorId: string | null;
  actorUsername: string | null;
  roles: readonly Role[];
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
    roles: identity.roles,
    ip: request.ip ?? null,
    userAgent: typeof userAgent === 'string' ? userAgent : null,
    requestId: request.id,
  };
};

/** Actor de un canal automático (el bot de Telegram o los datos de prueba). */
export const systemActor = (username: string): ActorContext => ({
  actorId: null,
  actorUsername: username,
  roles: [],
  ip: null,
  userAgent: null,
  requestId: null,
});

/** ¿Alguno de los roles del actor puede hacer esta transición? */
export const actorCanTransition = (
  from: AppointmentStatus,
  to: AppointmentStatus,
  roles: readonly Role[],
): boolean => roles.some((role) => canTransition(from, to, role));

/** Estados a los que el actor puede llevar una cita desde el actual. */
export const actorAllowedStatuses = (
  from: AppointmentStatus,
  roles: readonly Role[],
): AppointmentStatus[] => {
  const destinations = new Set<AppointmentStatus>();
  for (const role of roles) {
    for (const transition of allowedTransitions(from, role)) destinations.add(transition.to);
  }
  return [...destinations];
};

/**
 * Comprueba que el actor pueda llevar la cita de un estado a otro. Es un
 * **conflicto** (409) y no un 403: el problema es el estado actual de la cita, no
 * que falten permisos, y la respuesta dice qué sí se puede hacer desde ahí.
 */
export const assertCanTransition = (
  from: AppointmentStatus,
  to: AppointmentStatus,
  actor: ActorContext,
): void => {
  if (actorCanTransition(from, to, actor.roles)) return;

  const allowed = actorAllowedStatuses(from, actor.roles);
  throw new ConflictError(
    allowed.length === 0
      ? `No puedes cambiar una cita en estado «${from}»`
      : `No puedes pasar de «${from}» a «${to}». Desde aquí puedes: ${allowed.join(', ')}`,
    { extensions: { from, to, allowed } },
  );
};

/**
 * Zona horaria del consultorio. Venezuela es UTC−4 todo el año (sin horario de
 * verano desde 2016), así que la conversión es una constante y no hace falta una
 * biblioteca de zonas horarias.
 */
export const CARACAS_OFFSET = '-04:00';

/** Instante real de una cita a partir de su fecha y su hora locales del consultorio. */
export const toClinicInstant = (date: string, time: string): Date =>
  new Date(`${date}T${time.slice(0, 5)}:00${CARACAS_OFFSET}`);

/** Fecha de hoy en el consultorio, como `AAAA-MM-DD`. */
export const todayInClinic = (now: Date = new Date()): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Caracas',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
