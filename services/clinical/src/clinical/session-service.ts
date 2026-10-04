import {
  clinicalSessionCanClose,
  clinicalSessionSummaryText,
  emptyClinicalSessionContent,
  sessionProcedureText,
  type AmendClinicalSessionInput,
  type ClinicalPatientSnapshot,
  type ClinicalSessionContent,
  type ClinicalSessionDetail,
  type ClinicalSessionList,
  type ClinicalSessionStatusLookup,
  type ClinicalSessionSummary,
  type CloseClinicalSessionInput,
  type CreateClinicalSessionInput,
  type SaveClinicalSessionInput,
} from '@odontocrm/contracts';
import { EVENT_TOPICS } from '@odontocrm/events';
import { ConflictError, NotFoundError } from '@odontocrm/kernel';
import { desc, eq, sql, type SQL } from 'drizzle-orm';

import type { ClinicalDb } from '../db/client.js';
import { clinicalSessions, type ClinicalSessionRow } from '../db/schema.js';
import type { ActorContext } from '../shared/context.js';
import { auditPayload, publish } from '../shared/events.js';
import { openRecord } from './record-service.js';

/**
 * Sesiones clínicas (Fase 7, sesión A): la evolución del paciente.
 *
 * Reglas que aplica el servidor:
 *  - **Una sesión abierta por paciente y cita**: abrir dos veces devuelve la que
 *    ya estaba (idempotente) y el índice único parcial lo garantiza en la base.
 *  - **El borrador se autoguarda sin ruido**: no publica evento ni auditoría; el
 *    acto clínico nace al **cerrar**, que es lo que queda registrado.
 *  - **Lo cerrado es inmutable**: la corrección abre una sesión enmendada
 *    (`amendedFromId`) con el contenido copiado y un motivo obligatorio.
 *  - La historia puede estar **firmada** y la evolución continúa.
 */

type SessionsMap = ClinicalSessionList;

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

/** El contenido se guarda ya validado; al leer se usa tal cual (como el resto del servicio). */
const contentOf = (row: ClinicalSessionRow): ClinicalSessionContent =>
  row.content as unknown as ClinicalSessionContent;

const toSummary = (row: ClinicalSessionRow): ClinicalSessionSummary => {
  const content = contentOf(row);
  return {
    id: row.id,
    recordId: row.recordId,
    patientId: row.patientId,
    appointmentId: row.appointmentId,
    sessionNumber: row.sessionNumber,
    status: row.status as ClinicalSessionSummary['status'],
    openedAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    closedAt: iso(row.closedAt),
    openedByUsername: row.openedByUsername,
    closedByUsername: row.closedByUsername,
    closureNote: row.closureNote,
    amendedFromId: row.amendedFromId,
    amendmentReason: row.amendmentReason,
    procedureCount: content.procedimientos.length,
    summary: clinicalSessionSummaryText(content),
  };
};

const toDetail = (row: ClinicalSessionRow): ClinicalSessionDetail => ({
  ...toSummary(row),
  content: contentOf(row),
});

/* ── Lectura ───────────────────────────────────────────────────────────────── */

const listSessions = async (db: ClinicalDb, where: SQL): Promise<SessionsMap> => {
  const rows = await db
    .select()
    .from(clinicalSessions)
    .where(where)
    .orderBy(desc(clinicalSessions.sessionNumber));
  return { items: rows.map(toSummary), total: rows.length };
};

/** Sesiones de un paciente, de la última a la primera (el historial de evolución). */
export const listSessionsByPatient = async (
  db: ClinicalDb,
  patientId: string,
): Promise<SessionsMap> => listSessions(db, eq(clinicalSessions.patientId, patientId));

/** Sesiones de una cita: la agenda y la secretaría preguntan por aquí. */
export const listSessionsByAppointment = async (
  db: ClinicalDb,
  appointmentId: string,
): Promise<SessionsMap> => listSessions(db, eq(clinicalSessions.appointmentId, appointmentId));

const findSessionRow = async (db: ClinicalDb, id: string): Promise<ClinicalSessionRow | null> => {
  const rows = await db.select().from(clinicalSessions).where(eq(clinicalSessions.id, id)).limit(1);
  return rows[0] ?? null;
};

const loadSessionOrFail = async (db: ClinicalDb, id: string): Promise<ClinicalSessionRow> => {
  const row = await findSessionRow(db, id);
  if (row === null) throw new NotFoundError('La sesión clínica no existe');
  return row;
};

export const getSessionDetail = async (
  db: ClinicalDb,
  id: string,
): Promise<ClinicalSessionDetail> => toDetail(await loadSessionOrFail(db, id));

/** Estado de la sesión para otros servicios (la agenda lo comprueba antes del «atendido»). */
export const getSessionStatus = async (
  db: ClinicalDb,
  id: string,
): Promise<ClinicalSessionStatusLookup> => {
  const row = await loadSessionOrFail(db, id);
  return {
    sessionId: row.id,
    patientId: row.patientId,
    appointmentId: row.appointmentId,
    status: row.status as ClinicalSessionStatusLookup['status'],
    closedAt: iso(row.closedAt),
  };
};

/** La sesión **abierta** del paciente, si la hay: es la que el formulario retoma. */
export const findOpenSession = async (
  db: ClinicalDb,
  patientId: string,
): Promise<ClinicalSessionDetail | null> => {
  const rows = await db
    .select()
    .from(clinicalSessions)
    .where(
      sql`${clinicalSessions.patientId} = ${patientId} and ${clinicalSessions.status} = 'borrador'`,
    )
    .orderBy(desc(clinicalSessions.sessionNumber))
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : toDetail(row);
};

/* ── Apertura ──────────────────────────────────────────────────────────────── */

export interface OpenSessionResult {
  created: boolean;
  detail: ClinicalSessionDetail;
}

const nextSessionNumber = async (
  db: Pick<ClinicalDb, 'select'>,
  patientId: string,
): Promise<number> => {
  const rows = await db
    .select({ max: sql<number>`coalesce(max(${clinicalSessions.sessionNumber}), 0)` })
    .from(clinicalSessions)
    .where(eq(clinicalSessions.patientId, patientId));
  return Number(rows[0]?.max ?? 0) + 1;
};

const INSERT_RETRIES = 3;

/**
 * Abre la sesión del paciente.
 *
 * Es **idempotente**: si el doctor ya tenía un borrador abierto (cerró la pestaña,
 * volvió del pasillo), se devuelve ese mismo y no se crea otro. Si la historia no
 * existe todavía, se abre —la evolución también sirve de primera visita—.
 */
export const openSession = async (
  db: ClinicalDb,
  patientId: string,
  input: CreateClinicalSessionInput,
  actor: ActorContext,
  patient: ClinicalPatientSnapshot | null = null,
): Promise<OpenSessionResult> => {
  const record = await openRecord(db, patientId, actor, patient);

  const existing = await findOpenSession(db, patientId);
  if (existing !== null) {
    // El borrador no tenía cita y ahora el paciente está en el consultorio: se enlaza.
    if (input.appointmentId !== null && existing.appointmentId === null) {
      const linked = await db
        .update(clinicalSessions)
        .set({ appointmentId: input.appointmentId, updatedAt: new Date() })
        .where(eq(clinicalSessions.id, existing.id))
        .returning();
      const row = linked[0];
      if (row !== undefined) return { created: false, detail: toDetail(row) };
    }
    return { created: false, detail: existing };
  }

  const content: ClinicalSessionContent = {
    ...emptyClinicalSessionContent(),
    motivo: input.motivo,
  };

  for (let intento = 0; intento < INSERT_RETRIES; intento += 1) {
    try {
      const row = await db.transaction(async (tx) => {
        const sessionNumber = await nextSessionNumber(tx, patientId);
        const inserted = await tx
          .insert(clinicalSessions)
          .values({
            recordId: record.detail.id,
            patientId,
            appointmentId: input.appointmentId,
            sessionNumber,
            content: content as unknown as Record<string, unknown>,
            openedBy: actor.actorId,
            openedByUsername: actor.actorUsername,
          })
          .returning();
        const creada = inserted[0];
        if (creada === undefined) throw new NotFoundError('No se pudo abrir la sesión clínica');

        await publish(tx, {
          topic: EVENT_TOPICS.sessionCreated,
          aggregateId: creada.id,
          actor,
          payload: auditPayload({
            entityId: creada.id,
            action: 'clinical_session_created',
            entityType: 'clinical_session',
            summary: `Sesión clínica ${String(creada.sessionNumber)} abierta`,
            changedFields: ['status'],
            after: {
              patientId,
              appointmentId: input.appointmentId,
              sessionNumber: creada.sessionNumber,
              status: 'borrador',
            },
            reason: null,
            actor,
          }),
        });

        return creada;
      });

      return { created: true, detail: toDetail(row) };
    } catch (error) {
      const code = (error as { code?: string }).code;
      // Dos pestañas a la vez: la segunda se queda con el borrador de la primera.
      if (code === '23505') {
        const abierta = await findOpenSession(db, patientId);
        if (abierta !== null) return { created: false, detail: abierta };
        continue;
      }
      throw error;
    }
  }

  throw new ConflictError('No se pudo abrir la sesión: vuelve a intentarlo');
};

/* ── Autoguardado ──────────────────────────────────────────────────────────── */

export interface SaveSessionResult {
  detail: ClinicalSessionDetail;
  /** `false` cuando el documento no cambió: no se escribe ni se toca la fecha. */
  changed: boolean;
}

/**
 * Compara dos documentos **por contenido**, no por su orden de claves.
 *
 * `jsonb` no conserva el orden en que se escribieron las claves (las reordena al
 * guardarlas), así que comparar con `JSON.stringify` daría «cambió» en cada
 * autoguardado y la sesión acabaría con una escritura por pausa de tecleo. Se
 * serializa con las claves ordenadas y se comparan las cadenas.
 */
const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
};

export const sameSessionContent = (left: unknown, right: unknown): boolean =>
  canonicalJson(left) === canonicalJson(right);

/**
 * Autoguarda el borrador. Sin cambios no escribe nada (la sesión no se ensucia con
 * guardados vacíos) y **no publica evento**: el acto clínico queda registrado al
 * cerrar la sesión, no en cada pausa de tecleo.
 */
export const saveSession = async (
  db: ClinicalDb,
  id: string,
  input: SaveClinicalSessionInput,
): Promise<SaveSessionResult> => {
  const row = await loadSessionOrFail(db, id);
  if (row.status !== 'borrador') {
    throw new ConflictError(
      'La sesión está cerrada: se corrige abriendo una sesión enmendada con su motivo',
      { extensions: { status: row.status } },
    );
  }

  if (sameSessionContent(row.content, input.content)) {
    return { detail: toDetail(row), changed: false };
  }

  const updated = await db
    .update(clinicalSessions)
    .set({ content: input.content as unknown as Record<string, unknown>, updatedAt: new Date() })
    .where(eq(clinicalSessions.id, id))
    .returning();
  const fila = updated[0];
  if (fila === undefined) throw new NotFoundError('La sesión clínica no existe');
  return { detail: toDetail(fila), changed: true };
};

/* ── Cierre ────────────────────────────────────────────────────────────────── */

/**
 * Cierra la sesión: a partir de aquí es inmutable.
 *
 * No se cierra una sesión vacía (sin motivo, sin procedimientos y sin
 * diagnóstico): dejaría un hueco en la evolución. El cierre sí queda en la
 * auditoría con lo que se hizo, que es lo que se consulta después.
 */
export const closeSession = async (
  db: ClinicalDb,
  id: string,
  input: CloseClinicalSessionInput,
  actor: ActorContext,
): Promise<ClinicalSessionDetail> => {
  const row = await loadSessionOrFail(db, id);
  if (row.status !== 'borrador') {
    throw new ConflictError('La sesión ya está cerrada', { extensions: { status: row.status } });
  }

  const content = contentOf(row);
  if (!clinicalSessionCanClose(content)) {
    throw new ConflictError(
      'Una sesión sin motivo, sin procedimientos y sin diagnóstico no documenta nada: escribe al menos uno antes de cerrarla',
      { extensions: { missing: ['contenido'] } },
    );
  }

  const closed = await db.transaction(async (tx) => {
    const updated = await tx
      .update(clinicalSessions)
      .set({
        status: 'cerrada',
        closedAt: new Date(),
        closedBy: actor.actorId,
        closedByUsername: actor.actorUsername,
        closureNote: input.closureNote,
        updatedAt: new Date(),
      })
      .where(eq(clinicalSessions.id, id))
      .returning();
    const fila = updated[0];
    if (fila === undefined) throw new NotFoundError('La sesión clínica no existe');

    await publish(tx, {
      topic: EVENT_TOPICS.sessionClosed,
      aggregateId: id,
      actor,
      payload: auditPayload({
        entityId: id,
        action: 'clinical_session_closed',
        entityType: 'clinical_session',
        summary: `Sesión clínica ${String(fila.sessionNumber)} cerrada. ${clinicalSessionSummaryText(content)}`,
        changedFields: ['status'],
        before: { status: 'borrador' },
        after: {
          status: 'cerrada',
          sessionNumber: fila.sessionNumber,
          patientId: fila.patientId,
          appointmentId: fila.appointmentId,
          diagnostico: content.diagnostico,
          procedimientos: content.procedimientos.slice(0, 10).map(sessionProcedureText),
        },
        reason: input.closureNote,
        actor,
      }),
    });

    return fila;
  });

  return toDetail(closed);
};

/* ── Enmienda ──────────────────────────────────────────────────────────────── */

/**
 * Corrige una sesión cerrada **sin tocarla**: abre una sesión nueva en borrador
 * con su contenido copiado, enlazada por `amendedFromId` y con el motivo dicho.
 */
export const amendSession = async (
  db: ClinicalDb,
  id: string,
  input: AmendClinicalSessionInput,
  actor: ActorContext,
): Promise<ClinicalSessionDetail> => {
  const original = await loadSessionOrFail(db, id);
  if (original.status !== 'cerrada') {
    throw new ConflictError('La sesión es un borrador: edítala directamente antes de cerrarla', {
      extensions: { status: original.status },
    });
  }

  const row = await db.transaction(async (tx) => {
    const sessionNumber = await nextSessionNumber(db, original.patientId);
    const inserted = await tx
      .insert(clinicalSessions)
      .values({
        recordId: original.recordId,
        patientId: original.patientId,
        appointmentId: original.appointmentId,
        sessionNumber,
        content: original.content,
        openedBy: actor.actorId,
        openedByUsername: actor.actorUsername,
        amendedFromId: original.id,
        amendmentReason: input.reason,
      })
      .returning();
    const creada = inserted[0];
    if (creada === undefined) throw new NotFoundError('No se pudo abrir la sesión enmendada');

    await publish(tx, {
      topic: EVENT_TOPICS.sessionAmended,
      aggregateId: creada.id,
      actor,
      payload: auditPayload({
        entityId: creada.id,
        action: 'clinical_session_amended',
        entityType: 'clinical_session',
        summary: `Enmienda de la sesión ${String(original.sessionNumber)}: se abre la ${String(creada.sessionNumber)} en borrador`,
        changedFields: ['status'],
        before: { sessionId: original.id, sessionNumber: original.sessionNumber },
        after: { sessionId: creada.id, sessionNumber: creada.sessionNumber },
        reason: input.reason,
        actor,
      }),
    });

    return creada;
  });

  return toDetail(row);
};
