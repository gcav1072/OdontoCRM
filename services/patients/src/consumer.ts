import { EVENT_TOPICS, type DomainEvent } from '@odontocrm/events';

import type { PatientsDb } from './db/client.js';
import { promotePatientWithAppointment } from './patients/patient-service.js';

/**
 * Proyección de eventos de agenda en la ficha del paciente.
 *
 * Existe por un caso real: el paciente creado por el bot (o en el mostrador) nace
 * en `en_espera_cita`, y al asignársele la cita el estado se quedaba así para
 * siempre —la agenda no puede escribir en la base de pacientes y nadie escuchaba
 * el evento—, de modo que en `/pacientes` seguía apareciendo «En espera de cita»
 * con la cita ya programada y el `.ics` enviado.
 *
 * Solo se atiende lo que cambia el estado del paciente: tener cita programada (o
 * reprogramada) lo saca de la espera. Los estados `activo` e `inactivo` no se
 * tocan nunca: una baja decidida a mano no se revierte por un evento.
 */
const TEMAS_QUE_PROMUEVEN: readonly string[] = [
  EVENT_TOPICS.appointmentScheduled,
  EVENT_TOPICS.appointmentRescheduled,
];

export interface PatientProjectionResult {
  estado: 'aplicado' | 'sin_cambios' | 'ignorado';
  patientId: string | null;
}

/**
 * El paciente del evento. La convención de la agenda es que el bloque
 * `notification` lleve los datos del paciente (es lo que usan las pantallas y el
 * servicio de notificaciones); `appointment` solo describe la cita. Se acepta
 * también ahí por si algún tema lo trae, pero lo normal es leerlo del aviso.
 */
const pacienteDelEvento = (event: DomainEvent): string | null => {
  const bloques = [event.payload['notification'], event.payload['appointment']];
  for (const bloque of bloques) {
    if (typeof bloque !== 'object' || bloque === null) continue;
    const patientId = (bloque as { patientId?: unknown }).patientId;
    if (typeof patientId === 'string' && patientId !== '') return patientId;
  }
  return null;
};

export const handleDomainEvents = async (
  services: { db: PatientsDb },
  events: readonly DomainEvent[],
): Promise<PatientProjectionResult[]> => {
  const resultados: PatientProjectionResult[] = [];

  for (const event of events) {
    if (!TEMAS_QUE_PROMUEVEN.includes(event.eventType)) {
      resultados.push({ estado: 'ignorado', patientId: null });
      continue;
    }

    const patientId = pacienteDelEvento(event);
    if (patientId === null) {
      resultados.push({ estado: 'ignorado', patientId: null });
      continue;
    }

    const aplicado = await promotePatientWithAppointment(
      services.db,
      patientId,
      'se le asignó una cita',
    );
    resultados.push({ estado: aplicado ? 'aplicado' : 'sin_cambios', patientId });
  }

  return resultados;
};
