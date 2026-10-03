import {
  addMinutes,
  formatTime12h,
  rangesOverlap,
  weekdayName,
  weekdayOf,
  type DaySlot,
  type DayView,
} from '@odontocrm/contracts';
import { asc, eq } from 'drizzle-orm';

import type { SchedulingConfig } from '../config.js';
import type { SchedulingDb } from '../db/client.js';
import { appointmentRequests, type AppointmentRow } from '../db/schema.js';
import { OCCUPYING_STATUSES, toHm, toRequestSummary } from '../mappers.js';
import {
  activeTemplatesFor,
  capacityFor,
  slotsForDate,
  toDayCapacity,
} from './capacity-service.js';
import {
  appointmentsOn,
  countByStatus,
  listDayAppointments,
} from '../appointments/appointment-service.js';

/**
 * Vista completa de la jornada de un día: cupo (con su procedencia), rejilla de
 * franjas (incluidas las pausas, marcadas como «fuera de jornada»), citas del día,
 * cola de solicitudes en espera y contadores por estado.
 *
 * Las citas con **hora manual** que no coinciden con ninguna franja se añaden como
 * huecos propios: la jornada nunca oculta una cita.
 */
export const getDayView = async (
  db: SchedulingDb,
  date: string,
  config: SchedulingConfig,
): Promise<DayView> => {
  const [capacityInfo, rows, summaries, counts, waitingRows, templates] = await Promise.all([
    capacityFor(db, date, config),
    appointmentsOn(db, date),
    listDayAppointments(db, date),
    countByStatus(db, date),
    db
      .select()
      .from(appointmentRequests)
      .where(eq(appointmentRequests.status, 'en_espera_cita'))
      .orderBy(asc(appointmentRequests.ticketNumber)),
    activeTemplatesFor(db, weekdayOf(date)),
  ]);

  const summaryById = new Map(summaries.map((summary) => [summary.id, summary]));
  const occupying: AppointmentRow[] = rows.filter((row) =>
    (OCCUPYING_STATUSES as readonly string[]).includes(row.status),
  );

  const ranges = await slotsForDate(db, date);
  const slots: DaySlot[] = ranges.map((range) => {
    const appointment =
      occupying.find((row) =>
        rangesOverlap(
          { startTime: toHm(row.startTime), endTime: toHm(row.endTime) },
          { startTime: range.startTime, endTime: range.endTime },
        ),
      ) ?? null;

    return {
      startTime: range.startTime,
      endTime: range.endTime,
      kind: 'franja',
      state: appointment === null ? 'libre' : 'ocupada',
      appointment: appointment === null ? null : (summaryById.get(appointment.id) ?? null),
    };
  });

  // Las pausas (el almuerzo) se muestran como fuera de jornada, no como huecos libres.
  for (const template of templates) {
    for (const pause of template.breaks) {
      slots.push({
        startTime: toHm(pause.startTime),
        endTime: toHm(pause.endTime),
        kind: 'franja',
        state: 'fuera_de_jornada',
        appointment: null,
      });
    }
  }

  const slotStarts = new Set(ranges.map((range) => range.startTime));
  for (const appointment of occupying) {
    const startTime = toHm(appointment.startTime);
    if (slotStarts.has(startTime)) continue;
    // Cita con hora manual (o fuera de la plantilla): se muestra igual.
    slots.push({
      startTime,
      endTime: toHm(appointment.endTime),
      kind: 'manual',
      state: 'ocupada',
      appointment: summaryById.get(appointment.id) ?? null,
    });
  }

  slots.sort((left, right) => left.startTime.localeCompare(right.startTime));

  const weekday = weekdayOf(date);
  const now = new Date();

  return {
    date,
    weekday,
    weekdayName: weekdayName(weekday),
    isWorkingDay: templates.length > 0,
    capacity: toDayCapacity(capacityInfo),
    slots,
    appointments: summaries,
    waiting: waitingRows.map((row) => toRequestSummary(row, { now })),
    counts: {
      programadas: counts['programada'] ?? 0,
      notificadas: counts['notificada'] ?? 0,
      enSala:
        (counts['en_sala_espera'] ?? 0) + (counts['llamado'] ?? 0) + (counts['en_consulta'] ?? 0),
      atendidas: counts['atendido'] ?? 0,
      noAsistio: counts['no_asistio'] ?? 0,
      canceladas: (counts['cancelada'] ?? 0) + (counts['reprogramada'] ?? 0),
    },
  };
};

/** Reexporta utilidades de hora que la interfaz usa para pintar la jornada. */
export { addMinutes, formatTime12h };
