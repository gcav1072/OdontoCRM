import {
  addMinutes,
  CANCELLABLE_STATUSES,
  hasPermission,
  minutesBetween,
  type AppointmentActivityFilters,
  type AppointmentActivityItem,
  type AppointmentCancellationFilters,
  type AppointmentFilters,
  type AppointmentStatus,
  type AppointmentSummary,
  type AssignAppointmentInput,
  type Channel,
  type Paginated,
  type RescheduleAppointmentInput,
  type StatusHistoryEntry,
} from '@odontocrm/contracts';
import { EVENT_TOPICS, type EventTopic } from '@odontocrm/events';
import { AppError, ConflictError, NotFoundError } from '@odontocrm/kernel';
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';

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
import { activeChairOrThrow, chairLabelById } from '../agenda/chair-service.js';
import { buildAppointmentMessage } from '../agenda/message.js';
import { assertCanTransition, toClinicInstant, type ActorContext } from '../shared/context.js';
import type { ClinicalSessionLookup } from '../shared/clinical-client.js';
import type { DentistCatalog } from '../shared/identity-client.js';
import { auditPayload, publish } from '../shared/events.js';

export interface AssignOptions {
  config: SchedulingConfig;
  /** Catálogo de odontólogos para rotular el evento (`dentistId → nombre`). */
  dentistCatalog?: DentistCatalog;
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

const slotTaken = (date: string, startTime: string, chairLabel?: string | null): ConflictError =>
  new ConflictError(
    chairLabel === undefined || chairLabel === null
      ? `Alguien acaba de ocupar las ${startTime} del ${date}. Elige otra franja.`
      : `Alguien acaba de ocupar las ${startTime} en ${chairLabel}. Elige otro consultorio o otra franja.`,
    { extensions: { slot: { startTime } } },
  );

/**
 * Bloque `appointment` de los eventos enriquecido con el consultorio y el odontólogo
 * ([ADR 0041](../../../docs/adr/0041-el-evento-lleva-lo-que-el-consumidor-necesita.md)):
 * las pantallas y los reportes lo consumen sin leer bases ajenas. `chairLabel` y
 * `dentistName` van resueltos (o `null`) para que el consumidor solo pinte.
 */
const appointmentBlock = async (
  db: SchedulingDb,
  row: {
    id: string;
    appointmentDate: string;
    startTime: string;
    endTime: string;
    status: string;
    requestId: string | null;
    chairId: string;
    dentistId: string | null;
  },
  dentistCatalog?: DentistCatalog,
): Promise<{
  id: string;
  date: string;
  startTime: string;
  endTime: string;
  status: string;
  requestId: string | null;
  chairId: string;
  chairLabel: string | null;
  dentistId: string | null;
  dentistName: string | null;
}> => {
  const [chairLabel, dentistNames] = await Promise.all([
    chairLabelById(db, row.chairId),
    dentistCatalog === undefined ? Promise.resolve(new Map<string, string>()) : dentistCatalog(),
  ]);

  return {
    id: row.id,
    date: row.appointmentDate,
    startTime: toHm(row.startTime),
    endTime: toHm(row.endTime),
    status: row.status,
    requestId: row.requestId,
    chairId: row.chairId,
    chairLabel,
    dentistId: row.dentistId,
    dentistName: row.dentistId === null ? null : (dentistNames.get(row.dentistId) ?? null),
  };
};

/** Cita que ocupa la misma hora en **ese consultorio** (dos sillones pueden coincidir). */
export const findOverlappingAppointment = async (
  db: SchedulingDb,
  input: {
    date: string;
    startTime: string;
    endTime: string;
    chairId: string;
    ignoreAppointmentId?: string;
  },
): Promise<AppointmentRow | null> => {
  const conditions = [
    eq(appointments.appointmentDate, input.date),
    eq(appointments.chairId, input.chairId),
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

/**
 * Etiquetas resueltas que la jornada y las listas inyectan en el resumen de la cita:
 * el consultorio (que ya se conoce por la propia jornada) y el odontólogo (que llega
 * del catálogo de identity). Fuera de la jornada van vacías y los campos salen `null`.
 */
export interface SummaryLabels {
  chairLabels?: ReadonlyMap<string, string>;
  dentistNames?: ReadonlyMap<string, string>;
}

export const toSummaries = async (
  db: SchedulingDb,
  rows: readonly AppointmentRow[],
  labels: SummaryLabels = {},
): Promise<AppointmentSummary[]> => {
  const [requests, children] = await Promise.all([
    loadRequests(db, rows),
    loadRescheduledChildren(db, rows),
  ]);
  return rows.map((row) =>
    toAppointmentSummary(row, {
      request: row.requestId === null ? null : (requests.get(row.requestId) ?? null),
      rescheduledToId: children.get(row.id) ?? null,
      chairLabel: labels.chairLabels?.get(row.chairId) ?? null,
      dentistName:
        row.dentistId === null ? null : (labels.dentistNames?.get(row.dentistId) ?? null),
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
  if (filters.confirmed !== undefined) {
    conditions.push(
      filters.confirmed ? isNotNull(appointments.confirmedAt) : isNull(appointments.confirmedAt),
    );
  }
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
  chairId: string,
): Promise<number> => {
  if (requested !== undefined) return requested;
  const slots = await slotsForDate(db, date, chairId);
  const match = slots.find((slot) => slot.startTime === startTime);
  return match === undefined
    ? config.DEFAULT_APPOINTMENT_MINUTES
    : Math.max(5, minutesBetween(match.startTime, match.endTime));
};

/** Estado del día por estado de cita (contadores de la jornada); con `chairId`, de un consultorio. */
export const countByStatus = async (
  db: SchedulingDb,
  date: string,
  chairId?: string,
): Promise<Record<string, number>> => {
  const condiciones = [eq(appointments.appointmentDate, date)];
  if (chairId !== undefined) condiciones.push(eq(appointments.chairId, chairId));

  const rows = await db
    .select({ status: appointments.status, value: sql<number>`count(1)::int` })
    .from(appointments)
    .where(and(...condiciones))
    .groupBy(appointments.status);

  return Object.fromEntries(rows.map((row) => [row.status, row.value]));
};

/** Citas de un día, en orden de hora; con `chairId`, solo las de ese consultorio. */
export const appointmentsOn = async (
  db: SchedulingDb,
  date: string,
  chairId?: string,
): Promise<AppointmentRow[]> => {
  const condiciones = [eq(appointments.appointmentDate, date)];
  if (chairId !== undefined) condiciones.push(eq(appointments.chairId, chairId));

  return db
    .select()
    .from(appointments)
    .where(and(...condiciones))
    .orderBy(asc(appointments.startTime));
};

export const listDayAppointments = async (
  db: SchedulingDb,
  date: string,
  chairId?: string,
  labels: SummaryLabels = {},
): Promise<AppointmentSummary[]> =>
  toSummaries(db, await appointmentsOn(db, date, chairId), labels);

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

  // El consultorio es el recurso que ocupa la franja: tiene que existir y estar activo.
  const chair = await activeChairOrThrow(db, input.chairId);

  const startTime = toHm(input.startTime);
  const duration = await durationFor(
    db,
    input.date,
    startTime,
    input.durationMinutes,
    config,
    input.chairId,
  );
  const endTime = addMinutes(startTime, duration);

  if (input.slotKind === 'franja') {
    const slots = await slotsForDate(db, input.date, input.chairId);
    const slot = slots.find((candidate) => candidate.startTime === startTime);
    if (slot === undefined) {
      throw new AppError({
        status: 400,
        code: 'slot_not_in_schedule',
        message: `Las ${startTime} no son una franja de la jornada de ${chair.label} ese día. Elige una franja o usa la hora manual.`,
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
    chairId: input.chairId,
  });
  if (overlapping !== null) {
    throw new ConflictError(
      `Esa hora ya está ocupada en ${chair.label} (${toHm(overlapping.startTime)}–${toHm(overlapping.endTime)})`,
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
    input.chairId,
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
          chairId: input.chairId,
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
          appointment: await appointmentBlock(db, row, options.dentistCatalog),
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
      // Dos personas asignando la misma hora en el mismo consultorio: decide el índice único.
      if (isUniqueViolation(error)) throw slotTaken(input.date, startTime, chair.label);
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
  /**
   * Por dónde se canceló, cuando lo sabe quien cancela (el bot, ADR 0053). La
   * secretaría no lo manda: así una cancelación del personal **no** se atribuye a un
   * canal de paciente.
   */
  channel?: Channel | undefined;
  /**
   * Salta la comprobación de la máquina de estados por rol. Lo usa el bot, cuyo actor
   * de sistema va **sin roles** y cuya guardia de estado la pone `cancelAppointment`.
   * La ruta pública de la agenda **no** lo activa.
   */
  skipTransitionCheck?: boolean | undefined;
  /**
   * No avisar al paciente por la cola: el asistente ya le responde en el mismo turno
   * (ADR 0053). El bloque `notification` del evento se conserva —lo leen pacientes,
   * pantallas y reportes—, pero se marca con `skipNotice` para que el servicio de
   * notificaciones **no** encole un `cita_cancelada` duplicado.
   */
  skipNotice?: boolean | undefined;
  /** Catálogo de odontólogos para rotular el evento (`dentistId → nombre`). */
  dentistCatalog?: DentistCatalog | undefined;
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
  // El bot cancela con un actor de sistema **sin roles** (ADR 0053): ahí la máquina de
  // estados por rol no tiene nada que comprobar y la guardia de estado la pone
  // `cancelAppointment`. La ruta pública de la agenda sigue pasando por aquí.
  if (options.skipTransitionCheck !== true) assertCanTransition(from, to, actor);

  const now = options.now ?? new Date();
  const patch: Partial<typeof appointments.$inferInsert> = { status: to, updatedAt: now };

  if (to === 'en_sala_espera') patch.checkedInAt = now;
  if (to === 'llamado') patch.callCount = current.callCount + 1;
  if (to === 'en_consulta') patch.startedAt = now;

  if (to === 'cancelada') {
    patch.cancelledAt = now;
    // Solo hay canal cuando lo dice quien cancela (el bot). Una cancelación de la
    // secretaría queda sin canal: no se puede atribuir «a un paciente».
    if (options.channel !== undefined) patch.cancelledChannel = options.channel;
  }

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

    // Cancelar la cita devuelve el ticket a la cola: el paciente sigue esperando. Solo
    // si **no le queda otra cita en pie**: una solicitud reprogramada puede tener ya la
    // cita nueva, y devolverla a «en espera» la sacaría de la agenda por error.
    if (to === 'cancelada' && request !== null) {
      const otras = await tx
        .select({ id: appointments.id })
        .from(appointments)
        .where(
          and(
            eq(appointments.requestId, request.id),
            inArray(appointments.status, [...OCCUPYING_STATUSES]),
            sql`${appointments.id} <> ${id}`,
          ),
        )
        .limit(1);

      if (otras.length === 0) {
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
                : to === 'cancelada'
                  ? { status: to, cancelledChannel: patch.cancelledChannel ?? null }
                  : { status: to },
            reason: options.reason ?? options.forceReason ?? null,
            actor,
          }),
          appointment: await appointmentBlock(db, current, options.dentistCatalog),
          notification: buildAppointmentMessage(current, request, options.config),
          // La cancelación del bot no debe disparar el aviso `cita_cancelada` de la
          // cola: el asistente ya responde al paciente en el mismo turno (ADR 0053). El
          // bloque `notification` se conserva intacto porque lo leen otros consumidores
          // (pacientes, pantallas y reportes); lo que se marca es el aviso.
          ...(options.skipNotice === true ? { skipNotice: true } : {}),
        },
      });
    }
  });

  return getAppointment(db, id);
};

/* ── Confirmación del paciente (ADR 0052) ──────────────────────────────────── */

/**
 * Estados desde los que se espera una confirmación: los dos en los que la cita está
 * en pie y el paciente todavía no ha respondido. `en_sala_espera` y siguientes ya no
 * la esperan —el paciente está ahí—, y los terminales tampoco.
 */
const CONFIRMABLE_STATUSES: readonly AppointmentStatus[] = ['programada', 'notificada'];

/** Cómo se nombra cada canal en el rastro de la auditoría y del historial. */
const CONFIRM_CHANNEL_LABEL: Readonly<Record<string, string>> = {
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
  telefono: 'teléfono',
  presencial: 'el mostrador',
  registro: 'el registro',
};

const channelLabel = (channel: string): string => CONFIRM_CHANNEL_LABEL[channel] ?? channel;

export interface ConfirmOptions {
  /** Por dónde confirmó el paciente: `telegram`/`whatsapp` por el bot, `telefono` por la secretaría. */
  channel: Channel;
  note?: string | null;
  /** Catálogo de odontólogos para rotular el evento (`dentistId → nombre`). */
  dentistCatalog?: DentistCatalog | undefined;
  now?: Date;
}

/**
 * Deja constancia de que el paciente **confirmó** su asistencia (ADR 0052).
 *
 * No es una transición cualquiera: las de `transitionAppointment` mueven el flujo del
 * día y las pide el personal; esta la puede disparar **el propio paciente** desde el
 * bot, y por eso el actor de sistema va **sin roles**. La comprobación se reparte así:
 *
 *  - el **estado** tiene que ser confirmable siempre (`programada` o `notificada`): una
 *    cita ya atendida o cancelada no se confirma;
 *  - la **máquina de estados** solo se consulta cuando el actor trae roles (la
 *    secretaría confirmando por teléfono). Con el bot, `systemActor` va con `roles: []`
 *    y `assertCanTransition` no tendría nada que comprobar.
 *
 * Es **idempotente**: si ya estaba confirmada se devuelve tal cual, sin escribir
 * historial ni mover la fecha de la confirmación. El paciente que pulsa dos veces, o
 * cuyo botón se reenvía, no ensucia el rastro.
 */
export const confirmAppointment = async (
  db: SchedulingDb,
  id: string,
  options: ConfirmOptions,
  actor: ActorContext,
): Promise<AppointmentSummary> => {
  const current = await getAppointmentRow(db, id);
  const from = current.status as AppointmentStatus;

  if (from === 'confirmada') return getAppointment(db, id);

  if (!CONFIRMABLE_STATUSES.includes(from)) {
    throw new ConflictError(
      `No se puede confirmar una cita en «${from}»: solo se confirman las que están programadas o notificadas.`,
      { extensions: { status: from } },
    );
  }
  if (actor.roles.length > 0) assertCanTransition(from, 'confirmada', actor);

  const now = options.now ?? new Date();
  const note = (options.note ?? '').trim();
  const reason =
    note.length > 0
      ? `confirmó por ${channelLabel(options.channel)}: ${note}`
      : `confirmó por ${channelLabel(options.channel)}`;

  await db.transaction(async (tx) => {
    await tx
      .update(appointments)
      .set({
        status: 'confirmada',
        confirmedAt: now,
        confirmedChannel: options.channel,
        updatedAt: now,
      })
      .where(eq(appointments.id, id));

    await writeHistory(tx, {
      entityType: 'appointment',
      entityId: id,
      fromStatus: from,
      toStatus: 'confirmada',
      // El historial guarda **quién confirmó y por dónde**: es lo que se consulta
      // cuando alguien pregunta «¿y esto quién lo confirmó?».
      reason,
      actor,
    });

    await publish(tx, {
      topic: EVENT_TOPICS.appointmentConfirmed,
      aggregateId: id,
      actor,
      payload: {
        ...auditPayload({
          entityType: 'appointment',
          entityId: id,
          action: 'appointment_confirmed',
          summary: `${current.patientName}: confirmó su cita del ${current.appointmentDate} a las ${toHm(current.startTime)} por ${channelLabel(options.channel)}`,
          changedFields: ['status', 'confirmedAt', 'confirmedChannel'],
          before: { status: from },
          after: {
            status: 'confirmada',
            confirmedAt: now.toISOString(),
            confirmedChannel: options.channel,
          },
          reason,
          actor,
        }),
        appointment: {
          ...(await appointmentBlock(db, current, options.dentistCatalog)),
          status: 'confirmada',
        },
        /**
         * **A propósito** no va el bloque `notification`: confirmar es la respuesta
         * del paciente, no un aviso hacia él. Si lo llevara, el servicio de
         * notificaciones mandaría un mensaje por cada confirmación.
         */
      },
    });
  });

  return getAppointment(db, id);
};

/* ── Cancelación a petición del paciente (ADR 0053) ─────────────────────────── */

export interface CancelByPatientOptions {
  /** Por dónde canceló el paciente (`telegram`/`whatsapp`). */
  channel: Channel;
  reason?: string | null | undefined;
  /** Catálogo de odontólogos para rotular el evento (`dentistId → nombre`). */
  dentistCatalog?: DentistCatalog | undefined;
  config: SchedulingConfig;
  now?: Date;
}

/**
 * Cancela la cita **a petición del paciente** desde el bot (ADR 0053).
 *
 * Es la mitad de escritura de la cancelación conversacional, hermana de
 * `confirmAppointment`: el actor es de sistema y va **sin roles**, así que se salta la
 * máquina de estados por rol (`skipTransitionCheck`) y en su lugar aplica su **propia
 * guardia de estado** (`CANCELLABLE_STATUSES`, del contrato). Delega en
 * `transitionAppointment`, que ya sabe liberar la franja y devolver el ticket a la
 * cola —si no le queda otra cita—.
 *
 * Es **idempotente**: si la cita ya está cancelada se devuelve tal cual, sin escribir
 * historial ni mover la fecha de cancelación. Dos pulsaciones del botón, o un `update`
 * reenviado por Telegram, no ensucian el rastro.
 */
export const cancelAppointment = async (
  db: SchedulingDb,
  id: string,
  options: CancelByPatientOptions,
  actor: ActorContext,
): Promise<AppointmentSummary> => {
  const current = await getAppointmentRow(db, id);
  const from = current.status as AppointmentStatus;

  if (from === 'cancelada') return getAppointment(db, id);

  if (!CANCELLABLE_STATUSES.includes(from)) {
    throw new ConflictError(
      `El paciente ya no puede cancelar una cita en «${from}»: solo las programadas, notificadas o confirmadas.`,
      { extensions: { status: from } },
    );
  }

  return transitionAppointment(db, id, 'cancelada', actor, {
    config: options.config,
    ...(options.dentistCatalog === undefined ? {} : { dentistCatalog: options.dentistCatalog }),
    reason: options.reason ?? `el paciente canceló por ${channelLabel(options.channel)}`,
    channel: options.channel,
    skipTransitionCheck: true,
    skipNotice: true,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
};

/** Canales por los que cancela el **paciente** (el bot). La secretaría no entra. */
const PATIENT_CHANNELS: readonly string[] = ['telegram', 'whatsapp'];

/**
 * Cancelaciones hechas por el **paciente** (ADR 0053): es lo que pinta la tarjeta de
 * `/programacion`. Solo cuenta lo cancelado por un canal de paciente —las que cancela
 * la secretaría ya son conocimiento del consultorio— y se ordena por la más reciente.
 *
 * El rango del filtro va sobre `cancelled_at`, que es un **instante**: los cortes se
 * calculan en el calendario del consultorio (Caracas, UTC−4) para que «hoy» sea el día
 * del consultorio y no el de UTC.
 */
export const listPatientCancellations = async (
  db: SchedulingDb,
  filters: AppointmentCancellationFilters,
): Promise<Paginated<AppointmentSummary>> => {
  const conditions: SQL[] = [
    eq(appointments.status, 'cancelada'),
    inArray(appointments.cancelledChannel, [...PATIENT_CHANNELS]),
    isNotNull(appointments.cancelledAt),
  ];

  if (filters.from !== undefined) {
    conditions.push(gte(appointments.cancelledAt, toClinicInstant(filters.from, '00:00')));
  }
  if (filters.to !== undefined) {
    // `< (to + 1 día)`: el día final entra entero.
    const hasta = new Date(toClinicInstant(filters.to, '00:00').getTime() + 86_400_000);
    conditions.push(sql`${appointments.cancelledAt} < ${hasta}`);
  }

  const where = and(...conditions);
  const offset = (filters.page - 1) * filters.pageSize;

  const [rows, totals] = await Promise.all([
    db
      .select()
      .from(appointments)
      .where(where)
      .orderBy(desc(appointments.cancelledAt))
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

/**
 * **Novedades de citas** (feed de `/inicio`, ADR 0057): lo que hicieron los pacientes
 * con sus citas por el bot, de lo más reciente a lo más viejo.
 *
 * La fuente es `status_history` —cada confirmación y cada cancelación queda ahí con su
 * hora— y el comportamiento se clasifica con la **fecha de confirmación** de la cita:
 * cancelar una cita que estaba confirmada es «se arrepintió», y cancelar una que no lo
 * estaba es «canceló sin confirmar». Todo se filtra al **canal de paciente**
 * (`telegram`/`whatsapp`): lo que hizo la secretaría no es una novedad que el paciente
 * haya generado, y las confirmaciones por teléfono tampoco cuentan como del bot.
 */
export const listAppointmentActivity = async (
  db: SchedulingDb,
  filters: AppointmentActivityFilters,
): Promise<AppointmentActivityItem[]> => {
  const filas = await db
    .select({
      id: statusHistory.id,
      appointmentId: statusHistory.entityId,
      toStatus: statusHistory.toStatus,
      occurredAt: statusHistory.occurredAt,
      patientId: appointments.patientId,
      patientName: appointments.patientName,
      patientDocument: appointments.patientDocument,
      date: appointments.appointmentDate,
      startTime: appointments.startTime,
      endTime: appointments.endTime,
      confirmedAt: appointments.confirmedAt,
      confirmedChannel: appointments.confirmedChannel,
      cancelledChannel: appointments.cancelledChannel,
    })
    .from(statusHistory)
    .innerJoin(appointments, eq(appointments.id, statusHistory.entityId))
    .where(
      and(
        eq(statusHistory.entityType, 'appointment'),
        // El **canal** dice si fue el paciente: confirmar desde el bot y cancelar desde
        // el bot son los dos hechos que se cuentan; el resto (mostrador, teléfono) no.
        or(
          and(
            eq(statusHistory.toStatus, 'confirmada'),
            inArray(appointments.confirmedChannel, [...PATIENT_CHANNELS]),
          ),
          and(
            eq(statusHistory.toStatus, 'cancelada'),
            inArray(appointments.cancelledChannel, [...PATIENT_CHANNELS]),
          ),
        ),
      ),
    )
    .orderBy(desc(statusHistory.occurredAt))
    .limit(filters.limit);

  return filas.map((fila) => {
    const esConfirmacion = fila.toStatus === 'confirmada';
    // Canceló después de haber confirmado: el caso «dio cita, aceptó y se arrepintió».
    const kind = esConfirmacion
      ? 'confirmada'
      : fila.confirmedAt === null
        ? 'cancelada'
        : 'confirmada_y_cancelada';
    const channel = (esConfirmacion ? fila.confirmedChannel : fila.cancelledChannel) ?? 'telegram';
    return {
      id: fila.id,
      appointmentId: fila.appointmentId,
      kind,
      patientId: fila.patientId,
      patientName: fila.patientName,
      patientDocument: fila.patientDocument,
      date: fila.date,
      startTime: toHm(fila.startTime),
      endTime: toHm(fila.endTime),
      channel: channel as Channel,
      occurredAt: fila.occurredAt.toISOString(),
    };
  });
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

  // Se puede cambiar de consultorio al mover la cita; si no se indica, se conserva.
  const chairId = input.chairId ?? current.chairId;
  const chair = await activeChairOrThrow(db, chairId);

  const startTime = toHm(input.startTime);
  const duration = await durationFor(
    db,
    input.date,
    startTime,
    input.durationMinutes,
    config,
    chairId,
  );
  const endTime = addMinutes(startTime, duration);

  const overlapping = await findOverlappingAppointment(db, {
    date: input.date,
    startTime,
    endTime,
    chairId,
    ignoreAppointmentId: id,
  });
  if (overlapping !== null) {
    throw new ConflictError(
      `Esa hora ya está ocupada en ${chair.label} (${toHm(overlapping.startTime)}–${toHm(overlapping.endTime)})`,
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
    chairId,
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
          chairId,
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
            ...(await appointmentBlock(db, row, options.dentistCatalog)),
            rescheduledFromId: current.id,
          },
          previousAppointmentId: current.id,
          notification: buildAppointmentMessage(row, request, config),
        },
      });

      return row;
    })
    .catch((error: unknown) => {
      if (isUniqueViolation(error)) throw slotTaken(input.date, startTime, chair.label);
      throw error;
    });

  return getAppointment(db, created.id);
};
