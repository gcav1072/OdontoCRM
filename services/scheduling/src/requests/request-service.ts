import {
  parseTicket,
  type CreateRequestInput,
  type Paginated,
  type RequestFilters,
  type RequestSummary,
} from '@odontocrm/contracts';
import { EVENT_TOPICS } from '@odontocrm/events';
import { ConflictError, NotFoundError } from '@odontocrm/kernel';
import { and, asc, count, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';

import type { SchedulingDb } from '../db/client.js';
import { appointmentRequests, statusHistory, type AppointmentRequestRow } from '../db/schema.js';
import { toRequestSummary } from '../mappers.js';
import { latestAppointmentsByRequest } from '../appointments/appointment-service.js';
import type { ActorContext } from '../shared/context.js';
import { auditPayload, publish } from '../shared/events.js';

const toSummaries = async (
  db: SchedulingDb,
  rows: readonly AppointmentRequestRow[],
): Promise<RequestSummary[]> => {
  const latest = await latestAppointmentsByRequest(
    db,
    rows.map((row) => row.id),
  );
  const now = new Date();
  return rows.map((row) => toRequestSummary(row, { appointment: latest.get(row.id) ?? null, now }));
};

/**
 * Crea una solicitud de cita. El **ticket lo entrega la secuencia** de PostgreSQL
 * dentro del propio `insert`, así que dos solicitudes simultáneas nunca reciben el
 * mismo número y no hace falta ningún bloqueo desde la aplicación.
 */
export const createRequest = async (
  db: SchedulingDb,
  input: CreateRequestInput,
  actor: ActorContext,
): Promise<RequestSummary> => {
  const created = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(appointmentRequests)
      .values({
        channel: input.channel,
        patientId: input.patientId,
        patientName: input.patientName,
        patientDocument: input.patientDocument ?? null,
        patientPhone: input.patientPhone ?? null,
        reason: input.reason,
        status: 'en_espera_cita',
        priority: input.priority,
        requestedAt: input.requestedAt === undefined ? new Date() : new Date(input.requestedAt),
        notes: input.notes ?? null,
        createdBy: actor.actorId,
      })
      .returning();

    const row = inserted[0];
    if (row === undefined) throw new NotFoundError('No se pudo crear la solicitud');

    const summary = toRequestSummary(row);
    await publish(tx, {
      topic: EVENT_TOPICS.requestCreated,
      aggregateId: row.id,
      actor,
      payload: {
        ...auditPayload({
          entityType: 'request',
          entityId: row.id,
          action: 'request_created',
          summary: `Solicitud ${summary.ticket} de ${row.patientName} (${row.channel})`,
          changedFields: ['reason', 'channel'],
          before: null,
          after: {
            ticket: summary.ticket,
            channel: row.channel,
            reason: row.reason,
            patientId: row.patientId,
          },
          reason: null,
          actor,
        }),
        requestId: row.id,
        ticket: summary.ticket,
        ticketNumber: row.ticketNumber,
        channel: row.channel,
        patientId: row.patientId,
        patientName: row.patientName,
        patientDocument: row.patientDocument,
        patientPhone: row.patientPhone,
        reason: row.reason,
        priority: row.priority,
        requestedAt: row.requestedAt.toISOString(),
      },
    });

    return row;
  });

  const [summary] = await toSummaries(db, [created]);
  if (summary === undefined) throw new NotFoundError('No se pudo crear la solicitud');
  return summary;
};

export const getRequestRow = async (
  db: SchedulingDb,
  id: string,
): Promise<AppointmentRequestRow> => {
  const rows = await db
    .select()
    .from(appointmentRequests)
    .where(eq(appointmentRequests.id, id))
    .limit(1);
  const row = rows[0];
  if (row === undefined) throw new NotFoundError('La solicitud no existe');
  return row;
};

export const getRequest = async (db: SchedulingDb, id: string): Promise<RequestSummary> => {
  const row = await getRequestRow(db, id);
  const [summary] = await toSummaries(db, [row]);
  if (summary === undefined) throw new NotFoundError('La solicitud no existe');
  return summary;
};

export const listRequests = async (
  db: SchedulingDb,
  filters: RequestFilters,
): Promise<Paginated<RequestSummary>> => {
  const conditions: SQL[] = [];

  if (filters.onlyWaiting === true) {
    conditions.push(eq(appointmentRequests.status, 'en_espera_cita'));
  } else if (filters.status !== undefined) {
    conditions.push(eq(appointmentRequests.status, filters.status));
  }
  if (filters.channel !== undefined)
    conditions.push(eq(appointmentRequests.channel, filters.channel));

  const search = filters.search?.trim() ?? '';
  if (search !== '') {
    const ticket = parseTicket(search);
    const pattern = `%${search.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
    const alternatives: SQL[] = [
      sql`${appointmentRequests.patientName} ilike ${pattern} escape '\\'`,
      sql`coalesce(${appointmentRequests.patientDocument}, '') like ${`%${search}%`}`,
    ];
    if (ticket !== null) alternatives.push(eq(appointmentRequests.ticketNumber, ticket.number));
    conditions.push(sql`(${sql.join(alternatives, sql` or `)})`);
  }

  const where = conditions.length === 0 ? undefined : and(...conditions);
  const offset = (filters.page - 1) * filters.pageSize;
  // La cola se ordena por prioridad, ticket (antigüedad) o fecha de solicitud.
  const order =
    filters.order === 'antiguedad'
      ? [desc(appointmentRequests.priority), asc(appointmentRequests.requestedAt)]
      : [desc(appointmentRequests.priority), asc(appointmentRequests.ticketNumber)];

  const [rows, totals] = await Promise.all([
    db
      .select()
      .from(appointmentRequests)
      .where(where)
      .orderBy(...order)
      .limit(filters.pageSize)
      .offset(offset),
    db.select({ value: count() }).from(appointmentRequests).where(where),
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

/** Busca una solicitud por su ticket tal como lo escribe la gente (`#000123`). */
export const findRequestByTicket = async (
  db: SchedulingDb,
  ticket: string,
): Promise<RequestSummary | null> => {
  const parsed = parseTicket(ticket);
  if (parsed === null) return null;

  const rows = await db
    .select()
    .from(appointmentRequests)
    .where(eq(appointmentRequests.ticketNumber, parsed.number))
    .limit(1);
  const row = rows[0];
  if (row === undefined) return null;

  const [summary] = await toSummaries(db, [row]);
  return summary ?? null;
};

/** Cola «en espera de cita» completa, ordenada por ticket. */
export const waitingQueue = async (db: SchedulingDb): Promise<RequestSummary[]> => {
  const rows = await db
    .select()
    .from(appointmentRequests)
    .where(inArray(appointmentRequests.status, ['en_espera_cita']))
    .orderBy(desc(appointmentRequests.priority), asc(appointmentRequests.ticketNumber));
  return toSummaries(db, rows);
};

/** Cancela una solicitud que aún no tiene cita (el ticket queda trazado). */
export const cancelRequest = async (
  db: SchedulingDb,
  id: string,
  reason: string | undefined,
  actor: ActorContext,
): Promise<RequestSummary> => {
  const current = await getRequestRow(db, id);
  if (current.status !== 'en_espera_cita') {
    throw new ConflictError(
      `Solo se puede cancelar una solicitud en espera (esta está en «${current.status}»). Cancela la cita si ya tiene fecha.`,
      { extensions: { status: current.status } },
    );
  }

  await db.transaction(async (tx) => {
    await tx
      .update(appointmentRequests)
      .set({ status: 'cancelada', updatedAt: new Date() })
      .where(eq(appointmentRequests.id, id));

    await tx.insert(statusHistory).values({
      entityType: 'request',
      entityId: id,
      fromStatus: current.status,
      toStatus: 'cancelada',
      reason: reason ?? null,
      actorId: actor.actorId,
      actorUsername: actor.actorUsername,
    });

    const summary = toRequestSummary(current);
    await publish(tx, {
      topic: EVENT_TOPICS.requestCancelled,
      aggregateId: id,
      actor,
      payload: {
        ...auditPayload({
          entityType: 'request',
          entityId: id,
          action: 'request_cancelled',
          summary: `Solicitud ${summary.ticket} de ${current.patientName} cancelada`,
          changedFields: ['status'],
          before: { status: current.status },
          after: { status: 'cancelada' },
          reason: reason ?? null,
          actor,
        }),
        requestId: id,
        ticket: summary.ticket,
        patientId: current.patientId,
      },
    });
  });

  return getRequest(db, id);
};
