import {
  expandTemplateSlots,
  minutesBetween,
  rangesOverlap,
  type SlotTemplate,
  type TimeRange,
} from '@odontocrm/contracts';

/**
 * Piezas puras del configurador de horario (`ScheduleConfigDialog`): turnos de un
 * día, validación y conversión de la hora a 12 h.
 *
 * Viven fuera del componente para poder probarlas sin navegador y para que el
 * diálogo solo se ocupe de la pintura y del envío.
 */

/** Un turno de atención, en 24 h como lo guarda el contrato. */
export interface ShiftDraft {
  startTime: string;
  endTime: string;
}

/**
 * Horario de fábrica: dos turnos de 8:00 a 12:00 y de 2:00 a 5:00 p. m. con franjas
 * de 30 minutos. Es el que siembra la migración para lunes a viernes; aquí se ofrece
 * como atajo para un día que se quedó sin turnos.
 */
export const DEFAULT_SHIFTS: readonly ShiftDraft[] = [
  { startTime: '08:00', endTime: '12:00' },
  { startTime: '14:00', endTime: '17:00' },
];

/** Días en el orden en que se leen en la clínica (lunes primero). */
export const WEEKDAY_ORDER: readonly number[] = [1, 2, 3, 4, 5, 6, 0];

/** Turnos **activos** de un día en la plantilla común, ordenados por hora. */
export const shiftsForDay = (templates: readonly SlotTemplate[], weekday: number): ShiftDraft[] =>
  templates
    .filter(
      (template) => template.weekday === weekday && template.chairId === null && template.isActive,
    )
    .map((template) => ({ startTime: template.startTime, endTime: template.endTime }))
    .sort((left, right) => left.startTime.localeCompare(right.startTime));

/** Copia editable de los turnos de fábrica. */
export const factoryShifts = (): ShiftDraft[] => DEFAULT_SHIFTS.map((shift) => ({ ...shift }));

export type ShiftIssue =
  | { kind: 'vacio'; index: number }
  | { kind: 'invertido'; index: number }
  | { kind: 'corta'; index: number; minutos: number }
  | { kind: 'solape'; index: number };

/**
 * Problemas de una lista de turnos. `vacio` no es un error: significa «este turno se
 * queda sin horas» y el diálogo lo trata como aviso (un día sin turnos está cerrado).
 */
export const validateShifts = (
  shifts: readonly ShiftDraft[],
  slotMinutes: number,
): ShiftIssue[] => {
  const issues: ShiftIssue[] = [];
  shifts.forEach((shift, index) => {
    if (shift.startTime === '' || shift.endTime === '') {
      issues.push({ kind: 'vacio', index });
      return;
    }
    const minutos = minutesBetween(shift.startTime, shift.endTime);
    if (minutos <= 0) {
      issues.push({ kind: 'invertido', index });
      return;
    }
    if (minutos < slotMinutes) {
      issues.push({ kind: 'corta', index, minutos });
    }
    if (
      shifts.some(
        (other, otherIndex) =>
          otherIndex !== index &&
          other.startTime !== '' &&
          other.endTime !== '' &&
          rangesOverlap(shift, other),
      )
    ) {
      issues.push({ kind: 'solape', index });
    }
  });
  return issues;
};

/** Franjas que producen los turnos con esa duración (sin pausas). */
export const slotsOfShifts = (shifts: readonly ShiftDraft[], slotMinutes: number): TimeRange[] =>
  shifts
    .filter((shift) => minutesBetween(shift.startTime, shift.endTime) >= slotMinutes)
    .flatMap((shift) =>
      expandTemplateSlots({
        startTime: shift.startTime,
        endTime: shift.endTime,
        slotMinutes,
        breaks: [],
      }),
    )
    .sort((left, right) => left.startTime.localeCompare(right.startTime));

/** Total de franjas del día, que es su cupo. */
export const countSlots = (shifts: readonly ShiftDraft[], slotMinutes: number): number =>
  slotsOfShifts(shifts, slotMinutes).length;

/* ── Hora en 12 h ─────────────────────────────────────────────────────────── */

export type Meridiem = 'am' | 'pm';

export interface Time12 {
  /** 1–12, como se lee en el reloj. */
  hour: number;
  minute: number;
  meridiem: Meridiem;
}

/** `HH:MM` (24 h) → las tres piezas que edita el selector de 12 h. */
export const toTime12 = (time: string): Time12 => {
  const [hours = 0, minute = 0] = time.split(':').map(Number);
  return {
    hour: hours % 12 === 0 ? 12 : hours % 12,
    minute,
    meridiem: hours < 12 ? 'am' : 'pm',
  };
};

/** Las tres piezas → `HH:MM` (24 h). 12 a. m. es medianoche y 12 p. m. es mediodía. */
export const fromTime12 = (value: Time12): string => {
  const base = value.hour % 12;
  const hours = value.meridiem === 'pm' ? base + 12 : base;
  return `${String(hours).padStart(2, '0')}:${String(value.minute).padStart(2, '0')}`;
};

/** Minutos del selector: cada 5, más el minuto actual si no cae en la rejilla. */
export const minuteOptions = (minute: number): number[] => {
  const base = Array.from({ length: 12 }, (_, index) => index * 5);
  return base.includes(minute) ? base : [...base, minute].sort((left, right) => left - right);
};

/** ¿Los dos conjuntos de turnos dicen lo mismo? (para detectar cambios sin guardar). */
export const sameShifts = (left: readonly ShiftDraft[], right: readonly ShiftDraft[]): boolean =>
  left.length === right.length &&
  left.every(
    (shift, index) =>
      shift.startTime === right[index]?.startTime && shift.endTime === right[index]?.endTime,
  );
