import {
  addMinutes,
  hasPermission,
  minutesBetween,
  type AppointmentFilters,
  type AppointmentStatus,
  type AppointmentSummary,
  type AssignAppointmentInput,
  type Paginated,
  type RescheduleAppointmentInput,
  type StatusHistoryEntry,
} from '@odontocrm/contracts';
import { EVENT_TOPICS, type EventTopic } from '@odontocrm/events';
import { AppError, ConflictError, NotFoundError } from '@odontocrm/kernel';
import { and, asc, count, desc, eq, inArray, isNotNull, or, sql } from 'drizzle-orm';

import type { SchedulingConfig } from '../config.js';
import type { SchedulingDb } from '../db/client.js';
import {
  appointmentRequests,
  appointments,
  statusHistory,
  type AppointmentRequestRow,
  type AppointmentRow,
} from '../db/schema.js';
import {
  OCCUPYING_STATUSES,
  toAppointmentSummary,
  toHm,
  toStatusHistoryEntry,
} from '../mappers.js';
import { assertCapacityAvailable, slotsForDate } from '../agenda/capacity-service.js';
import { buildAppointmentMessage } from '../agenda/message.js';
import { assertCanTransition, toClinicInstant, type ActorContext } from '../shared/context.js';
import type { ClinicalSessionLookup } from '../shared/clinical-client.js';
import { auditPayload, publish } from '../shared/events.js';

export interface AssignOptions {
  config: SchedulingConfig;
}

const asSeconds = (time: string): string => `${toHm(time)}:00`;

/** Violación de índice único de PostgreSQL (dos citas para la misma hora y día). */
const isUniqueViolation = (error: unknown): boolean => {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== null && current !== undefined; depth += 1) {
    if (typeof current === 'object' && 'code' in current) {
      if ((current as { code?: unknown }).code === '23505') return true;
    }
    // Drizzle envuelve el error de PostgreSQL en `DrizzleQueryError`: hay que
    // mirar la causa para reconocer la violación de unicidad.
    current =
      typeof current === 'object' && 'cause' in current
        ? (current as { cause: unknown }).cause
        : null;
  }
  return false;
};

const slotTaken = (date: string, startTime: string): ConflictError =>
  new ConflictError(`Alguien acaba de ocupar las ${startTime} del ${date}. Elige otra franja.`, {
    extensions: { slot: { startTime } },
  });

const findRequest = async (db: SchedulingDb, id: string): Promise<AppointmentRequestRow | null> => {
  const rows = await db
    .select()
    .from(appointmentRequests)
    .where(eq(appointmentRequests.id, id))
    .limit(1);
  return rows[0] ?? null;
};

export const getAppointmentRow = async (db: SchedulingDb, id: string): Promise<AppointmentRow> => {
  const rows = await db.select().from(appointments).where(eq(appointments.id, id)).limit(1);
  const row = rows[0];
  if (row === undefined) throw new NotFoundError('La cita no existe');
  return row;
};

/** Cita que ocupa la misma hora en ese día (una sola silla: no hay doble cita). */
export const findOverlappingAppointment = async (
  db: SchedulingDb,
  input: { date: string; startTime: string; endTime: string; ignoreAppointmentId?: string },
): Promise<AppointmentRow | null> => {
  const conditions = [
    eq(appointments.appointmentDate, input.date),
    inArray(appointments.status, [...OCCUPYING_STATUSES]),
    sql`${appointments.startTime} < ${asSeconds(input.endTime)}::time`,
    sql`${appointments.endTime} > ${asSeconds(input.startTime)}::time`,
  ];
  if (input.ignoreAppointmentId !== undefined) {
    conditions.push(sql`${appointments.id} <> ${input.ignoreAppointmentId}`);
  }

  const rows = await db
    .select()
    .from(appointments)
    .where(and(...conditions))
    .limit(1);
  return rows[0] ?? null;
};

const loadRequests = async (
  db: SchedulingDb,
  rows: readonly AppointmentRow[],
): Promise<Map<string, AppointmentRequestRow>> => {
  const ids = [
    ...new Set(rows.map((row) => row.requestId).filter((id): id is string => id !== null)),
  ];
  if (ids.length === 0) return new Map();

  const requests = await db
    .select()
    .from(appointmentRequests)
    .where(inArray(appointmentRequests.id, ids));
  return new Map(requests.map((request) => [request.id, request]));
};

/** Citas que reprogramaron a partir de estas (para enlazar en ambos sentidos). */
const loadRescheduledChildren = async (
  db: SchedulingDb,
  rows: readonly AppointmentRow[],
): Promise<Map<string, string>> => {
  const ids = rows.map((row) => row.id);
  if (ids.length === 0) return new Map();

  const children = await db
    .select({ id: appointments.id, parentId: appointments.rescheduledFromId })
    .from(appointments)
    .where(inArray(appointments.rescheduledFromId, ids));

  const map = new Map<string, string>();
  for (const child of children) {
    if (child.parentId !== null && !map.has(child.parentId)) map.set(child.parentId, child.id);
  }
  return map;
};

const toSummaries = async (
  db: SchedulingDb,
  rows: readonly AppointmentRow[],
): Promise<AppointmentSummary[]> => {
  const [requests, children] = await Promise.all([
    loadRequests(db, rows),
    loadRescheduledChildren(db, rows),
  ]);
  return rows.map((row) =>
    toAppointmentSummary(row, {
      request: row.requestId === null ? null : (requests.get(row.requestId) ?? null),
      rescheduledToId: children.get(row.id) ?? null,
    }),
  );
};

export const getAppointment = async (db: SchedulingDb, id: string): Promise<AppointmentSummary> => {
  const row = await getAppointmentRow(db, id);
  const [summary] = await toSummaries(db, [row]);
  if (summary === undefined) throw new NotFoundError('La cita no existe');
  return summary;
};

export const listAppointments = async (
  db: SchedulingDb,
  filters: AppointmentFilters,
): Promise<Paginated<AppointmentSummary>> => {
  const conditions = [];
  if (filters.date !== undefined) conditions.push(eq(appointments.appointmentDate, filters.date));
  if (filters.from !== undefined)
    conditions.push(sql`${appointments.appointmentDate} >= ${filters.from}`);
  if (filters.to !== undefined)
    conditions.push(sql`${appointments.appointmentDate} <= ${filters.to}`);
  if (filters.status !== undefined) conditions.push(eq(appointments.status, filters.status));
  if (filters.patientId !== undefined) {
    conditions.push(eq(appointments.patientId, filters.patientId));
  }
  if (filters.search !== undefined && filters.search.trim() !== '') {
    const raw = filters.search.trim();
    const pattern = `%${raw.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
    const combined = or(
      sql`${appointments.patientName} ilike ${pattern} escape '\\'`,
      sql`coalesce(${appointments.patientDocument}, '') like ${`%${raw}%`}`,
    );
    if (combined !== undefined) conditions.push(combined);
  }

  const where = conditions.length === 0 ? undefined : and(...conditions);
  const offset = (filters.page - 1) * filters.pageSize;

  const [rows, totals] = await Promise.all([
    db
      .select()
      .from(appointments)
      .where(where)
      .orderBy(asc(appointments.appointmentDate), asc(appointments.startTime))
      .limit(filters.pageSize)
      .offset(offset),
    db.select({ value: count() }).from(appointments).where(where),
  ]);

  const total = totals[0]?.value ?? 0;
  return {
    items: await toSummaries(db, rows),
    total,
    page: filters.page,
    pageSize: filters.pageSize,
    totalPages: Math.max(1, Math.ceil(total / filters.pageSize)),
  };
};

export const getHistory = async (
  db: SchedulingDb,
  entityType: 'request' | 'appointment',
  entityId: string,
): Promise<StatusHistoryEntry[]> => {
  const rows = await db
    .select()
    .from(statusHistory)
    .where(and(eq(statusHistory.entityType, entityType), eq(statusHistory.entityId, entityId)))
    .orderBy(asc(statusHistory.occurredAt));
  return rows.map(toStatusHistoryEntry);
};

interface HistoryInput {
  entityType: 'request' | 'appointment';
  entityId: string;
  fromStatus: AppointmentStatus | null;
  toStatus: AppointmentStatus;
  reason?: string | null;
  actor: ActorContext;
}

const writeHistory = async (
  tx: Pick<SchedulingDb, 'insert'>,
  input: HistoryInput,
): Promise<void> => {
  await tx.insert(statusHistory).values({
    entityType: input.entityType,
    entityId: input.entityId,
    fromStatus: input.fromStatus,
    toStatus: input.toStatus,
    reason: input.reason ?? null,
    actorId: input.actor.actorId,
    actorUsername: input.actor.actorUsername,
  });
};

/** Duración de la cita: la que pida el usuario o la de la franja elegida. */
const durationFor = async (
  db: SchedulingDb,
  date: string,
  startTime: string,
  requested: number | undefined,
  config: Pick<SchedulingConfig, 'DEFAULT_APPOINTMENT_MINUTES'>,
): Promise<number> => {
  if (requested !== undefined) return requested;
  const slots = await slotsForDate(db, date);
  const match = slots.find((slot) => slot.startTime === startTime);
  return match === undefined
    ? config.DEFAULT_APPOINTMENT_MINUTES
    : Math.max(5, minutesBetween(match.startTime, match.endTime));
};

/** Estado del día por estado de cita (contadores de la jornada). */
export const countByStatus = async (
  db: SchedulingDb,
  date: string,
): Promise<Record<string, number>> => {
  const rows = await db
    .select({ status: appointments.status, value: sql<number>`count(1)::int` })
    .from(appointments)
    .where(eq(appointments.appointmentDate, date))
    .groupBy(appointments.status);

  return Object.fromEntries(rows.map((row) => [row.status, row.value]));
};

/** Citas de un día, en orden de hora. */
export const appointmentsOn = async (db: SchedulingDb, date: string): Promise<AppointmentRow[]> =>
  db
    .select()
    .from(appointments)
    .where(eq(appointments.appointmentDate, date))
    .orderBy(asc(appointments.startTime));

export const listDayAppointments = async (
  db: SchedulingDb,
  date: string,
): Promise<AppointmentSummary[]> => toSummaries(db, await appointmentsOn(db, date));

/** Última cita de cada solicitud (la que se muestra en la cola). */
export const latestAppointmentsByRequest = async (
  db: SchedulingDb,
  requestIds: readonly string[],
): Promise<Map<string, AppointmentRow>> => {
  if (requestIds.length === 0) return new Map();
  const rows = await db
    .select()
    .from(appointments)
    .where(and(inArray(appointments.requestId, [...requestIds]), isNotNull(appointments.requestId)))
    .orderBy(desc(appointments.createdAt));

  const map = new Map<string, AppointmentRow>();
  for (const row of rows) {
    if (row.requestId !== null && !map.has(row.requestId)) map.set(row.requestId, row);
  }
  return map;
};

/**
 * Convierte una solicitud (o una cita directa) en una cita del día.
 *
 * Comprueba, en este orden: que la solicitud siga en la cola, que la hora no esté
 * ocupada, que la hora pertenezca a la jornada (cuando es una franja) y que el día
 * tenga cupo. El sobrecupo exige el permiso `scheduling:overbook` y un motivo, y
 * queda auditado.
 */
export const assignAppointment = async (
  db: SchedulingDb,
  input: AssignAppointmentInput,
  actor: ActorContext,
  options: AssignOptions,
): Promise<AppointmentSummary> => {
  const { config } = options;

  const request = input.requestId === undefined ? null : await findRequest(db, input.requestId);
  if (input.requestId !== undefined && request === null) {
    throw new NotFoundError('La solicitud no existe');
  }

  if (request !== null) {
    if (request.status === 'cancelada') {
      throw new ConflictError('La solicitud está cancelada: crea una nueva para asignarle cita');
    }
    const existing = await db
      .select({
        id: appointments.id,
        date: appointments.appointmentDate,
        time: appointments.startTime,
      })
      .from(appointments)
      .where(
        and(
          eq(appointments.requestId, request.id),
          inArray(appointments.status, [...OCCUPYING_STATUSES]),
        ),
      )
      .limit(1);
    const already = existing[0];
    if (already !== undefined) {
      throw new ConflictError(
        `Esa solicitud ya tiene una cita el ${already.date} a las ${toHm(already.time)}`,
        { extensions: { appointmentId: already.id } },
      );
    }
  }

  const patientId = request?.patientId ?? input.patientId;
  const patientName = request?.patientName ?? input.patientName;
  if (patientId === undefined || patientName === undefined) {
    throw new AppError({
      status: 400,
      code: 'missing_patient',
      message: 'Indica la solicitud o el paciente de la cita',
    });
  }

  const startTime = toHm(input.startTime);
  const duration = await durationFor(db, input.date, startTime, input.durationMinutes, config);
  const endTime = addMinutes(startTime, duration);

  if (input.slotKind === 'franja') {
    const slots = await slotsForDate(db, input.date);
    const slot = slots.find((candidate) => candidate.startTime === startTime);
    if (slot === undefined) {
      throw new AppError({
        status: 400,
        code: 'slot_not_in_schedule',
        message: `Las ${startTime} no son una franja de la jornada de ese día. Elige una franja o usa la hora manual.`,
        extensions: { slots: slots.map((candidate) => candidate.startTime) },
      });
    }
    if (duration > minutesBetween(slot.startTime, slot.endTime)) {
      throw new AppError({
        status: 400,
        code: 'slot_too_short',
        message: `La franja de las ${startTime} dura ${String(minutesBetween(slot.startTime, slot.endTime))} minutos`,
      });
    }
  }

  const overlapping = await findOverlappingAppointment(db, {
    date: input.date,
    startTime,
    endTime,
  });
  if (overlapping !== null) {
    throw new ConflictError(
      `Esa hora ya está ocupada (${toHm(overlapping.startTime)}–${toHm(overlapping.endTime)})`,
      {
        extensions: {
          slot: { startTime: toHm(overlapping.startTime), endTime: toHm(overlapping.endTime) },
          takenByAppointmentId: overlapping.id,
        },
      },
    );
  }

  const { overbooked, info } = await assertCapacityAvailable(
    db,
    input.date,
    {
      authorizeOverbook: input.authorizeOverbook,
      overbookReason: input.overbookReason,
      canOverbook: hasPermission(actor.roles, 'scheduling:overbook'),
    },
    config,
  );

  const created = await db
    .transaction(async (tx) => {
      const inserted = await tx
        .insert(appointments)
        .values({
          requestId: request?.id ?? null,
          patientId,
          patientName,
          patientDocument: request?.patientDocument ?? input.patientDocument ?? null,
          patientPhone: request?.patientPhone ?? input.patientPhone ?? null,
          appointmentDate: input.date,
          startTime: asSeconds(startTime),
          endTime: asSeconds(endTime),
          durationMinutes: duration,
          slotKind: input.slotKind,
          status: 'programada',
          dentistId: input.dentistId ?? null,
          chairId: input.chairId ?? null,
          overbookAuthorized: overbooked,
          overbookReason: overbooked ? (input.overbookReason ?? null) : null,
          notes: input.notes ?? null,
          createdBy: actor.actorId,
        })
        .returning();

      const row = inserted[0];
      if (row === undefined) throw new NotFoundError('No se pudo crear la cita');

      await writeHistory(tx, {
        entityType: 'appointment',
        entityId: row.id,
        fromStatus: null,
        toStatus: 'programada',
        reason: overbooked ? `Sobrecupo autorizado: ${input.overbookReason ?? ''}`.trim() : null,
        actor,
      });

      if (request !== null) {
        await tx
          .update(appointmentRequests)
          .set({ status: 'programada', updatedAt: new Date() })
          .where(eq(appointmentRequests.id, request.id));
        await writeHistory(tx, {
          entityType: 'request',
          entityId: request.id,
          fromStatus: request.status as AppointmentStatus,
          toStatus: 'programada',
          reason: `Cita el ${input.date} a las ${startTime}`,
          actor,
        });
      }

      const message = buildAppointmentMessage(row, request, config);
      await publish(tx, {
        topic: EVENT_TOPICS.appointmentScheduled,
        aggregateId: row.id,
        actor,
        payload: {
          ...auditPayload({
            entityType: 'appointment',
            entityId: row.id,
            action: 'appointment_scheduled',
            summary: `Cita para ${row.patientName} el ${input.date} a las ${startTime}`,
            changedFields: ['appointmentDate', 'startTime', 'status'],
            before: null,
            after: {
              date: input.date,
              startTime,
              endTime,
              requestId: request?.id ?? null,
              ticket: message.ticket,
            },
            reason: overbooked ? (input.overbookReason ?? null) : null,
            actor,
          }),
          appointment: {
            id: row.id,
            date: input.date,
            startTime,
            endTime,
            status: 'programada',
            requestId: request?.id ?? null,
          },
          // El servicio de notificaciones (Fase 4) envía esto mismo al paciente.
          notification: message,
        },
      });

      if (overbooked) {
        await publish(tx, {
          topic: EVENT_TOPICS.overbookAuthorized,
          aggregateId: row.id,
          actor,
          payload: {
            ...auditPayload({
              entityType: 'appointment',
              entityId: row.id,
              action: 'appointment_overbook_authorized',
              summary: `Sobrecupo autorizado para ${row.patientName} el ${input.date} a las ${startTime}`,
              changedFields: ['overbookAuthorized'],
              before: { capacity: info.capacity, assigned: info.assigned },
              after: { capacity: info.capacity, assigned: info.assigned + 1 },
              reason: input.overbookReason ?? null,
              actor,
            }),
            appointmentId: row.id,
            date: input.date,
          },
        });
      }

      return row;
    })
    .catch((error: unknown) => {
      // Dos personas asignando la misma hora a la vez: decide el índice único.
      if (isUniqueViolation(error)) throw slotTaken(input.date, startTime);
      throw error;
    });

  return getAppointment(db, created.id);
};

const TRANSITION_TOPICS: Readonly<Partial<Record<AppointmentStatus, EventTopic>>> = {
  en_sala_espera: EVENT_TOPICS.appointmentCheckedIn,
  llamado: EVENT_TOPICS.appointmentCalled,
  en_consulta: EVENT_TOPICS.appointmentInConsultation,
  atendido: EVENT_TOPICS.appointmentAttended,
  no_asistio: EVENT_TOPICS.appointmentNoShow,
  cancelada: EVENT_TOPICS.appointmentCancelled,
};

const AUDIT_ACTIONS_BY_STATUS = {
  en_sala_espera: 'appointment_checked_in',
  llamado: 'appointment_called',
  en_consulta: 'appointment_in_consultation',
  atendido: 'appointment_attended',
  no_asistio: 'appointment_no_show',
  cancelada: 'appointment_cancelled',
} as const;

export interface TransitionOptions {
  reason?: string | undefined;
  /** Motivo del «atendido» cuando aún no hay sesión clínica (Fase 6). */
  forceReason?: string | undefined;
  clinicalSessionId?: string | undefined;
  /** Comprueba la sesión contra el servicio clínico (Fase 7). */
  sessionLookup?: ClinicalSessionLookup | undefined;
  config: SchedulingConfig;
  now?: Date;
}

/**
 * Resuelve la sesión clínica que respalda un «atendido».
 *
 * El identificador puede venir del cliente (la secretaría acaba de cerrar la
 * sesión) o estar ya guardado en la cita, pero en los dos casos se **verifica
 * contra el servicio clínico**: que exista, que sea del mismo paciente y que esté
 * cerrada. Antes bastaba con mandar un identificador cualquiera para saltarse el
 * motivo obligatorio.
 */
const verificarSesionCerrada = async (
  current: AppointmentRow,
  sessionId: string,
  options: TransitionOptions,
): Promise<string> => {
  const session = await options.sessionLookup?.(sessionId);
  if (session === null || session === undefined) {
    throw new AppError({
      status: 409,
      code: 'clinical_session_unverified',
      message:
        'No se pudo comprobar la sesión clínica: ciérrala antes de marcar «atendido» o indica el motivo.',
      extensions: { clinicalSessionId: sessionId },
    });
  }
  if (session.patientId !== current.patientId) {
    throw new AppError({
      status: 409,
      code: 'clinical_session_patient_mismatch',
      message: 'La sesión clínica es de otro paciente: no puede respaldar esta cita',
      extensions: { clinicalSessionId: sessionId },
    });
  }
  if (session.status !== 'cerrada') {
    throw new AppError({
      status: 409,
      code: 'clinical_session_open',
      message: 'La sesión clínica todavía está en borrador: ciérrala antes de marcar «atendido».',
      extensions: { clinicalSessionId: sessionId },
    });
  }
  return session.sessionId;
};

/**
 * Cambia el estado de una cita aplicando la máquina de estados del contrato.
 *
 * Además de validar la transición, deja rastro en `status_history` y publica el
 * evento correspondiente. Dos reglas duras del plan: la inasistencia solo se puede
 * marcar pasado el tiempo de tolerancia, y el «atendido» exige la **sesión clínica
 * cerrada** (Fase 7); sin ella, un motivo que va a la auditoría.
 */
export const transitionAppointment = async (
  db: SchedulingDb,
  id: string,
  to: AppointmentStatus,
  actor: ActorContext,
  options: TransitionOptions,
): Promise<AppointmentSummary> => {
  const current = await getAppointmentRow(db, id);
  const from = current.status as AppointmentStatus;
  assertCanTransition(from, to, actor);

  const now = options.now ?? new Date();
  const patch: Partial<typeof appointments.$inferInsert> = { status: to, updatedAt: now };

  if (to === 'en_sala_espera') patch.checkedInAt = now;
  if (to === 'llamado') patch.callCount = current.callCount + 1;
  if (to === 'en_consulta') patch.startedAt = now;

  if (to === 'atendido') {
    const sessionId = options.clinicalSessionId ?? current.clinicalSessionId ?? null;
    if (sessionId === null) {
      if ((options.forceReason ?? '').length < 3) {
        throw new AppError({
          status: 400,
          code: 'clinical_session_required',
          message:
            'Para marcar «atendido» hace falta la sesión clínica cerrada. Si no la hay, indica el motivo.',
        });
      }
      patch.forceAttendedReason = options.forceReason ?? null;
      patch.clinicalSessionId = null;
    } else {
      patch.clinicalSessionId = await verificarSesionCerrada(current, sessionId, options);
      // Con la sesión cerrada que lo respalda, el motivo forzado sobra.
      patch.forceAttendedReason = null;
    }
    patch.finishedAt = now;
  }

  if (to === 'no_asistio') {
    const grace = options.config.NO_SHOW_GRACE_MINUTES;
    const appointmentAt = toClinicInstant(current.appointmentDate, current.startTime);
    const limit = new Date(appointmentAt.getTime() + grace * 60_000);
    if (now.getTime() < limit.getTime()) {
      const missing = Math.ceil((limit.getTime() - now.getTime()) / 60_000);
      throw new AppError({
        status: 400,
        code: 'no_show_too_early',
        message: `Todavía no: la cita es a las ${toHm(current.startTime)} y hay ${String(grace)} minutos de tolerancia (faltan ${String(missing)}).`,
        extensions: { appointmentAt: appointmentAt.toISOString(), graceMinutes: grace },
      });
    }
    patch.noShowReason = options.reason ?? null;
  }

  const request = current.requestId === null ? null : await findRequest(db, current.requestId);

  await db.transaction(async (tx) => {
    await tx.update(appointments).set(patch).where(eq(appointments.id, id));

    await writeHistory(tx, {
      entityType: 'appointment',
      entityId: id,
      fromStatus: from,
      toStatus: to,
      reason: options.reason ?? options.forceReason ?? null,
      actor,
    });

    // Cancelar la cita devuelve el ticket a la cola: el paciente sigue esperando.
    if (to === 'cancelada' && request !== null) {
      await tx
        .update(appointmentRequests)
        .set({ status: 'en_espera_cita', updatedAt: new Date() })
        .where(eq(appointmentRequests.id, request.id));
      await writeHistory(tx, {
        entityType: 'request',
        entityId: request.id,
        fromStatus: request.status as AppointmentStatus,
        toStatus: 'en_espera_cita',
        reason: options.reason ?? 'la cita se canceló y el paciente vuelve a la cola',
        actor,
      });
    }

    const topic = TRANSITION_TOPICS[to];
    if (topic !== undefined) {
      await publish(tx, {
        topic,
        aggregateId: id,
        actor,
        payload: {
          ...auditPayload({
            entityType: 'appointment',
            entityId: id,
            action: AUDIT_ACTIONS_BY_STATUS[to as keyof typeof AUDIT_ACTIONS_BY_STATUS],
            summary: `${current.patientName}: ${from} → ${to}`,
            changedFields: ['status'],
            before: { status: from },
            after:
              to === 'atendido'
                ? {
                    status: to,
                    clinicalSessionId: patch.clinicalSessionId ?? null,
                    forceAttendedReason: patch.forceAttendedReason ?? null,
                  }
                : { status: to },
            reason: options.reason ?? options.forceReason ?? null,
            actor,
          }),
          appointment: {
            id,
            date: current.appointmentDate,
            startTime: toHm(current.startTime),
            endTime: toHm(current.endTime),
            status: to,
            requestId: current.requestId,
          },
          notification: buildAppointmentMessage(current, request, options.config),
        },
      });
    }
  });

  return getAppointment(db, id);
};

/**
 * Reprograma una cita: la original queda como `reprogramada` (con su ticket
 * trazado) y se crea una **cita nueva enlazada** por `rescheduled_from_id`, con la
 * secuencia `.ics` incrementada para que los calendarios se actualicen.
 */
export const rescheduleAppointment = async (
  db: SchedulingDb,
  id: string,
  input: RescheduleAppointmentInput,
  actor: ActorContext,
  options: AssignOptions,
): Promise<AppointmentSummary> => {
  const { config } = options;
  const current = await getAppointmentRow(db, id);
  const from = current.status as AppointmentStatus;
  assertCanTransition(from, 'reprogramada', actor);

  const startTime = toHm(input.startTime);
  const duration = await durationFor(db, input.date, startTime, input.durationMinutes, config);
  const endTime = addMinutes(startTime, duration);

  const overlapping = await findOverlappingAppointment(db, {
    date: input.date,
    startTime,
    endTime,
    ignoreAppointmentId: id,
  });
  if (overlapping !== null) {
    throw new ConflictError(
      `Esa hora ya está ocupada (${toHm(overlapping.startTime)}–${toHm(overlapping.endTime)})`,
      {
        extensions: {
          slot: { startTime: toHm(overlapping.startTime), endTime: toHm(overlapping.endTime) },
          takenByAppointmentId: overlapping.id,
        },
      },
    );
  }

  const { overbooked } = await assertCapacityAvailable(
    db,
    input.date,
    {
      authorizeOverbook: input.authorizeOverbook,
      overbookReason: input.overbookReason,
      canOverbook: hasPermission(actor.roles, 'scheduling:overbook'),
    },
    config,
  );

  const request = current.requestId === null ? null : await findRequest(db, current.requestId);

  const created = await db
    .transaction(async (tx) => {
      await tx
        .update(appointments)
        .set({ status: 'reprogramada', updatedAt: new Date() })
        .where(eq(appointments.id, id));
      await writeHistory(tx, {
        entityType: 'appointment',
        entityId: id,
        fromStatus: from,
        toStatus: 'reprogramada',
        reason: input.reason ?? `se movió al ${input.date} a las ${startTime}`,
        actor,
      });

      const inserted = await tx
        .insert(appointments)
        .values({
          requestId: current.requestId,
          patientId: current.patientId,
          patientName: current.patientName,
          patientDocument: current.patientDocument,
          patientPhone: current.patientPhone,
          appointmentDate: input.date,
          startTime: asSeconds(startTime),
          endTime: asSeconds(endTime),
          durationMinutes: duration,
          slotKind: input.slotKind,
          status: 'programada',
          dentistId: current.dentistId,
          chairId: current.chairId,
          overbookAuthorized: overbooked,
          overbookReason: overbooked ? (input.overbookReason ?? null) : null,
          rescheduledFromId: current.id,
          icsSequence: current.icsSequence + 1,
          notes: current.notes,
          createdBy: actor.actorId,
        })
        .returning();

      const row = inserted[0];
      if (row === undefined) throw new NotFoundError('No se pudo reprogramar la cita');

      await writeHistory(tx, {
        entityType: 'appointment',
        entityId: row.id,
        fromStatus: null,
        toStatus: 'programada',
        reason: `reprogramada desde el ${current.appointmentDate} ${toHm(current.startTime)}`,
        actor,
      });

      await publish(tx, {
        topic: EVENT_TOPICS.appointmentRescheduled,
        aggregateId: row.id,
        actor,
        payload: {
          ...auditPayload({
            entityType: 'appointment',
            entityId: row.id,
            action: 'appointment_rescheduled',
            summary: `${current.patientName}: del ${current.appointmentDate} ${toHm(current.startTime)} al ${input.date} ${startTime}`,
            changedFields: ['appointmentDate', 'startTime'],
            before: { date: current.appointmentDate, startTime: toHm(current.startTime) },
            after: { date: input.date, startTime },
            reason: input.reason ?? null,
            actor,
          }),
          appointment: {
            id: row.id,
            date: input.date,
            startTime,
            endTime,
            status: 'programada',
            requestId: row.requestId,
            rescheduledFromId: current.id,
          },
          previousAppointmentId: current.id,
          notification: buildAppointmentMessage(row, request, config),
        },
      });

      return row;
    })
    .catch((error: unknown) => {
      if (isUniqueViolation(error)) throw slotTaken(input.date, startTime);
      throw error;
    });

  return getAppointment(db, created.id);
};
