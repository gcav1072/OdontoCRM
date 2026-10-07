import type { StaffSignal } from '@odontocrm/contracts';
import { EVENT_TOPICS, type DomainEvent, type EventTopic } from '@odontocrm/events';

import { ordenarLote } from '../consumer.js';

/**
 * Qué eventos se avisan al **personal** por el canal en vivo.
 *
 * La lista es lo único que decide si el canal sirve para algo, así que conviene tenerla
 * a la vista y explicada:
 *
 *  - **agenda**: la recepción (`/flujo`) y el consultorio se miran entre sí; cada paso de
 *    la cita —programada, llamada, en consulta, atendida, inasistencia, cancelada,
 *    reprogramada— deja una fila desactualizada en la pantalla del otro.
 *  - **clínica**: cerrar una sesión es el momento en que la fila pasa a «pendiente por
 *    cobro»; sin este aviso, la caja no se entera hasta que alguien recarga.
 *  - **facturación y cobros**: la caja y los libros cambian cuando nace una factura, se
 *    cobra, se anula o se emite una nota de crédito.
 *
 * Los eventos que **no** están aquí no se descartan: siguen alimentando la proyección de
 * la sala y la auditoría. Lo que no hacen es despertar a la interfaz, y eso es
 * deliberado: cada aviso cuesta una invalidación de caché en cada pantalla abierta.
 */
export const STAFF_TOPICS: readonly EventTopic[] = [
  EVENT_TOPICS.appointmentScheduled,
  EVENT_TOPICS.appointmentRescheduled,
  EVENT_TOPICS.appointmentCancelled,
  EVENT_TOPICS.appointmentCheckedIn,
  EVENT_TOPICS.appointmentCalled,
  EVENT_TOPICS.appointmentInConsultation,
  EVENT_TOPICS.appointmentAttended,
  EVENT_TOPICS.appointmentNoShow,

  EVENT_TOPICS.sessionCreated,
  EVENT_TOPICS.sessionClosed,
  EVENT_TOPICS.sessionAmended,
  EVENT_TOPICS.prescriptionIssued,

  EVENT_TOPICS.invoiceIssued,
  EVENT_TOPICS.invoiceVoided,
  EVENT_TOPICS.invoicePaid,
  EVENT_TOPICS.paymentReceived,
  EVENT_TOPICS.paymentVoided,
  EVENT_TOPICS.creditNoteIssued,
];

/**
 * Traduce un lote de eventos en avisos para el canal del personal.
 *
 * **Un aviso por tema, no por evento.** Un solo acto puede producir varios eventos del
 * mismo tema (tres facturas emitidas en la misma emisión) y la interfaz va a invalidar la
 * misma caché las tres veces: repetir el aviso solo gasta ancho de banda y provoca
 * recargas de más. Se conserva el **primero** de cada tema —por eso el lote se ordena por
 * hora—, así que si tres facturas se emitieron a la vez, la caché se invalida una vez,
 * después de la primera: la última ya vendrá con la siguiente consulta.
 *
 * Es pura a propósito: se prueba sin base de datos ni cola (`staff-signal.test.ts`).
 */
export const staffSignals = (events: readonly DomainEvent[]): StaffSignal[] => {
  const vistos = new Set<string>();
  const avisos: StaffSignal[] = [];

  for (const evento of ordenarLote(events)) {
    if (!STAFF_TOPICS.includes(evento.eventType as EventTopic)) continue;
    if (vistos.has(evento.eventType)) continue;
    vistos.add(evento.eventType);
    avisos.push({
      topic: evento.eventType,
      at: evento.occurredAt,
      aggregateId: evento.aggregateId,
    });
  }

  return avisos;
};
