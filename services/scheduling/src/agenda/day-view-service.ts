import {
  addMinutes,
  expandTemplateSlots,
  formatTime12h,
  rangesOverlap,
  weekdayName,
  weekdayOf,
  type Chair,
  type ChairDayView,
  type DayCapacity,
  type DayCounts,
  type DaySlot,
  type DayView,
} from '@odontocrm/contracts';
import { asc, eq } from 'drizzle-orm';

import type { SchedulingConfig } from '../config.js';
import type { SchedulingDb } from '../db/client.js';
import { appointmentRequests, type AppointmentRow, type SlotTemplateRow } from '../db/schema.js';
import { OCCUPYING_STATUSES, toHm, toRequestSummary } from '../mappers.js';
import {
  appointmentsOn,
  countByStatus,
  toSummaries,
  type SummaryLabels,
} from '../appointments/appointment-service.js';
import {
  activeTemplatesFor,
  capacityFor,
  hasOwnSchedule,
  toDayCapacity,
} from './capacity-service.js';
import { chairLabels, listChairs } from './chair-service.js';
import type { DentistCatalog } from '../shared/identity-client.js';

/** Dependencias opcionales de la jornada (el catálogo de odontólogos para rotular). */
export interface DayViewDeps {
  dentistCatalog?: DentistCatalog;
}

const countsOf = (counts: Record<string, number>): DayCounts => ({
  programadas: counts['programada'] ?? 0,
  notificadas: counts['notificada'] ?? 0,
  confirmadas: counts['confirmada'] ?? 0,
  enSala: (counts['en_sala_espera'] ?? 0) + (counts['llamado'] ?? 0) + (counts['en_consulta'] ?? 0),
  atendidas: counts['atendido'] ?? 0,
  noAsistio: counts['no_asistio'] ?? 0,
  canceladas: (counts['cancelada'] ?? 0) + (counts['reprogramada'] ?? 0),
});

const occupyingOf = (rows: readonly AppointmentRow[]): AppointmentRow[] =>
  rows.filter((row) => (OCCUPYING_STATUSES as readonly string[]).includes(row.status));

const buildLabels = async (db: SchedulingDb, deps: DayViewDeps): Promise<SummaryLabels> => {
  const [chairMap, dentistNames] = await Promise.all([
    chairLabels(db),
    deps.dentistCatalog === undefined ? Promise.resolve(new Map()) : deps.dentistCatalog(),
  ]);
  return { chairLabels: chairMap, dentistNames };
};

/**
 * Rejilla de franjas de **un consultorio**: sus huecos de plantilla, sus pausas (el
 * almuerzo, marcado como fuera de jornada) y las citas con **hora manual** que no
 * caen en ninguna franja. La jornada nunca oculta una cita.
 */
const buildSlots = (
  chair: Chair,
  templates: readonly SlotTemplateRow[],
  occupying: readonly AppointmentRow[],
  summaryById: ReadonlyMap<string, DaySlot['appointment']>,
): DaySlot[] => {
  const ranges = templates.flatMap((template) =>
    expandTemplateSlots({
      startTime: toHm(template.startTime),
      endTime: toHm(template.endTime),
      slotMinutes: template.slotMinutes,
      breaks: template.breaks.map((pause) => ({
        startTime: toHm(pause.startTime),
        endTime: toHm(pause.endTime),
      })),
    }),
  );

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
      chairId: chair.id,
      chairLabel: chair.label,
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
        chairId: chair.id,
        chairLabel: chair.label,
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
      chairId: chair.id,
      chairLabel: chair.label,
      appointment: summaryById.get(appointment.id) ?? null,
    });
  }

  slots.sort((left, right) => left.startTime.localeCompare(right.startTime));
  return slots;
};

/** Cupo **agregado** del día: suma de la capacidad y de lo asignado en cada consultorio. */
const aggregateCapacity = (date: string, views: readonly ChairDayView[]): DayCapacity => {
  const capacity = views.reduce((total, view) => total + view.capacity.capacity, 0);
  const assigned = views.reduce((total, view) => total + view.capacity.assigned, 0);
  const conFranjas = views.some(
    (view) => view.capacity.source === 'plantilla' || view.capacity.source === 'explicito',
  );

  return {
    date,
    chairId: null,
    chairLabel: null,
    capacity,
    source: conFranjas ? 'plantilla' : 'defecto',
    explicitCapacity: null,
    notes: null,
    assigned,
    available: Math.max(0, capacity - assigned),
    isFull: assigned >= capacity,
    warning:
      assigned > capacity
        ? `El cupo del día (${String(capacity)}) queda por debajo de las ${String(assigned)} citas asignadas: no se ha borrado ninguna.`
        : null,
    updatedBy: null,
    updatedAt: null,
  };
};

/**
 * Vista completa de la jornada de un día, **por consultorio**: cada uno con su cupo,
 * su rejilla de franjas y sus contadores. Incluye, además, el cupo y los contadores
 * **agregados** del día y todas sus citas, que es lo que pinta la jornada cuando no se
 * filtra por un consultorio.
 */
export const getDayView = async (
  db: SchedulingDb,
  date: string,
  config: SchedulingConfig,
  deps: DayViewDeps = {},
): Promise<DayView> => {
  const weekday = weekdayOf(date);
  const now = new Date();

  const [activeChairs, labels, waitingRows] = await Promise.all([
    listChairs(db),
    buildLabels(db, deps),
    db
      .select()
      .from(appointmentRequests)
      .where(eq(appointmentRequests.status, 'en_espera_cita'))
      .orderBy(asc(appointmentRequests.ticketNumber)),
  ]);

  const chairs: ChairDayView[] = [];
  for (const chair of activeChairs) {
    chairs.push(await chairDayView(db, date, weekday, config, chair, labels));
  }

  const allRows = await appointmentsOn(db, date);
  const appointments = await toSummaries(db, allRows, labels);
  const counts = await countByStatus(db, date);

  return {
    date,
    weekday,
    weekdayName: weekdayName(weekday),
    isWorkingDay: chairs.some((view) => view.slots.some((slot) => slot.kind === 'franja')),
    chairs,
    capacity: aggregateCapacity(date, chairs),
    appointments,
    waiting: waitingRows.map((row) => toRequestSummary(row, { now })),
    counts: countsOf(counts),
  };
};

const chairDayView = async (
  db: SchedulingDb,
  date: string,
  weekday: number,
  config: SchedulingConfig,
  chair: Chair,
  labels: SummaryLabels,
): Promise<ChairDayView> => {
  const [info, templates, rows, counts, ownSchedule] = await Promise.all([
    capacityFor(db, date, config, chair.id),
    activeTemplatesFor(db, weekday, chair.id),
    appointmentsOn(db, date, chair.id),
    countByStatus(db, date, chair.id),
    hasOwnSchedule(db, weekday, chair.id),
  ]);

  const summaries = await toSummaries(db, rows, labels);
  const summaryById = new Map(summaries.map((summary) => [summary.id, summary]));

  return {
    chair,
    capacity: toDayCapacity(info),
    ownSchedule,
    slots: buildSlots(chair, templates, occupyingOf(rows), summaryById),
    counts: countsOf(counts),
  };
};

/** Reexporta utilidades de hora que la interfaz usa para pintar la jornada. */
export { addMinutes, formatTime12h };
