import { isTerminalStatus, type AppointmentSummary, type DayView } from '@odontocrm/contracts';

import { t, type TranslationKey } from '../../lib/i18n';
import { appointmentInstant } from '../../lib/scheduling';
import { coincideBusqueda, porHoraDeInicio } from '../secretaria/acciones';

/**
 * Piezas puras de la página unificada `/flujo` (Fase 8): qué cita queda
 * seleccionada, qué se ve en la cola del día y qué hace cada atajo de teclado.
 *
 * Vive aparte de la página —y sin tocar el DOM salvo por el parámetro opcional de
 * `hayDialogoAbierto`— para poder probarla sin navegador: son justo las reglas que
 * deciden qué paciente aparece en el centro de la pantalla y qué acción se dispara
 * al pulsar una tecla de función.
 */

/* ── Cola del día ─────────────────────────────────────────────────────────── */

/** Citas de la jornada, ordenadas por hora (la jornada completa). */
export const citasDelDia = (day: DayView | undefined): readonly AppointmentSummary[] =>
  [...(day?.appointments ?? [])].sort(porHoraDeInicio);

/** Lo que muestra la lista: la jornada filtrada por el buscador. */
export const citasDeLaCola = (
  day: DayView | undefined,
  busqueda: string,
): readonly AppointmentSummary[] =>
  citasDelDia(day).filter((cita) => coincideBusqueda(cita, busqueda));

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

/* ── Atajos de teclado ────────────────────────────────────────────────────── */

/**
 * Acciones que tienen atajo. `F8` cierra la **sesión clínica** de la visita (no la
 * sesión del sistema: cerrar el día del paciente es lo que se hace con el paciente
 * delante, y el cierre de sesión de usuario vive en el panel inferior).
 */
export type AccionFlujo = 'buscar' | 'llamar' | 'cerrar-sesion';

export interface AtajoFlujo {
  accion: AccionFlujo;
  /** Código de la tecla tal como lo entrega el navegador (`event.key`). */
  tecla: string;
  labelKey: TranslationKey;
  helpKey: TranslationKey;
}

export const ATAJOS_FLUJO: readonly AtajoFlujo[] = [
  {
    accion: 'buscar',
    tecla: 'F2',
    labelKey: 'flujo.atajo.buscar',
    helpKey: 'flujo.atajo.buscarAyuda',
  },
  {
    accion: 'llamar',
    tecla: 'F4',
    labelKey: 'flujo.atajo.llamar',
    helpKey: 'flujo.atajo.llamarAyuda',
  },
  {
    accion: 'cerrar-sesion',
    tecla: 'F8',
    labelKey: 'flujo.atajo.cerrar',
    helpKey: 'flujo.atajo.cerrarAyuda',
  },
] as const;

export const atajoDeAccion = (accion: AccionFlujo): AtajoFlujo =>
  ATAJOS_FLUJO.find((atajo) => atajo.accion === accion) ?? ATAJOS_FLUJO[0]!;

/**
 * Tecla pulsada → acción del flujo. Devuelve `null` si no es un atajo **o** si
 * viene con modificadores: `Ctrl+F4` o `Alt+F4` son del sistema y del navegador,
 * no de la pantalla.
 */
export const accionDeTecla = (event: {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}): AccionFlujo | null => {
  if (event.ctrlKey === true || event.metaKey === true || event.altKey === true) return null;
  return ATAJOS_FLUJO.find((atajo) => atajo.tecla === event.key)?.accion ?? null;
};

/**
 * ¿Hay un diálogo modal abierto? Los atajos no deben dispararse a través de él: con
 * el diálogo de cierre delante, `F4` no puede llamar al paciente de atrás. Se
 * consulta el `<dialog open>` nativo, que es como se montan los diálogos del
 * sistema de diseño; el documento se recibe por parámetro para poder probarlo.
 */
export const hayDialogoAbierto = (
  doc: { querySelector: (selector: string) => unknown } | undefined = typeof document ===
  'undefined'
    ? undefined
    : document,
): boolean => doc !== undefined && doc.querySelector('dialog[open]') !== null;

/** Etiqueta corta del atajo para la ayuda en pantalla: «F4 · Llamar». */
export const ayudaDeAtajo = (accion: AccionFlujo): string => {
  const atajo = atajoDeAccion(accion);
  return `${atajo.tecla} · ${t(atajo.labelKey)}`;
};
