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
  chairs,
  dayCapacities,
  slotTemplates,
  type ChairRow,
  type DayCapacityRow,
  type SlotTemplateRow,
} from '../db/schema.js';
import { toHm, OCCUPYING_STATUSES } from '../mappers.js';
import type { ActorContext } from '../shared/context.js';
import { auditPayload, publish } from '../shared/events.js';
import { dayCapacityId } from '../shared/ids.js';

/** Cupo de un **consultorio** en un día: explícito, deducido de las franjas o por defecto. */
export interface CapacityInfo {
  date: string;
  chairId: string;
  chairLabel: string | null;
  capacity: number;
  source: CapacitySource;
  explicit: DayCapacityRow | null;
  assigned: number;
  available: number;
  isFull: boolean;
  warning: string | null;
}

/**
 * Citas que ocupan el día (las canceladas y reprogramadas liberan su hueco).
 * Con `chairId` cuenta solo las de ese consultorio.
 */
export const assignedOn = async (
  db: SchedulingDb,
  date: string,
  chairId?: string,
): Promise<number> => {
  const condiciones = [
    eq(appointments.appointmentDate, date),
    inArray(appointments.status, [...OCCUPYING_STATUSES]),
  ];
  if (chairId !== undefined) condiciones.push(eq(appointments.chairId, chairId));

  const rows = await db
    .select({ value: sql<number>`count(1)::int` })
    .from(appointments)
    .where(and(...condiciones));
  return rows[0]?.value ?? 0;
};

/**
 * Plantillas activas de un día para un consultorio: la **propia** del sillón si la
 * tiene, y si no, la **común** (`chair_id = null`). Sin `chairId` se devuelven las
 * comunes, que es la plantilla que ve la jornada agregada.
 */
export const activeTemplatesFor = async (
  db: SchedulingDb,
  weekday: number,
  chairId: string | null = null,
): Promise<SlotTemplateRow[]> => {
  const rows = await db
    .select()
    .from(slotTemplates)
    .where(and(eq(slotTemplates.weekday, weekday), eq(slotTemplates.isActive, true)))
    .orderBy(asc(slotTemplates.startTime));

  const comunes = rows.filter((row) => row.chairId === null);
  if (chairId === null) return comunes;
  const propias = rows.filter((row) => row.chairId === chairId);
  return propias.length > 0 ? propias : comunes;
};

/** ¿El consultorio tiene plantilla propia ese día de la semana? */
export const hasOwnSchedule = async (
  db: SchedulingDb,
  weekday: number,
  chairId: string,
): Promise<boolean> => {
  const rows = await db
    .select({ id: slotTemplates.id })
    .from(slotTemplates)
    .where(
      and(
        eq(slotTemplates.weekday, weekday),
        eq(slotTemplates.isActive, true),
        eq(slotTemplates.chairId, chairId),
      ),
    )
    .limit(1);
  return rows.length > 0;
};

/** Franjas de un día según la plantilla de su consultorio (vacío si no es día de consulta). */
export const slotsForDate = async (
  db: SchedulingDb,
  date: string,
  chairId: string | null = null,
): Promise<TimeRange[]> => {
  const templates = await activeTemplatesFor(db, weekdayOf(date), chairId);
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
  chair: Pick<ChairRow, 'id' | 'label'>,
  capacity: number,
  source: CapacitySource,
  explicit: DayCapacityRow | null,
  assigned: number,
): CapacityInfo => ({
  date,
  chairId: chair.id,
  chairLabel: chair.label,
  capacity,
  source,
  explicit,
  assigned,
  available: Math.max(0, capacity - assigned),
  isFull: assigned >= capacity,
  warning:
    assigned > capacity
      ? `El cupo de ${chair.label} (${String(capacity)}) queda por debajo de las ${String(assigned)} citas ya asignadas de ese día: no se ha borrado ninguna.`
      : null,
});

/** Ficha del consultorio (para etiquetar el cupo); error si no existe. */
export const chairFor = async (db: SchedulingDb, chairId: string): Promise<ChairRow> => {
  const rows = await db.select().from(chairs).where(eq(chairs.id, chairId)).limit(1);
  const row = rows[0];
  if (row === undefined) throw new NotFoundError('El consultorio no existe');
  return row;
};

export const capacityFor = async (
  db: SchedulingDb,
  date: string,
  config: Pick<SchedulingConfig, 'DEFAULT_DAY_CAPACITY'>,
  chairId: string,
): Promise<CapacityInfo> => {
  const chair = await chairFor(db, chairId);
  const [explicitRows, assigned, slots] = await Promise.all([
    db
      .select()
      .from(dayCapacities)
      .where(and(eq(dayCapacities.date, date), eq(dayCapacities.chairId, chairId)))
      .limit(1),
    assignedOn(db, date, chairId),
    slotsForDate(db, date, chairId),
  ]);

  const explicit = explicitRows[0] ?? null;
  if (explicit !== null) {
    return buildInfo(date, chair, explicit.capacity, 'explicito', explicit, assigned);
  }
  if (slots.length > 0) {
    return buildInfo(date, chair, slots.length, 'plantilla', null, assigned);
  }
  return buildInfo(date, chair, config.DEFAULT_DAY_CAPACITY, 'defecto', null, assigned);
};

export const toDayCapacity = (info: CapacityInfo): DayCapacity => ({
  date: info.date,
  chairId: info.chairId,
  chairLabel: info.chairLabel,
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

/**
 * Cupos de un rango de fechas **agregados por día** (suma de consultorios), para el
 * calendario de ocupación. El detalle por consultorio lo devuelve la jornada
 * (`getDayView`).
 */
export const listCapacities = async (
  db: SchedulingDb,
  from: string,
  to: string,
  config: Pick<SchedulingConfig, 'DEFAULT_DAY_CAPACITY'>,
): Promise<DayCapacity[]> => {
  const [activeChairs, explicitRows, counts, allTemplates] = await Promise.all([
    db
      .select()
      .from(chairs)
      .where(eq(chairs.isActive, true))
      .orderBy(asc(chairs.sortOrder), asc(chairs.label)),
    db
      .select()
      .from(dayCapacities)
      .where(and(gte(dayCapacities.date, from), lte(dayCapacities.date, to))),
    db
      .select({ date: appointments.appointmentDate, value: sql<number>`count(1)::int` })
      .from(appointments)
      .where(
        and(
          gte(appointments.appointmentDate, from),
          lte(appointments.appointmentDate, to),
          inArray(appointments.status, [...OCCUPYING_STATUSES]),
        ),
      )
      .groupBy(appointments.appointmentDate),
    db.select().from(slotTemplates).where(eq(slotTemplates.isActive, true)),
  ]);

  const explicitByDate = new Map<string, number>();
  for (const row of explicitRows) {
    explicitByDate.set(row.date, (explicitByDate.get(row.date) ?? 0) + row.capacity);
  }
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
    const weekday = weekdayOf(date);

    // Capacidad del día = suma de la de cada consultorio activo (plantilla propia o común).
    let slotTotal = 0;
    let capacity = 0;
    for (const chair of activeChairs) {
      const propias = allTemplates.filter(
        (template) => template.chairId === chair.id && template.weekday === weekday,
      );
      const comunes = allTemplates.filter(
        (template) => template.chairId === null && template.weekday === weekday,
      );
      const efectivas = propias.length > 0 ? propias : comunes;
      const slotCount = efectivas.reduce(
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
      slotTotal += slotCount;
      capacity += slotCount > 0 ? slotCount : config.DEFAULT_DAY_CAPACITY;
    }

    const explicit = explicitByDate.get(date) ?? null;
    const assigned = assignedByDate.get(date) ?? 0;
    const capacidadDia = explicit ?? capacity;
    const source: CapacitySource =
      explicit !== null ? 'explicito' : slotTotal > 0 ? 'plantilla' : 'defecto';

    result.push({
      date,
      chairId: null,
      chairLabel: null,
      capacity: capacidadDia,
      source,
      explicitCapacity: explicit,
      notes: null,
      assigned,
      available: Math.max(0, capacidadDia - assigned),
      isFull: assigned >= capacidadDia,
      warning:
        assigned > capacidadDia
          ? `El cupo (${String(capacidadDia)}) queda por debajo de las ${String(assigned)} citas ya asignadas de ese día: no se ha borrado ninguna.`
          : null,
      updatedBy: null,
      updatedAt: null,
    });
  }
  return result;
};

/** Cambia el cupo de un **consultorio** en un día (editable en cualquier momento). */
export const setCapacity = async (
  db: SchedulingDb,
  input: {
    chairId: string;
    date: string;
    capacity: number;
    notes?: string | undefined;
    reason?: string | undefined;
  },
  actor: ActorContext,
  config: Pick<SchedulingConfig, 'DEFAULT_DAY_CAPACITY'>,
): Promise<DayCapacity> => {
  const previous = await capacityFor(db, input.date, config, input.chairId);

  await db.transaction(async (tx) => {
    await tx
      .insert(dayCapacities)
      .values({
        date: input.date,
        chairId: input.chairId,
        capacity: input.capacity,
        notes: input.notes ?? null,
        updatedBy: actor.actorId,
      })
      .onConflictDoUpdate({
        target: [dayCapacities.date, dayCapacities.chairId],
        set: {
          capacity: input.capacity,
          notes: input.notes ?? null,
          updatedBy: actor.actorId,
          updatedAt: new Date(),
        },
      });

    await publish(tx, {
      topic: EVENT_TOPICS.capacityChanged,
      aggregateId: dayCapacityId(input.date, input.chairId),
      actor,
      payload: {
        ...auditPayload({
          entityType: 'day_capacity',
          entityId: dayCapacityId(input.date, input.chairId),
          action: 'day_capacity_changed',
          summary: `Cupo de ${previous.chairLabel ?? 'consultorio'} el ${input.date}: ${String(previous.capacity)} → ${String(input.capacity)}`,
          changedFields: ['capacity'],
          before: { capacity: previous.capacity, assigned: previous.assigned },
          after: { capacity: input.capacity, assigned: previous.assigned },
          reason: input.reason ?? null,
          actor,
        }),
        date: input.date,
        chairId: input.chairId,
        capacity: input.capacity,
        assigned: previous.assigned,
      },
    });
  });

  return toDayCapacity(await capacityFor(db, input.date, config, input.chairId));
};

export const toSlotTemplate = (row: SlotTemplateRow): SlotTemplate => ({
  id: row.id,
  weekday: row.weekday,
  chairId: row.chairId,
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
        chairId: input.chairId,
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
        ...(input.chairId === undefined ? {} : { chairId: input.chairId }),
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

/** Comprueba que el consultorio no esté lleno ese día; el sobrecupo exige permiso y motivo. */
export const assertCapacityAvailable = async (
  db: SchedulingDb,
  date: string,
  chairId: string,
  options: {
    authorizeOverbook: boolean;
    overbookReason?: string | undefined;
    canOverbook: boolean;
  },
  config: Pick<SchedulingConfig, 'DEFAULT_DAY_CAPACITY'>,
): Promise<{ overbooked: boolean; info: CapacityInfo }> => {
  const info = await capacityFor(db, date, config, chairId);
  if (!info.isFull) return { overbooked: false, info };

  if (!options.authorizeOverbook) {
    throw new ConflictError(
      `${info.chairLabel ?? 'El consultorio'} está completo el ${date} (${String(info.assigned)}/${String(info.capacity)}). Autoriza el sobrecupo con un motivo para añadir otra cita.`,
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
