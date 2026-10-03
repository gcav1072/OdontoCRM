import {
  expandTemplateSlots,
  weekdayOf,
  type CapacitySource,
  type DayCapacity,
  type SlotTemplate,
  type SlotTemplateInput,
  type TimeRange,
} from '@odontocrm/contracts';
import { EVENT_TOPICS } from '@odontocrm/events';
import { ConflictError, NotFoundError } from '@odontocrm/kernel';
import { and, asc, eq, gte, inArray, lte, sql } from 'drizzle-orm';

import type { SchedulingConfig } from '../config.js';
import type { SchedulingDb } from '../db/client.js';
import {
  appointments,
  dayCapacities,
  slotTemplates,
  type DayCapacityRow,
  type SlotTemplateRow,
} from '../db/schema.js';
import { toHm, OCCUPYING_STATUSES } from '../mappers.js';
import type { ActorContext } from '../shared/context.js';
import { auditPayload, publish } from '../shared/events.js';
import { dayCapacityId } from '../shared/ids.js';

/** Cupo del día resuelto: explícito, deducido de las franjas o por defecto. */
export interface CapacityInfo {
  date: string;
  capacity: number;
  source: CapacitySource;
  explicit: DayCapacityRow | null;
  assigned: number;
  available: number;
  isFull: boolean;
  warning: string | null;
}

/** Citas que ocupan el día (las canceladas y reprogramadas liberan su hueco). */
export const assignedOn = async (db: SchedulingDb, date: string): Promise<number> => {
  const rows = await db
    .select({ value: sql<number>`count(1)::int` })
    .from(appointments)
    .where(
      and(
        eq(appointments.appointmentDate, date),
        inArray(appointments.status, [...OCCUPYING_STATUSES]),
      ),
    );
  return rows[0]?.value ?? 0;
};

export const activeTemplatesFor = async (
  db: SchedulingDb,
  weekday: number,
): Promise<SlotTemplateRow[]> =>
  db
    .select()
    .from(slotTemplates)
    .where(and(eq(slotTemplates.weekday, weekday), eq(slotTemplates.isActive, true)))
    .orderBy(asc(slotTemplates.startTime));

/** Franjas de un día según su plantilla (vacío si no es día de consulta). */
export const slotsForDate = async (db: SchedulingDb, date: string): Promise<TimeRange[]> => {
  const templates = await activeTemplatesFor(db, weekdayOf(date));
  return templates.flatMap((template) =>
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
};

const buildInfo = (
  date: string,
  capacity: number,
  source: CapacitySource,
  explicit: DayCapacityRow | null,
  assigned: number,
): CapacityInfo => ({
  date,
  capacity,
  source,
  explicit,
  assigned,
  available: Math.max(0, capacity - assigned),
  isFull: assigned >= capacity,
  warning:
    assigned > capacity
      ? `El cupo (${String(capacity)}) queda por debajo de las ${String(assigned)} citas ya asignadas de ese día: no se ha borrado ninguna.`
      : null,
});

export const capacityFor = async (
  db: SchedulingDb,
  date: string,
  config: Pick<SchedulingConfig, 'DEFAULT_DAY_CAPACITY'>,
): Promise<CapacityInfo> => {
  const [explicitRows, assigned, slots] = await Promise.all([
    db.select().from(dayCapacities).where(eq(dayCapacities.date, date)).limit(1),
    assignedOn(db, date),
    slotsForDate(db, date),
  ]);

  const explicit = explicitRows[0] ?? null;
  if (explicit !== null) {
    return buildInfo(date, explicit.capacity, 'explicito', explicit, assigned);
  }
  if (slots.length > 0) {
    return buildInfo(date, slots.length, 'plantilla', null, assigned);
  }
  return buildInfo(date, config.DEFAULT_DAY_CAPACITY, 'defecto', null, assigned);
};

export const toDayCapacity = (info: CapacityInfo): DayCapacity => ({
  date: info.date,
  capacity: info.capacity,
  source: info.source,
  explicitCapacity: info.explicit?.capacity ?? null,
  notes: info.explicit?.notes ?? null,
  assigned: info.assigned,
  available: info.available,
  isFull: info.isFull,
  warning: info.warning,
  updatedBy: info.explicit?.updatedBy ?? null,
  updatedAt: info.explicit?.updatedAt.toISOString() ?? null,
});

/** Cupos de un rango de fechas (para el calendario de ocupación de la jornada). */
export const listCapacities = async (
  db: SchedulingDb,
  from: string,
  to: string,
  config: Pick<SchedulingConfig, 'DEFAULT_DAY_CAPACITY'>,
): Promise<DayCapacity[]> => {
  const explicitRows = await db
    .select()
    .from(dayCapacities)
    .where(and(gte(dayCapacities.date, from), lte(dayCapacities.date, to)));
  const explicitByDate = new Map(explicitRows.map((row) => [row.date, row]));

  const allTemplates = await db
    .select()
    .from(slotTemplates)
    .where(eq(slotTemplates.isActive, true));
  const byWeekday = new Map<number, SlotTemplateRow[]>();
  for (const template of allTemplates) {
    const list = byWeekday.get(template.weekday) ?? [];
    list.push(template);
    byWeekday.set(template.weekday, list);
  }

  const counts = await db
    .select({
      date: appointments.appointmentDate,
      value: sql<number>`count(1)::int`,
    })
    .from(appointments)
    .where(
      and(
        gte(appointments.appointmentDate, from),
        lte(appointments.appointmentDate, to),
        inArray(appointments.status, [...OCCUPYING_STATUSES]),
      ),
    )
    .groupBy(appointments.appointmentDate);
  const assignedByDate = new Map(counts.map((row) => [row.date, row.value]));

  const result: DayCapacity[] = [];
  const cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  for (
    let day = cursor;
    day.getTime() <= end.getTime();
    day = new Date(day.getTime() + 86_400_000)
  ) {
    const date = day.toISOString().slice(0, 10);
    const explicit = explicitByDate.get(date) ?? null;
    const templates = byWeekday.get(weekdayOf(date)) ?? [];
    const slotCount = templates.reduce(
      (total, template) =>
        total +
        expandTemplateSlots({
          startTime: toHm(template.startTime),
          endTime: toHm(template.endTime),
          slotMinutes: template.slotMinutes,
          breaks: template.breaks,
        }).length,
      0,
    );

    const assigned = assignedByDate.get(date) ?? 0;
    const capacity =
      explicit?.capacity ?? (slotCount > 0 ? slotCount : config.DEFAULT_DAY_CAPACITY);
    const source: CapacitySource =
      explicit !== null ? 'explicito' : slotCount > 0 ? 'plantilla' : 'defecto';

    result.push(toDayCapacity(buildInfo(date, capacity, source, explicit, assigned)));
  }
  return result;
};

/** Cambia el cupo del día (editable en cualquier momento, incluso ya asignado). */
export const setCapacity = async (
  db: SchedulingDb,
  input: {
    date: string;
    capacity: number;
    notes?: string | undefined;
    reason?: string | undefined;
  },
  actor: ActorContext,
  config: Pick<SchedulingConfig, 'DEFAULT_DAY_CAPACITY'>,
): Promise<DayCapacity> => {
  const previous = await capacityFor(db, input.date, config);

  await db.transaction(async (tx) => {
    await tx
      .insert(dayCapacities)
      .values({
        date: input.date,
        capacity: input.capacity,
        notes: input.notes ?? null,
        updatedBy: actor.actorId,
      })
      .onConflictDoUpdate({
        target: dayCapacities.date,
        set: {
          capacity: input.capacity,
          notes: input.notes ?? null,
          updatedBy: actor.actorId,
          updatedAt: new Date(),
        },
      });

    await publish(tx, {
      topic: EVENT_TOPICS.capacityChanged,
      aggregateId: dayCapacityId(input.date),
      actor,
      payload: {
        ...auditPayload({
          entityType: 'day_capacity',
          entityId: dayCapacityId(input.date),
          action: 'day_capacity_changed',
          summary: `Cupo del ${input.date}: ${String(previous.capacity)} → ${String(input.capacity)}`,
          changedFields: ['capacity'],
          before: { capacity: previous.capacity, assigned: previous.assigned },
          after: { capacity: input.capacity, assigned: previous.assigned },
          reason: input.reason ?? null,
          actor,
        }),
        date: input.date,
        capacity: input.capacity,
        assigned: previous.assigned,
      },
    });
  });

  return toDayCapacity(await capacityFor(db, input.date, config));
};

export const toSlotTemplate = (row: SlotTemplateRow): SlotTemplate => ({
  id: row.id,
  weekday: row.weekday,
  startTime: toHm(row.startTime),
  endTime: toHm(row.endTime),
  slotMinutes: row.slotMinutes,
  breaks: row.breaks.map((pause) => ({
    startTime: toHm(pause.startTime),
    endTime: toHm(pause.endTime),
  })),
  isActive: row.isActive,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

export const listTemplates = async (db: SchedulingDb): Promise<SlotTemplate[]> => {
  const rows = await db
    .select()
    .from(slotTemplates)
    .orderBy(asc(slotTemplates.weekday), asc(slotTemplates.startTime));
  return rows.map(toSlotTemplate);
};

export const createTemplate = async (
  db: SchedulingDb,
  input: SlotTemplateInput,
  actor: ActorContext,
): Promise<SlotTemplate> => {
  const created = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(slotTemplates)
      .values({
        weekday: input.weekday,
        startTime: input.startTime,
        endTime: input.endTime,
        slotMinutes: input.slotMinutes,
        breaks: input.breaks,
        isActive: input.isActive,
      })
      .returning();

    const row = inserted[0];
    if (row === undefined) throw new NotFoundError('No se pudo crear la plantilla');

    await publish(tx, {
      topic: EVENT_TOPICS.capacityChanged,
      aggregateId: row.id,
      actor,
      payload: {
        ...auditPayload({
          entityType: 'slot_template',
          entityId: row.id,
          action: 'slot_template_changed',
          summary: `Plantilla creada: día ${String(input.weekday)} de ${input.startTime} a ${input.endTime}`,
          changedFields: ['weekday', 'startTime', 'endTime', 'slotMinutes', 'breaks'],
          before: null,
          after: { ...input },
          actor,
        }),
        templateId: row.id,
      },
    });
    return row;
  });

  return toSlotTemplate(created);
};

export const updateTemplate = async (
  db: SchedulingDb,
  id: string,
  input: Partial<SlotTemplateInput>,
  actor: ActorContext,
): Promise<SlotTemplate> => {
  const currentRows = await db
    .select()
    .from(slotTemplates)
    .where(eq(slotTemplates.id, id))
    .limit(1);
  const current = currentRows[0];
  if (current === undefined) throw new NotFoundError('La plantilla no existe');

  const updated = await db.transaction(async (tx) => {
    const rows = await tx
      .update(slotTemplates)
      .set({
        ...(input.weekday === undefined ? {} : { weekday: input.weekday }),
        ...(input.startTime === undefined ? {} : { startTime: input.startTime }),
        ...(input.endTime === undefined ? {} : { endTime: input.endTime }),
        ...(input.slotMinutes === undefined ? {} : { slotMinutes: input.slotMinutes }),
        ...(input.breaks === undefined ? {} : { breaks: input.breaks }),
        ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
        updatedAt: new Date(),
      })
      .where(eq(slotTemplates.id, id))
      .returning();

    const row = rows[0];
    if (row === undefined) throw new NotFoundError('La plantilla no existe');

    await publish(tx, {
      topic: EVENT_TOPICS.capacityChanged,
      aggregateId: id,
      actor,
      payload: {
        ...auditPayload({
          entityType: 'slot_template',
          entityId: id,
          action: 'slot_template_changed',
          summary: `Plantilla modificada (día ${String(row.weekday)}, ${toHm(row.startTime)}–${toHm(row.endTime)})`,
          changedFields: Object.keys(input),
          before: {
            weekday: current.weekday,
            startTime: toHm(current.startTime),
            endTime: toHm(current.endTime),
            slotMinutes: current.slotMinutes,
            isActive: current.isActive,
          },
          after: {
            weekday: row.weekday,
            startTime: toHm(row.startTime),
            endTime: toHm(row.endTime),
            slotMinutes: row.slotMinutes,
            isActive: row.isActive,
          },
          actor,
        }),
        templateId: id,
      },
    });
    return row;
  });

  return toSlotTemplate(updated);
};

/**
 * Quitar una plantilla no borra citas: las citas ya asignadas siguen en la agenda
 * (aparecen como huecos manuales), solo desaparece la rejilla de ese día.
 */
export const deleteTemplate = async (
  db: SchedulingDb,
  id: string,
  actor: ActorContext,
): Promise<void> => {
  const currentRows = await db
    .select()
    .from(slotTemplates)
    .where(eq(slotTemplates.id, id))
    .limit(1);
  const current = currentRows[0];
  if (current === undefined) throw new NotFoundError('La plantilla no existe');

  await db.transaction(async (tx) => {
    await tx
      .update(slotTemplates)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(slotTemplates.id, id));

    await publish(tx, {
      topic: EVENT_TOPICS.capacityChanged,
      aggregateId: id,
      actor,
      payload: {
        ...auditPayload({
          entityType: 'slot_template',
          entityId: id,
          action: 'slot_template_changed',
          summary: `Plantilla desactivada (día ${String(current.weekday)}, ${toHm(current.startTime)}–${toHm(current.endTime)})`,
          changedFields: ['isActive'],
          before: { isActive: current.isActive },
          after: { isActive: false },
          actor,
        }),
        templateId: id,
      },
    });
  });
};

/** Comprueba que el día no esté lleno; el sobrecupo exige permiso y motivo. */
export const assertCapacityAvailable = async (
  db: SchedulingDb,
  date: string,
  options: {
    authorizeOverbook: boolean;
    overbookReason?: string | undefined;
    canOverbook: boolean;
  },
  config: Pick<SchedulingConfig, 'DEFAULT_DAY_CAPACITY'>,
): Promise<{ overbooked: boolean; info: CapacityInfo }> => {
  const info = await capacityFor(db, date, config);
  if (!info.isFull) return { overbooked: false, info };

  if (!options.authorizeOverbook) {
    throw new ConflictError(
      `El día está completo (${String(info.assigned)}/${String(info.capacity)}). Autoriza el sobrecupo con un motivo para añadir otra cita.`,
      { extensions: { requiresOverbook: true, capacity: info.capacity, assigned: info.assigned } },
    );
  }
  if (!options.canOverbook) {
    throw new ConflictError('Solo el administrador puede autorizar un sobrecupo', {
      extensions: { requiresOverbook: true, forbidden: true },
    });
  }
  return { overbooked: true, info };
};
