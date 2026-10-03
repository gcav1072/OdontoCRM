import { EVENT_TOPICS, type DomainEvent } from '@odontocrm/events';

import type { EstadoDeps } from './sala/estado-service.js';
import { applyEvent } from './sala/estado-service.js';

/** Eventos de agenda que mueven la sala (los demás se ignoran sin ruido). */
export const SCREEN_TOPICS: readonly string[] = [
  EVENT_TOPICS.appointmentCheckedIn,
  EVENT_TOPICS.appointmentCalled,
  EVENT_TOPICS.appointmentInConsultation,
  EVENT_TOPICS.appointmentAttended,
  EVENT_TOPICS.appointmentNoShow,
  EVENT_TOPICS.appointmentCancelled,
  EVENT_TOPICS.appointmentRescheduled,
];

export interface ConsumeResult {
  estado: 'aplicado' | 'duplicado' | 'ignorado';
}

/**
 * Traduce los eventos de agenda en estado de la sala.
 *
 * La proyección es la única fuente de lo que pintan las pantallas, y por eso no
 * consulta la base de la agenda: los eventos traen la cita y el nombre del
 * paciente.
 */
export const handleDomainEvent = async (
  deps: EstadoDeps,
  event: DomainEvent,
): Promise<ConsumeResult> => ({ estado: (await applyEvent(deps, event)).estado });

/**
 * Aplica el lote **ordenado por hora** y avisa una sola vez a las pantallas.
 *
 * `pg-boss` entrega los trabajos de un lote sin garantizar el orden: aplicar
 * `called` antes que `checked_in` (o `attended` antes que `in_consultation`)
 * dejaba la sala al revés. La proyección, además, no retrocede ni resucita a
 * quien ya salió, así que un evento tardío tampoco la estropea.
 */
export const handleDomainEvents = async (
  deps: EstadoDeps & { onCambio?: () => Promise<void> },
  events: readonly DomainEvent[],
): Promise<ConsumeResult[]> => {
  const resultados: ConsumeResult[] = [];
  for (const event of ordenarLote(events)) {
    resultados.push({ estado: (await applyEvent(deps, event)).estado });
  }

  if (resultados.some((resultado) => resultado.estado === 'aplicado')) {
    await deps.onCambio?.();
  }
  return resultados;
};

/** Ordena un lote de eventos por su hora (y por id, para que sea estable). */
export const ordenarLote = (events: readonly DomainEvent[]): DomainEvent[] =>
  [...events].sort((izquierda, derecha) => {
    const porHora = izquierda.occurredAt.localeCompare(derecha.occurredAt);
    return porHora !== 0 ? porHora : izquierda.eventId.localeCompare(derecha.eventId);
  });
