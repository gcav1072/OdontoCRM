import {
  expandTemplateSlots,
  formatTime12h,
  shiftsToTemplates,
  usedCapacity,
  weekdayOf,
  type CapacitySource,
  type DayCapacity,
  type SlotTemplate,
  type SlotTemplateInput,
  type TimeRange,
  type WeekScheduleInput,
} from '@odontocrm/contracts';
import { EVENT_TOPICS } from '@odontocrm/events';
import { ConflictError, NotFoundError } from '@odontocrm/kernel';
import { and, asc, eq, gte, inArray, isNull, lte } from 'drizzle-orm';

import type { SchedulingDb } from '../db/client.js';
import {
  appointments,
  chairs,
  slotTemplates,
  type ChairRow,
  type SlotTemplateRow,
} from '../db/schema.js';
import { toHm, OCCUPYING_STATUSES } from '../mappers.js';
import type { ActorContext } from '../shared/context.js';
import { auditPayload, publish } from '../shared/events.js';
import { stableUuid } from '../shared/ids.js';

/** Cupo de un **consultorio** en un día: las franjas de su horario y lo que ocupan las citas. */
export interface CapacityInfo {
  date: string;
  chairId: string;
  chairLabel: string | null;
  capacity: number;
  source: CapacitySource;
  assigned: number;
  available: number;
  isFull: boolean;
  warning: string | null;
}

/** Cita que ocupa cupo, con su id para poder excluirla al reprogramar. */
interface OccupiedSlot {
  id: string;
  range: TimeRange;
}

/**
 * Rangos de las citas que ocupan el día (las canceladas y reprogramadas liberan su
 * hueco). Con `chairId` solo las de ese consultorio.
 */
export const occupiedRangesOn = async (
  db: SchedulingDb,
  date: string,
  chairId?: string,
): Promise<OccupiedSlot[]> => {
  const condiciones = [
    eq(appointments.appointmentDate, date),
    inArray(appointments.status, [...OCCUPYING_STATUSES]),
  ];
  if (chairId !== undefined) condiciones.push(eq(appointments.chairId, chairId));

  const rows = await db
    .select({
      id: appointments.id,
      startTime: appointments.startTime,
      endTime: appointments.endTime,
    })
    .from(appointments)
    .where(and(...condiciones));

  return rows.map((row) => ({
    id: row.id,
    range: { startTime: toHm(row.startTime), endTime: toHm(row.endTime) },
  }));
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
): Promise<TimeRange[]> => slotsOf(await activeTemplatesFor(db, weekdayOf(date), chairId));

const buildInfo = (
  date: string,
  chair: Pick<ChairRow, 'id' | 'label'>,
  capacity: number,
  source: CapacitySource,
  assigned: number,
): CapacityInfo => ({
  date,
  chairId: chair.id,
  chairLabel: chair.label,
  capacity,
  source,
  assigned,
  available: Math.max(0, capacity - assigned),
  isFull: assigned >= capacity,
  warning:
    assigned > capacity
      ? `Se ocuparon ${String(assigned)} franjas en ${chair.label} y el día tiene ${String(capacity)}: hay citas por encima del cupo; no se ha borrado ninguna.`
      : null,
});

/** Ficha del consultorio (para etiquetar el cupo); error si no existe. */
export const chairFor = async (db: SchedulingDb, chairId: string): Promise<ChairRow> => {
  const rows = await db.select().from(chairs).where(eq(chairs.id, chairId)).limit(1);
  const row = rows[0];
  if (row === undefined) throw new NotFoundError('El consultorio no existe');
  return row;
};

/**
 * Cita que se está intentando meter en el día. Sin ella, `capacityFor` describe el
 * día tal como está. Con ella, `assigned` cuenta **también** las franjas que
 * gastaría: es lo que necesita el sobrecupo para decidir con el tamaño real de la
 * cita (una consulta de dos horas gasta cuatro franjas de 30 minutos).
 */
export interface CapacityProbe {
  range: TimeRange;
  /** Cita que se está moviendo: no se cuenta dos veces en su día original. */
  ignoreAppointmentId?: string | undefined;
}

export const capacityFor = async (
  db: SchedulingDb,
  date: string,
  chairId: string,
  probe?: CapacityProbe,
): Promise<CapacityInfo> => {
  const chair = await chairFor(db, chairId);
  const [templates, occupied] = await Promise.all([
    activeTemplatesFor(db, weekdayOf(date), chairId),
    occupiedRangesOn(db, date, chairId),
  ]);
  const slots = slotsOf(templates);

  const rangos = occupied
    .filter((slot) => slot.id !== probe?.ignoreAppointmentId)
    .map((slot) => slot.range);
  if (probe !== undefined) rangos.push(probe.range);

  return buildInfo(
    date,
    chair,
    slots.length,
    slots.length > 0 ? 'plantilla' : 'sin_turnos',
    usedCapacity(slots, rangos),
  );
};

/** Franjas de una lista de plantillas, en orden de hora. */
const slotsOf = (templates: readonly SlotTemplateRow[]): TimeRange[] =>
  templates
    .flatMap((template) =>
      expandTemplateSlots({
        startTime: toHm(template.startTime),
        endTime: toHm(template.endTime),
        slotMinutes: template.slotMinutes,
        breaks: template.breaks.map((pause) => ({
          startTime: toHm(pause.startTime),
          endTime: toHm(pause.endTime),
        })),
      }),
    )
    .sort((left, right) => left.startTime.localeCompare(right.startTime));

export const toDayCapacity = (info: CapacityInfo): DayCapacity => ({
  date: info.date,
  chairId: info.chairId,
  chairLabel: info.chairLabel,
  capacity: info.capacity,
  source: info.source,
  assigned: info.assigned,
  available: info.available,
  isFull: info.isFull,
  warning: info.warning,
});

/**
 * Cupos de un rango de fechas **agregados por día** (suma de consultorios), para el
 * calendario de ocupación. El detalle por consultorio lo devuelve la jornada
 * (`getDayView`).
 *
 * El cupo es siempre el del horario: si un día no tiene turnos (o solo tiene
 * consultorios cerrados) su cupo es 0 y su fuente `sin_turnos`.
 */
export const listCapacities = async (
  db: SchedulingDb,
  from: string,
  to: string,
): Promise<DayCapacity[]> => {
  const [activeChairs, allTemplates, occupyingRows] = await Promise.all([
    db
      .select()
      .from(chairs)
      .where(eq(chairs.isActive, true))
      .orderBy(asc(chairs.sortOrder), asc(chairs.label)),
    db.select().from(slotTemplates).where(eq(slotTemplates.isActive, true)),
    db
      .select({
        id: appointments.id,
        date: appointments.appointmentDate,
        chairId: appointments.chairId,
        startTime: appointments.startTime,
        endTime: appointments.endTime,
      })
      .from(appointments)
      .where(
        and(
          gte(appointments.appointmentDate, from),
          lte(appointments.appointmentDate, to),
          inArray(appointments.status, [...OCCUPYING_STATUSES]),
        ),
      ),
  ]);

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

    let capacity = 0;
    let assigned = 0;
    for (const chair of activeChairs) {
      const propias = allTemplates.filter(
        (template) => template.chairId === chair.id && template.weekday === weekday,
      );
      const comunes = allTemplates.filter(
        (template) => template.chairId === null && template.weekday === weekday,
      );
      const slots = slotsOf(propias.length > 0 ? propias : comunes);
      const ocupadas = occupyingRows
        .filter((row) => row.date === date && row.chairId === chair.id)
        .map((row) => ({ startTime: toHm(row.startTime), endTime: toHm(row.endTime) }));
      capacity += slots.length;
      assigned += usedCapacity(slots, ocupadas);
    }

    const source: CapacitySource = capacity > 0 ? 'plantilla' : 'sin_turnos';
    result.push({
      date,
      chairId: null,
      chairLabel: null,
      capacity,
      source,
      assigned,
      available: Math.max(0, capacity - assigned),
      isFull: assigned >= capacity,
      warning:
        assigned > capacity
          ? `Se ocuparon ${String(assigned)} franjas y el día tiene ${String(capacity)}: hay citas por encima del cupo; no se ha borrado ninguna.`
          : null,
    });
  }
  return result;
};

/** Horarios del consultorio (o comunes si `chairId` es `null`). */
const templatesOf = async (
  db: SchedulingDb,
  weekdays: readonly number[],
  chairId: string | null,
): Promise<SlotTemplateRow[]> =>
  db
    .select()
    .from(slotTemplates)
    .where(
      and(
        inArray(slotTemplates.weekday, [...weekdays]),
        chairId === null ? isNull(slotTemplates.chairId) : eq(slotTemplates.chairId, chairId),
      ),
    )
    .orderBy(asc(slotTemplates.weekday), asc(slotTemplates.startTime));

/**
 * Fija el **horario de atención** de uno o varios días de la semana.
 *
 * Reconcilia en lugar de borrar: un turno que conserva su hora de inicio se
 * actualiza (así no pierde su `id` ni sus pausas), uno nuevo se inserta y los que
 * sobran se **desactivan** (`is_active = false`). Un `shifts` vacío deja el día
 * cerrado sin tocar las citas ya asignadas.
 *
 * El cupo no se guarda: sale de las franjas que produzcan estos turnos.
 */
export const replaceWeekSchedule = async (
  db: SchedulingDb,
  input: WeekScheduleInput,
  actor: ActorContext,
): Promise<SlotTemplate[]> => {
  const weekdays = [...input.weekdays].sort((left, right) => left - right);
  const desired = weekdays.flatMap((weekday) =>
    shiftsToTemplates(weekday, input.shifts, input.slotMinutes).map((template) => ({
      ...template,
      chairId: input.chairId,
    })),
  );

  await db.transaction(async (tx) => {
    const current = await tx
      .select()
      .from(slotTemplates)
      .where(
        and(
          inArray(slotTemplates.weekday, weekdays),
          input.chairId === null
            ? isNull(slotTemplates.chairId)
            : eq(slotTemplates.chairId, input.chairId),
        ),
      )
      .orderBy(asc(slotTemplates.weekday), asc(slotTemplates.startTime));

    const porDia = new Map<number, SlotTemplateRow[]>();
    for (const row of current) {
      porDia.set(row.weekday, [...(porDia.get(row.weekday) ?? []), row]);
    }

    const conservadas = new Set<string>();
    for (const template of desired) {
      const existentes = porDia.get(template.weekday) ?? [];
      const mismaHora = existentes.find(
        (row) => !conservadas.has(row.id) && toHm(row.startTime) === template.startTime,
      );

      if (mismaHora === undefined) {
        await tx.insert(slotTemplates).values({
          weekday: template.weekday,
          chairId: input.chairId,
          startTime: template.startTime,
          endTime: template.endTime,
          slotMinutes: template.slotMinutes,
          breaks: [],
          isActive: true,
        });
        continue;
      }

      conservadas.add(mismaHora.id);
      // Las pausas se conservan: el editor no las toca y borrarlas cambiaría el cupo
      // de un día que nadie pidió cambiar.
      await tx
        .update(slotTemplates)
        .set({
          endTime: template.endTime,
          slotMinutes: template.slotMinutes,
          isActive: true,
          updatedAt: new Date(),
        })
        .where(eq(slotTemplates.id, mismaHora.id));
    }

    const sobrantes = current.filter((row) => !conservadas.has(row.id) && row.isActive);
    if (sobrantes.length > 0) {
      await tx
        .update(slotTemplates)
        .set({ isActive: false, updatedAt: new Date() })
        .where(
          inArray(
            slotTemplates.id,
            sobrantes.map((row) => row.id),
          ),
        );
    }

    for (const weekday of weekdays) {
      const turnos = desired.filter((template) => template.weekday === weekday);
      const anteriores = porDia.get(weekday) ?? [];
      const resumen =
        turnos.length === 0
          ? `Día ${String(weekday)} cerrado (sin turnos de atención)`
          : `Horario del día ${String(weekday)}: ${turnos
              .map((turno) => `${formatTime12h(turno.startTime)}–${formatTime12h(turno.endTime)}`)
              .join(' y ')} (franjas de ${String(input.slotMinutes)} min)`;

      await publish(tx, {
        topic: EVENT_TOPICS.capacityChanged,
        aggregateId: stableUuid(`week_schedule:${String(weekday)}:${input.chairId ?? 'comun'}`),
        actor,
        payload: {
          ...auditPayload({
            entityType: 'slot_template',
            entityId: stableUuid(`week_schedule:${String(weekday)}:${input.chairId ?? 'comun'}`),
            action: 'slot_template_changed',
            summary: resumen,
            changedFields: ['startTime', 'endTime', 'slotMinutes', 'isActive'],
            before: {
              turnos: anteriores
                .filter((row) => row.isActive)
                .map((row) => ({ startTime: toHm(row.startTime), endTime: toHm(row.endTime) })),
              slotMinutes: anteriores[0]?.slotMinutes ?? null,
            },
            after: {
              turnos: turnos.map((turno) => ({
                startTime: turno.startTime,
                endTime: turno.endTime,
              })),
              slotMinutes: input.slotMinutes,
            },
            reason: input.reason ?? null,
            actor,
          }),
          weekday,
          chairId: input.chairId,
          slotMinutes: input.slotMinutes,
          shifts: turnos.map((turno) => ({
            startTime: turno.startTime,
            endTime: turno.endTime,
          })),
        },
      });
    }
  });

  return (await templatesOf(db, weekdays, input.chairId))
    .filter((row) => row.isActive)
    .map(toSlotTemplate);
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

/**
 * Comprueba que **la cita que se quiere meter** quepa en el día; el sobrecupo exige
 * permiso y motivo.
 *
 * Se cuenta la cita propuesta, no solo lo que ya hay: una consulta de dos horas
 * sobre franjas de 30 minutos gasta 4 franjas y puede no caber aunque quede «una
 * libre». En un día sin turnos (cerrado) cualquier cita es sobrecupo.
 */
export const assertCapacityAvailable = async (
  db: SchedulingDb,
  date: string,
  chairId: string,
  proposed: TimeRange,
  options: {
    authorizeOverbook: boolean;
    overbookReason?: string | undefined;
    canOverbook: boolean;
    /** Cita que se está reprogramando: no cuenta en su ubicación anterior. */
    ignoreAppointmentId?: string | undefined;
  },
): Promise<{ overbooked: boolean; info: CapacityInfo }> => {
  const info = await capacityFor(db, date, chairId, {
    range: proposed,
    ignoreAppointmentId: options.ignoreAppointmentId,
  });
  const cabe = info.assigned <= info.capacity;
  if (cabe) return { overbooked: false, info };

  const detalle = `${String(info.assigned)}/${String(info.capacity)} franjas`;
  if (!options.authorizeOverbook) {
    throw new ConflictError(
      `${info.chairLabel ?? 'El consultorio'} no tiene cupo el ${date} (${detalle}). Autoriza el sobrecupo con un motivo para añadir otra cita.`,
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
