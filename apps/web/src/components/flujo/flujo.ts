import { isTerminalStatus, type AppointmentSummary, type DayView } from '@odontocrm/contracts';

import { appointmentInstant } from '../../lib/scheduling';
import { coincideBusqueda, porHoraDeInicio } from '../secretaria/acciones';

/**
 * Piezas puras de la página unificada `/flujo` (Fase 8): qué cita queda
 * seleccionada y qué se ve en la cola del día.
 *
 * Vive aparte de la página para poder probarla sin navegador: son justo las reglas
 * que deciden qué paciente aparece en el centro de la pantalla al abrir el día.
 */

/* ── Cola del día ─────────────────────────────────────────────────────────── */

/** Citas de la jornada, ordenadas por hora y filtradas por el buscador. */
export const citasDeLaCola = (
  day: DayView | undefined,
  busqueda: string,
): readonly AppointmentSummary[] =>
  [...(day?.appointments ?? [])]
    .sort(porHoraDeInicio)
    .filter((cita) => coincideBusqueda(cita, busqueda));

/** ¿La cita sigue esperando al doctor? (ni cerrada ni cancelada) */
const sigueEnJuego = (cita: AppointmentSummary): boolean => !isTerminalStatus(cita.status);

/**
 * Cita **en curso**: la que el doctor está atendiendo.
 *
 * El orden es el del consultorio: primero la que está en consulta, después la
 * llamada (el paciente ya va de camino), la que está en la sala y, si no hay
 * ninguna, la próxima cita del día que todavía no ha empezado. Es lo que `/flujo`
 * pone en el centro al abrir la pantalla, para no obligar a buscar la cita.
 */
export const citaEnCurso = (
  appointments: readonly AppointmentSummary[],
  now: Date = new Date(),
): AppointmentSummary | null => {
  const vivas = appointments.filter(sigueEnJuego);
  for (const estado of ['en_consulta', 'llamado', 'en_sala_espera'] as const) {
    const encontrada = vivas.find((cita) => cita.status === estado);
    if (encontrada !== undefined) return encontrada;
  }

  const ahora = now.getTime();
  return (
    vivas.find((cita) => {
      const instante = appointmentInstant(cita.date, cita.startTime);
      return instante !== null && instante.getTime() >= ahora;
    }) ?? null
  );
};

/**
 * Cita seleccionada: la que el doctor eligió en la cola, mientras siga en la
 * jornada; si desapareció (la reprogramaron a otro día) o no eligió ninguna, se
 * cae en la cita en curso.
 */
export const resolverSeleccion = (
  appointments: readonly AppointmentSummary[],
  seleccionadaId: string | null,
  now: Date = new Date(),
): AppointmentSummary | null => {
  const elegida = appointments.find((cita) => cita.id === seleccionadaId);
  return elegida ?? citaEnCurso(appointments, now);
};
