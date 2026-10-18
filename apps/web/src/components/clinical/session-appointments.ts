import type { AppointmentStatus, AppointmentSummary } from '@odontocrm/contracts';

/**
 * Qué citas pueden **respaldar** la sesión clínica que se va a abrir.
 *
 * El respaldo es lo que permite pasar la cita a «atendida» sin motivo forzado (Fase 7):
 * sin él, el «atendido» exige un motivo que queda en la auditoría. La lista tiene que
 * incluir las citas **pendientes** (programada, notificada, confirmada) además de las
 * que ya están en el circuito del día, porque el odontólogo puede abrir la sesión antes
 * de que la secretaría registre la llegada, y porque el paciente puede venir el día de
 * su cita programada sin que nadie la haya movido todavía.
 *
 * Quedan fuera las cerradas: `atendido` (ya se hizo), `no_asistio`, `cancelada` y
 * `reprogramada` (su cita nueva es otra fila).
 */
export const APPOINTMENT_STATUSES_QUE_RESPALDAN: readonly AppointmentStatus[] = [
  'programada',
  'notificada',
  'confirmada',
  'en_sala_espera',
  'llamado',
  'en_consulta',
];

/** Los estados del día **en curso**, en el orden en que el paciente los atraviesa. */
const ORDEN_EN_FLUJO: readonly AppointmentStatus[] = ['en_consulta', 'llamado', 'en_sala_espera'];

const esDelFlujo = (status: AppointmentStatus): boolean => ORDEN_EN_FLUJO.includes(status);

const rangoEnFlujo = (status: AppointmentStatus): number => {
  const indice = ORDEN_EN_FLUJO.indexOf(status);
  return indice === -1 ? ORDEN_EN_FLUJO.length : indice;
};

/**
 * Las citas que se ofrecen en el desplegable: las que pueden respaldar una sesión y no
 * son de días pasados (una cita de ayer no respalda la sesión de hoy). El orden pone
 * primero lo que está pasando —el paciente en el sillón, luego el que fue llamado y el
 * que espera— y después el resto por fecha y hora.
 */
export const citasQueRespaldan = (
  citas: readonly AppointmentSummary[],
  hoy: string,
): AppointmentSummary[] =>
  citas
    .filter((cita) => cita.date >= hoy && APPOINTMENT_STATUSES_QUE_RESPALDAN.includes(cita.status))
    .sort((izquierda, derecha) => {
      const porFlujo = rangoEnFlujo(izquierda.status) - rangoEnFlujo(derecha.status);
      if (porFlujo !== 0) return porFlujo;
      const porFecha = izquierda.date.localeCompare(derecha.date);
      return porFecha !== 0 ? porFecha : izquierda.startTime.localeCompare(derecha.startTime);
    });

/**
 * La cita que se marca sola al abrir el formulario (el doctor siempre puede cambiarla).
 *
 * Se elige la que está en el circuito del día si la hay; si no, **solo** cuando el
 * paciente tiene una única cita pendiente de hoy (ahí no hay ambigüedad). Con varias
 * candidatas se deja «sin cita» y decide la persona: enlazar la sesión a la cita
 * equivocada prendería el «atendido» de otro día.
 */
export const citaPorDefecto = (
  citas: readonly AppointmentSummary[],
  hoy: string,
): AppointmentSummary | undefined => {
  const candidatas = citasQueRespaldan(citas, hoy);
  const enFlujo = candidatas.find((cita) => esDelFlujo(cita.status));
  if (enFlujo !== undefined) return enFlujo;

  const deHoy = candidatas.filter((cita) => cita.date === hoy);
  return deHoy.length === 1 ? deHoy[0] : undefined;
};
