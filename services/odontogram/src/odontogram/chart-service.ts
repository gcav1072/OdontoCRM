import {
  CLINICAL_STATE_LABELS,
  CONDITION_LABELS,
  SURFACE_FORM_ORDER,
  SURFACE_LABELS,
  conditionsConflict,
  dentitionOfTooth,
  odontogramSummary,
  recordingConflicts,
  supersedesSurfaces,
  type AuditAction,
  type ClinicalState,
  type ClearSurfaceInput,
  type DeleteFindingInput,
  type Dentition,
  type OdontogramDetail,
  type OdontogramHistoryResult,
  type OdontogramLookup,
  type OdontogramMutationResult,
  type OdontogramPatientSnapshot,
  type PrintOdontogramResult,
  type RecordFindingInput,
  type RecordFindingsBatchInput,
  type ToothCondition,
  type ToothFindingHistoryEntry,
  type ToothFindingHistoryEvent,
  type ToothFindingRecord,
  type ToothSurface,
} from '@odontocrm/contracts';
import { EVENT_TOPICS, type EventTopic } from '@odontocrm/events';
import { ConflictError, NotFoundError } from '@odontocrm/kernel';
import { and, asc, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';

import type { OdontogramDb } from '../db/client.js';
import {
  odontogramPrints,
  odontograms,
  toothFindingHistory,
  toothFindings,
  type OdontogramRow,
  type ToothFindingHistoryRow,
  type ToothFindingRow,
} from '../db/schema.js';
import type { ActorContext } from '../shared/context.js';
import { auditPayload, publish } from '../shared/events.js';

/**
 * Odontograma FDI (Fase 6, sesión B): lectura y escritura del **patrón por
 * excepción** —la pieza sana es la ausencia de fila—, histórico append-only,
 * outbox y auditoría.
 *
 * Reglas que este módulo garantiza, sin fiarse de la interfaz:
 *  - `dentition` la deduce el servidor del número FDI del primer hallazgo.
 *  - **Sin cambios no se escribe ni se audita** (el autoguardado repite mucho).
 *  - Una **condición de pieza completa manda sobre las caras** (ADR 0031): al
 *    registrarla, las caras vigentes se dan por superadas (`resolved_at`) en la
 *    misma transacción, sin borrarlas (el histórico las conserva).
 *  - Una cara no se puede registrar si la pieza tiene una condición completa
 *    vigente: 409 con un mensaje que dice qué quitar primero.
 */

/* ── Tipos y constantes ────────────────────────────────────────────────────── */

/** Lo que se audita y viaja en el evento: la clave natural y su estado. */
export type FindingSnapshot = {
  toothNumber: number;
  surface: ToothSurface | null;
  condition: ToothCondition;
  state: ClinicalState;
};

/**
 * Tema del evento de **impresión**. El catálogo de temas es «una acción de
 * dominio» y la impresión no cambia hallazgos, así que —igual que `clinical`,
 * que publica `medical_record_printed` con el tema genérico `recordUpdated`— se
 * reutiliza el tema no destructivo del par y lo que discrimina es
 * `payload.action` (`odontogram_printed`), que es lo que identity convierte en
 * fila de auditoría.
 */
const PRINT_EVENT_TOPIC: EventTopic = EVENT_TOPICS.toothFindingRecorded;

/** Histórico: `limit` por defecto y tope duro (lo repite la ruta). */
export const DEFAULT_HISTORY_LIMIT = 100;
export const MAX_HISTORY_LIMIT = 500;

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

const conditionLabel = (condition: ToothCondition): string =>
  CONDITION_LABELS[condition].toLowerCase();

const surfaceLabel = (surface: ToothSurface): string => SURFACE_LABELS[surface].toLowerCase();

/** «Pieza 16 · oclusal · caries (pendiente)» / «Pieza 36 · ausente (pendiente)». */
export const describeFinding = (finding: FindingSnapshot): string => {
  const partes: string[] = [`Pieza ${finding.toothNumber}`];
  if (finding.surface !== null) partes.push(surfaceLabel(finding.surface));
  partes.push(conditionLabel(finding.condition));
  return `${partes.join(' · ')} (${CLINICAL_STATE_LABELS[finding.state].toLowerCase()})`;
};

/** `['pieza 16', 'oclusal']` (la condición ocupa el lugar de la cara si es completa). */
export const changedFieldsFor = (finding: FindingSnapshot): string[] => [
  `pieza ${finding.toothNumber}`,
  finding.surface === null ? conditionLabel(finding.condition) : surfaceLabel(finding.surface),
];

/** «Pieza 16 · oclusal · caries (pendiente) → completado». */
export const describeTransition = (previous: FindingSnapshot, next: FindingSnapshot): string =>
  previous.state === next.state
    ? `${describeFinding(next)} · notas actualizadas`
    : `${describeFinding({ ...next, state: previous.state })} → ${CLINICAL_STATE_LABELS[
        next.state
      ].toLowerCase()}`;

/* ── Mapeo de filas a DTOs (puro: se prueba sin base de datos) ─────────────── */

export const toFindingRecord = (row: ToothFindingRow): ToothFindingRecord => ({
  id: row.id,
  toothNumber: row.toothNumber,
  surface: row.surface as ToothSurface | null,
  condition: row.condition as ToothCondition,
  state: row.state as ClinicalState,
  notes: row.notes,
  recordedByUsername: row.recordedByUsername,
  recordedAt: row.recordedAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
  sessionId: row.recordedInSessionId,
  resolvedAt: iso(row.resolvedAt),
});

export const toHistoryEntry = (row: ToothFindingHistoryRow): ToothFindingHistoryEntry => ({
  id: row.id,
  toothNumber: row.toothNumber,
  surface: row.surface as ToothSurface | null,
  condition: row.condition as ToothCondition,
  state: row.state as ClinicalState,
  event: row.event as ToothFindingHistoryEvent,
  reason: row.reason,
  notes: row.notes,
  actorUsername: row.actorUsername,
  occurredAt: row.occurredAt.toISOString(),
});

const snapshotOf = (row: ToothFindingRow): FindingSnapshot => ({
  toothNumber: row.toothNumber,
  surface: row.surface as ToothSurface | null,
  condition: row.condition as ToothCondition,
  state: row.state as ClinicalState,
});

/**
 * Agrupa los hallazgos **vigentes** por pieza. Lo que no aparece aquí está sano:
 * esa es la lectura correcta del patrón por excepción.
 */
export const groupFindings = (
  rows: readonly ToothFindingRow[],
): { findings: Record<string, ToothFindingRecord[]>; affectedTeeth: number[] } => {
  const findings: Record<string, ToothFindingRecord[]> = {};
  const teeth = new Set<number>();

  for (const row of rows) {
    const key = String(row.toothNumber);
    const list = findings[key] ?? (findings[key] = []);
    list.push(toFindingRecord(row));
    teeth.add(row.toothNumber);
  }

  return { findings, affectedTeeth: [...teeth].sort((a, b) => a - b) };
};

/** Orden de las caras al devolverlas: el de la ficha de la pieza. */
const byFormOrder = (a: ToothSurface, b: ToothSurface): number =>
  SURFACE_FORM_ORDER.indexOf(a) - SURFACE_FORM_ORDER.indexOf(b);

/* ── Lectura ───────────────────────────────────────────────────────────────── */

export const findOdontogramByPatient = async (
  db: OdontogramDb,
  patientId: string,
): Promise<OdontogramRow | null> => {
  const rows = await db
    .select()
    .from(odontograms)
    .where(eq(odontograms.patientId, patientId))
    .limit(1);
  return rows[0] ?? null;
};

/** Hallazgos **vigentes** de un odontograma, en orden estable. */
const loadActiveFindings = async (
  db: OdontogramDb,
  odontogramId: string,
): Promise<ToothFindingRow[]> =>
  db
    .select()
    .from(toothFindings)
    .where(and(eq(toothFindings.odontogramId, odontogramId), isNull(toothFindings.resolvedAt)))
    .orderBy(
      asc(toothFindings.toothNumber),
      asc(toothFindings.condition),
      asc(toothFindings.surface),
    );

export const buildDetail = async (
  db: OdontogramDb,
  row: OdontogramRow,
  patient: OdontogramPatientSnapshot | null = null,
): Promise<OdontogramDetail> => {
  const { findings, affectedTeeth } = groupFindings(await loadActiveFindings(db, row.id));

  return {
    id: row.id,
    patientId: row.patientId,
    dentition: row.dentition as Dentition,
    findings,
    affectedTeeth,
    empty: affectedTeeth.length === 0,
    recordedByUsername: row.recordedByUsername,
    recordedAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastPrintedAt: iso(row.lastPrintedAt),
    printCount: row.printCount,
    patient,
  };
};

/**
 * Odontograma del paciente. **Nunca 404 por no existir**: responde
 * `exists: false` para que la interfaz distinga «todavía no tiene odontograma» de
 * «no pude preguntar».
 */
export const getOdontogramByPatient = async (
  db: OdontogramDb,
  patientId: string,
  patient: OdontogramPatientSnapshot | null = null,
): Promise<OdontogramLookup> => {
  const row = await findOdontogramByPatient(db, patientId);
  if (row === null) return { exists: false, patientId, patient };
  return { exists: true, odontogram: await buildDetail(db, row, patient) };
};

export const getHistory = async (
  db: OdontogramDb,
  patientId: string,
  limit: number = DEFAULT_HISTORY_LIMIT,
): Promise<OdontogramHistoryResult> => {
  const odontogram = await findOdontogramByPatient(db, patientId);
  if (odontogram === null) throw new NotFoundError('El paciente todavía no tiene odontograma');

  const efectivo = Math.min(Math.max(Math.trunc(limit), 1), MAX_HISTORY_LIMIT);
  const rows = await db
    .select()
    .from(toothFindingHistory)
    .where(eq(toothFindingHistory.odontogramId, odontogram.id))
    .orderBy(desc(toothFindingHistory.occurredAt), desc(toothFindingHistory.id))
    .limit(efectivo);

  return {
    odontogramId: odontogram.id,
    patientId,
    entries: rows.map(toHistoryEntry),
  };
};

/**
 * Resumen agregado del odontograma. Lo consume la Fase 9 (reportes) por la red
 * interna y también sirve de comprobación barata sin traerse la boca entera.
 */
export interface OdontogramInternalSummary {
  patientId: string;
  hasOdontogram: boolean;
  affectedTeeth: number;
  conditionCounts: Partial<Record<ToothCondition, number>>;
  pendingCount: number;
  completedCount: number;
}

export const getInternalSummary = async (
  db: OdontogramDb,
  patientId: string,
): Promise<OdontogramInternalSummary> => {
  const odontogram = await findOdontogramByPatient(db, patientId);
  if (odontogram === null) {
    return {
      patientId,
      hasOdontogram: false,
      affectedTeeth: 0,
      conditionCounts: {},
      pendingCount: 0,
      completedCount: 0,
    };
  }

  const { findings } = groupFindings(await loadActiveFindings(db, odontogram.id));
  const summary = odontogramSummary({ findings, dentition: odontogram.dentition as Dentition });

  return {
    patientId,
    hasOdontogram: true,
    affectedTeeth: summary.affectedTeeth,
    conditionCounts: summary.conditionCounts,
    pendingCount: summary.pendingCount,
    completedCount: summary.completedCount,
  };
};

/* ── Piezas internas de escritura ──────────────────────────────────────────── */

interface FindingEventContext {
  odontogramId: string;
  patientId: string;
  dentition: Dentition;
  actor: ActorContext;
}

const eventContext = (
  odontogram: OdontogramRow,
  patientId: string,
  actor: ActorContext,
): FindingEventContext => ({
  odontogramId: odontogram.id,
  patientId,
  dentition: odontogram.dentition as Dentition,
  actor,
});

/**
 * Crea el odontograma si el paciente no lo tiene, de forma **idempotente** (dos
 * pestañas a la vez chocan con el índice único por paciente y la segunda se queda
 * con el que ya existe). La dentición la fija el primer hallazgo, nunca el cliente.
 */
const ensureOdontogram = async (
  db: OdontogramDb,
  patientId: string,
  dentition: Dentition,
  actor: ActorContext,
): Promise<OdontogramRow> => {
  const existing = await findOdontogramByPatient(db, patientId);
  if (existing !== null) return existing;

  const inserted = await db
    .insert(odontograms)
    .values({
      patientId,
      dentition,
      recordedBy: actor.actorId,
      recordedByUsername: actor.actorUsername,
    })
    .onConflictDoNothing({ target: odontograms.patientId })
    .returning();

  const row = inserted[0];
  if (row !== undefined) return row;

  const raced = await findOdontogramByPatient(db, patientId);
  if (raced === null) throw new NotFoundError('No se pudo abrir el odontograma del paciente');
  return raced;
};

const touchOdontogram = async (
  db: OdontogramDb,
  odontogramId: string,
  at: Date,
): Promise<OdontogramRow> => {
  const rows = await db
    .update(odontograms)
    .set({ updatedAt: at })
    .where(eq(odontograms.id, odontogramId))
    .returning();

  const row = rows[0];
  if (row === undefined) throw new NotFoundError('El odontograma no existe');
  return row;
};

/** La clave natural del hallazgo: pieza + cara (`null` = pieza completa) + condición. */
const findByKey = async (
  db: OdontogramDb,
  odontogramId: string,
  key: Pick<FindingSnapshot, 'toothNumber' | 'surface' | 'condition'>,
): Promise<ToothFindingRow | null> => {
  const rows = await db
    .select()
    .from(toothFindings)
    .where(
      and(
        eq(toothFindings.odontogramId, odontogramId),
        eq(toothFindings.toothNumber, key.toothNumber),
        key.surface === null
          ? isNull(toothFindings.surface)
          : eq(toothFindings.surface, key.surface),
        eq(toothFindings.condition, key.condition),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
};

/**
 * La invariante de convivencia (ADR 0032): la condición nueva no puede chocar con
 * ninguna de las que ya tiene la pieza. `ausente` choca con todo (y las caras ya
 * se dieron por superadas al registrarlo); `implante` × `endodoncia` es imposible;
 * el resto de tratamientos **conviven** con las caras, que es lo que la regla
 * anterior impedía.
 */
const assertNoConflictingCondition = async (
  db: OdontogramDb,
  odontogramId: string,
  toothNumber: number,
  condition: ToothCondition,
): Promise<void> => {
  const vigentes = await db
    .select({ condition: toothFindings.condition, surface: toothFindings.surface })
    .from(toothFindings)
    .where(
      and(
        eq(toothFindings.odontogramId, odontogramId),
        eq(toothFindings.toothNumber, toothNumber),
        isNull(toothFindings.resolvedAt),
      ),
    );

  const choque = vigentes.find((fila) => {
    const otra = fila.condition as ToothCondition;
    // La comprobación es **direccional** (`recordingConflicts`): registrar
    // `ausente` sobre una caries se puede —las supera—, pero una caries sobre una
    // pieza ausente no.
    return recordingConflicts(otra, condition);
  });

  if (choque === undefined) return;

  const otra = choque.condition as ToothCondition;
  throw new ConflictError(
    `La pieza ${toothNumber} tiene «${conditionLabel(otra)}» vigente y no puede convivir con «${conditionLabel(condition)}»: quita primero la que sobra`,
    {
      extensions: {
        toothNumber,
        conflictingCondition: otra,
        condition,
        ...(choque.surface === null ? {} : { surface: choque.surface }),
      },
    },
  );
};

const writeHistory = async (
  db: OdontogramDb,
  input: {
    context: FindingEventContext;
    /** Fila afectada; `null` cuando el hallazgo ya no existe (borrado). */
    findingId: string | null;
    snapshot: FindingSnapshot;
    event: ToothFindingHistoryEvent;
    reason: string | null;
    notes: string | null;
    sessionId: string | null;
    occurredAt: Date;
  },
): Promise<void> => {
  await db.insert(toothFindingHistory).values({
    odontogramId: input.context.odontogramId,
    findingId: input.findingId,
    patientId: input.context.patientId,
    toothNumber: input.snapshot.toothNumber,
    surface: input.snapshot.surface,
    condition: input.snapshot.condition,
    state: input.snapshot.state,
    event: input.event,
    reason: input.reason,
    notes: input.notes,
    actorId: input.context.actor.actorId,
    actorUsername: input.context.actor.actorUsername,
    sessionId: input.sessionId,
    occurredAt: input.occurredAt,
  });
};

/**
 * Publica **un solo** evento por cambio: la carga de auditoría (que identity
 * registra en `/auditoria`) más los campos ricos que consumirá la Fase 9
 * (`reporting`). El esquema de auditoría de identity ignora las claves extra, así
 * que no hace falta duplicar el evento.
 */
const publishFindingEvent = async (
  db: OdontogramDb,
  context: FindingEventContext,
  snapshot: FindingSnapshot,
  change: {
    topic: EventTopic;
    action: AuditAction;
    summary: string;
    changedFields: string[];
    before: FindingSnapshot | null;
    after: FindingSnapshot | null;
    /** `true` si el hallazgo deja de estar vigente por una pieza completa. */
    resolved: boolean;
    reason?: string | null;
  },
): Promise<void> => {
  await publish(db, {
    topic: change.topic,
    aggregateId: context.odontogramId,
    actor: context.actor,
    payload: {
      ...auditPayload({
        entityId: context.odontogramId,
        action: change.action,
        summary: change.summary,
        changedFields: change.changedFields,
        before: change.before,
        after: change.after,
        reason: change.reason ?? null,
        actor: context.actor,
      }),
      patientId: context.patientId,
      odontogramId: context.odontogramId,
      toothNumber: snapshot.toothNumber,
      dentition: context.dentition,
      surface: snapshot.surface,
      condition: snapshot.condition,
      state: snapshot.state,
      resolved: change.resolved,
    },
  });
};

/**
 * Supera las caras de la pieza cuando la condición **manda sobre ellas**
 * (`ausente`; ver `WHOLE_TOOTH_RULES`): todas las caras vigentes se dan por
 * superadas en la misma transacción. No se borran: el histórico conserva que
 * existieron y `resolvedSurfaces` dice cuáles fueron.
 *
 * Los tratamientos (`corona`, `endodoncia`, `implante`) y el plan
 * (`extraccion_indicada`) **no** llaman aquí: conviven con las caras (ADR 0032).
 */
const supersedeSurfaces = async (
  db: OdontogramDb,
  context: FindingEventContext,
  toothNumber: number,
  wholeTooth: FindingSnapshot,
  at: Date,
): Promise<ToothSurface[]> => {
  const rows = await db
    .select()
    .from(toothFindings)
    .where(
      and(
        eq(toothFindings.odontogramId, context.odontogramId),
        eq(toothFindings.toothNumber, toothNumber),
        isNotNull(toothFindings.surface),
        isNull(toothFindings.resolvedAt),
      ),
    )
    .orderBy(asc(toothFindings.surface));

  const resolved: ToothSurface[] = [];

  for (const row of rows) {
    const snapshot = snapshotOf(row);
    await db
      .update(toothFindings)
      .set({ resolvedAt: at, updatedAt: at })
      .where(eq(toothFindings.id, row.id));

    await writeHistory(db, {
      context,
      findingId: row.id,
      snapshot,
      event: 'superado',
      reason: `superado por «${conditionLabel(wholeTooth.condition)}»`,
      notes: row.notes,
      sessionId: row.recordedInSessionId,
      occurredAt: at,
    });

    await publishFindingEvent(db, context, snapshot, {
      topic: EVENT_TOPICS.toothFindingRemoved,
      action: 'tooth_finding_superseded',
      summary: `${describeFinding(snapshot)} · superado por ${conditionLabel(wholeTooth.condition)}`,
      changedFields: changedFieldsFor(snapshot),
      before: snapshot,
      after: null,
      resolved: true,
    });

    if (snapshot.surface !== null) resolved.push(snapshot.surface);
  }

  return resolved.sort(byFormOrder);
};

/** Borra un hallazgo vigente: histórico `eliminado` + evento + fila fuera. */
const removeFinding = async (
  db: OdontogramDb,
  context: FindingEventContext,
  row: ToothFindingRow,
  options: { summary: string; reason: string; at: Date },
): Promise<void> => {
  const snapshot = snapshotOf(row);

  await writeHistory(db, {
    context,
    // La fila se borra: el histórico guarda el hallazgo completo por sí mismo.
    findingId: null,
    snapshot,
    event: 'eliminado',
    reason: options.reason,
    notes: row.notes,
    sessionId: row.recordedInSessionId,
    occurredAt: options.at,
  });

  await publishFindingEvent(db, context, snapshot, {
    topic: EVENT_TOPICS.toothFindingRemoved,
    action: 'tooth_finding_removed',
    summary: options.summary,
    changedFields: changedFieldsFor(snapshot),
    before: snapshot,
    after: null,
    resolved: false,
    reason: options.reason,
  });

  await db.delete(toothFindings).where(eq(toothFindings.id, row.id));
};

/* ── Registro de hallazgos ─────────────────────────────────────────────────── */

interface ApplyOutcome {
  odontogram: OdontogramRow;
  unchanged: boolean;
  resolvedSurfaces: ToothSurface[];
}

/**
 * Aplica un hallazgo dentro de la transacción abierta: crea, actualiza o revive la
 * fila de su clave natural, deja el histórico y publica el evento. Devuelve el
 * odontograma ya tocado.
 */
const applyFinding = async (
  db: OdontogramDb,
  odontogram: OdontogramRow,
  patientId: string,
  input: RecordFindingInput,
  actor: ActorContext,
): Promise<ApplyOutcome> => {
  const context = eventContext(odontogram, patientId, actor);
  const at = new Date();
  const existing = await findByKey(db, odontogram.id, input);

  // 1) Sin cambios no se escribe ni se audita: el autoguardado y la carga rápida
  //    repiten el mismo hallazgo a menudo.
  if (
    existing !== null &&
    existing.resolvedAt === null &&
    existing.state === input.state &&
    existing.notes === input.notes
  ) {
    return { odontogram, unchanged: true, resolvedSurfaces: [] };
  }

  // 2) La invariante del servicio: la condición nueva no puede chocar con las que
  //    ya tiene la pieza (ADR 0032). `ausente` manda sobre todo; `implante` y
  //    `endodoncia` no conviven entre sí; el resto de tratamientos sí conviven con
  //    las caras.
  await assertNoConflictingCondition(db, odontogram.id, input.toothNumber, input.condition);

  const snapshot: FindingSnapshot = {
    toothNumber: input.toothNumber,
    surface: input.surface,
    condition: input.condition,
    state: input.state,
  };

  let resolvedSurfaces: ToothSurface[] = [];

  if (existing === null) {
    const inserted = await db
      .insert(toothFindings)
      .values({
        odontogramId: odontogram.id,
        patientId,
        toothNumber: input.toothNumber,
        surface: input.surface,
        condition: input.condition,
        state: input.state,
        notes: input.notes,
        recordedBy: actor.actorId,
        recordedByUsername: actor.actorUsername,
        recordedInSessionId: input.sessionId,
        recordedAt: at,
        updatedAt: at,
      })
      .returning();

    const row = inserted[0];
    if (row === undefined) throw new NotFoundError('No se pudo registrar el hallazgo');

    await writeHistory(db, {
      context,
      findingId: row.id,
      snapshot,
      event: 'registrado',
      reason: null,
      notes: input.notes,
      sessionId: input.sessionId,
      occurredAt: at,
    });

    await publishFindingEvent(db, context, snapshot, {
      topic: EVENT_TOPICS.toothFindingRecorded,
      action: 'tooth_finding_recorded',
      summary: describeFinding(snapshot),
      changedFields: changedFieldsFor(snapshot),
      before: null,
      after: snapshot,
      resolved: false,
    });

    if (supersedesSurfaces(input.condition)) {
      resolvedSurfaces = await supersedeSurfaces(db, context, input.toothNumber, snapshot, at);
    }
  } else if (existing.resolvedAt !== null) {
    // 3) La clave natural ya existía pero estaba **superada**: se revive la misma
    //    fila (el índice único no admite otra) y vuelve a estar vigente.
    const revived = await db
      .update(toothFindings)
      .set({
        state: input.state,
        notes: input.notes,
        resolvedAt: null,
        recordedBy: actor.actorId,
        recordedByUsername: actor.actorUsername,
        recordedInSessionId: input.sessionId,
        recordedAt: at,
        updatedAt: at,
      })
      .where(eq(toothFindings.id, existing.id))
      .returning();

    if (revived[0] === undefined) throw new NotFoundError('No se pudo registrar el hallazgo');

    await writeHistory(db, {
      context,
      findingId: existing.id,
      snapshot,
      event: 'registrado',
      reason: 'vuelve a estar vigente',
      notes: input.notes,
      sessionId: input.sessionId,
      occurredAt: at,
    });

    await publishFindingEvent(db, context, snapshot, {
      topic: EVENT_TOPICS.toothFindingRecorded,
      action: 'tooth_finding_recorded',
      summary: describeFinding(snapshot),
      changedFields: changedFieldsFor(snapshot),
      before: null,
      after: snapshot,
      resolved: false,
    });

    if (supersedesSurfaces(input.condition)) {
      resolvedSurfaces = await supersedeSurfaces(db, context, input.toothNumber, snapshot, at);
    }
  } else {
    // 4) Cambia el estado o las notas del hallazgo vigente.
    const previous = snapshotOf(existing);
    const updated = await db
      .update(toothFindings)
      .set({ state: input.state, notes: input.notes, updatedAt: at })
      .where(eq(toothFindings.id, existing.id))
      .returning();

    if (updated[0] === undefined) throw new NotFoundError('No se pudo actualizar el hallazgo');

    await writeHistory(db, {
      context,
      findingId: existing.id,
      snapshot,
      event: 'actualizado',
      reason: null,
      notes: input.notes,
      sessionId: existing.recordedInSessionId,
      occurredAt: at,
    });

    await publishFindingEvent(db, context, snapshot, {
      topic: EVENT_TOPICS.toothFindingRecorded,
      action: 'tooth_finding_updated',
      summary: describeTransition(previous, snapshot),
      changedFields: changedFieldsFor(snapshot),
      before: previous,
      after: snapshot,
      resolved: false,
    });
  }

  return {
    odontogram: await touchOdontogram(db, odontogram.id, at),
    unchanged: false,
    resolvedSurfaces,
  };
};

/**
 * Un lote no puede traer, para la misma pieza, dos condiciones que **no conviven**
 * (`ausente` con cualquier otra, o `implante` con `endodoncia`): el orden de
 * aplicación cambiaría el resultado y la regla clínica haría lo contrario de lo que
 * pidió quien pegó la lista. Se rechaza entero antes de abrir la transacción.
 *
 * Un tratamiento **con** sus caras (`corona` + `caries oclusal`) sí es un lote
 * válido: es la boca normal (ADR 0032) y la hoja táctil lo manda junto.
 */
export const assertNoScopeConflict = (findings: readonly RecordFindingInput[]): void => {
  const porPieza = new Map<number, RecordFindingInput[]>();

  for (const finding of findings) {
    const lista = porPieza.get(finding.toothNumber) ?? [];
    lista.push(finding);
    porPieza.set(finding.toothNumber, lista);
  }

  for (const [toothNumber, lista] of porPieza) {
    for (let i = 0; i < lista.length; i += 1) {
      for (let j = i + 1; j < lista.length; j += 1) {
        const uno = lista[i];
        const otro = lista[j];
        if (uno === undefined || otro === undefined) continue;
        if (!conditionsConflict(uno.condition, otro.condition)) continue;

        throw new ConflictError(
          `El lote trae la pieza ${toothNumber} con «${conditionLabel(uno.condition)}» y «${conditionLabel(otro.condition)}» a la vez, y no conviven: sepáralas en dos peticiones`,
          { extensions: { toothNumber, condition: uno.condition, conflict: otro.condition } },
        );
      }
    }
  }
};

const toMutationResult = async (
  db: OdontogramDb,
  outcome: ApplyOutcome,
): Promise<OdontogramMutationResult> => ({
  odontogram: await buildDetail(db, outcome.odontogram),
  unchanged: outcome.unchanged,
  resolvedSurfaces: outcome.resolvedSurfaces,
});

/** Registra (o corrige) un hallazgo. Crea el odontograma si es el primero. */
export const recordFinding = async (
  db: OdontogramDb,
  patientId: string,
  input: RecordFindingInput,
  actor: ActorContext,
): Promise<OdontogramMutationResult> => {
  const outcome = await db.transaction(async (tx) => {
    const odontogram = await ensureOdontogram(
      tx,
      patientId,
      dentitionOfTooth(input.toothNumber),
      actor,
    );
    return applyFinding(tx, odontogram, patientId, input, actor);
  });

  return toMutationResult(db, outcome);
};

/** Carga rápida: varios hallazgos en **una** transacción (o todos o ninguno). */
export const recordFindingsBatch = async (
  db: OdontogramDb,
  patientId: string,
  input: RecordFindingsBatchInput,
  actor: ActorContext,
): Promise<OdontogramMutationResult> => {
  assertNoScopeConflict(input.findings);

  const outcome = await db.transaction(async (tx) => {
    const first = input.findings[0];
    if (first === undefined) throw new ConflictError('El lote no trae ningún hallazgo');

    let odontogram = await ensureOdontogram(
      tx,
      patientId,
      dentitionOfTooth(first.toothNumber),
      actor,
    );

    let unchanged = true;
    const resueltas = new Set<ToothSurface>();

    for (const finding of input.findings) {
      const applied = await applyFinding(tx, odontogram, patientId, finding, actor);
      odontogram = applied.odontogram;
      if (!applied.unchanged) unchanged = false;
      for (const surface of applied.resolvedSurfaces) resueltas.add(surface);
    }

    return { odontogram, unchanged, resolvedSurfaces: [...resueltas].sort(byFormOrder) };
  });

  return toMutationResult(db, outcome);
};

/**
 * Borra la clave natural del hallazgo. Si no estaba vigente (o el odontograma no
 * existe todavía) no es un error: `unchanged: true` y ni se escribe ni se audita.
 */
export const deleteFinding = async (
  db: OdontogramDb,
  patientId: string,
  input: DeleteFindingInput,
  actor: ActorContext,
): Promise<OdontogramMutationResult> => {
  const outcome = await db.transaction(async (tx): Promise<ApplyOutcome> => {
    const odontogram = await findOdontogramByPatient(tx, patientId);
    if (odontogram === null) throw new NotFoundError('El paciente todavía no tiene odontograma');

    const context = eventContext(odontogram, patientId, actor);
    const at = new Date();
    const row = await findByKey(tx, odontogram.id, input);

    if (row === null || row.resolvedAt !== null) {
      return { odontogram, unchanged: true, resolvedSurfaces: [] };
    }

    const snapshot = snapshotOf(row);
    await removeFinding(tx, context, row, {
      summary: `${describeFinding(snapshot)} · hallazgo eliminado`,
      reason: 'corrección de captura: la pieza vuelve a estar sana',
      at,
    });

    return {
      odontogram: await touchOdontogram(tx, odontogram.id, at),
      unchanged: false,
      resolvedSurfaces: [],
    };
  });

  return toMutationResult(db, outcome);
};

/**
 * Deja una cara sana: borra **todas** las condiciones vigentes de esa cara (no
 * hace falta decir cuál había). Sin hallazgos que borrar, `unchanged: true`.
 */
export const clearSurface = async (
  db: OdontogramDb,
  patientId: string,
  input: ClearSurfaceInput,
  actor: ActorContext,
): Promise<OdontogramMutationResult> => {
  const outcome = await db.transaction(async (tx): Promise<ApplyOutcome> => {
    const odontogram = await findOdontogramByPatient(tx, patientId);
    if (odontogram === null) throw new NotFoundError('El paciente todavía no tiene odontograma');

    const context = eventContext(odontogram, patientId, actor);
    const at = new Date();
    const rows = await tx
      .select()
      .from(toothFindings)
      .where(
        and(
          eq(toothFindings.odontogramId, odontogram.id),
          eq(toothFindings.toothNumber, input.toothNumber),
          eq(toothFindings.surface, input.surface),
          isNull(toothFindings.resolvedAt),
        ),
      )
      .orderBy(asc(toothFindings.condition));

    if (rows.length === 0) {
      return { odontogram, unchanged: true, resolvedSurfaces: [] };
    }

    for (const row of rows) {
      await removeFinding(tx, context, row, {
        summary: `${describeFinding(snapshotOf(row))} · cara dejada sana`,
        reason: `cara ${surfaceLabel(input.surface)} dejada sana`,
        at,
      });
    }

    return {
      odontogram: await touchOdontogram(tx, odontogram.id, at),
      unchanged: false,
      resolvedSurfaces: [],
    };
  });

  return toMutationResult(db, outcome);
};

/* ── Impresión (también la secretaría, que solo lee) ───────────────────────── */

export const registerPrint = async (
  db: OdontogramDb,
  patientId: string,
  actor: ActorContext,
): Promise<PrintOdontogramResult> => {
  const odontogram = await findOdontogramByPatient(db, patientId);
  if (odontogram === null) throw new NotFoundError('El paciente todavía no tiene odontograma');

  return db.transaction(async (tx) => {
    const at = new Date();
    const rows = await tx
      .update(odontograms)
      .set({
        // En SQL, para que dos impresiones a la vez no pierdan una.
        printCount: sql`${odontograms.printCount} + 1`,
        lastPrintedAt: at,
        updatedAt: at,
      })
      .where(eq(odontograms.id, odontogram.id))
      .returning();

    const row = rows[0];
    if (row === undefined) throw new NotFoundError('El odontograma no existe');

    await tx.insert(odontogramPrints).values({
      odontogramId: row.id,
      printedBy: actor.actorId,
      printedByUsername: actor.actorUsername,
      printedAt: at,
    });

    await publish(tx, {
      topic: PRINT_EVENT_TOPIC,
      aggregateId: row.id,
      actor,
      payload: auditPayload({
        entityId: row.id,
        action: 'odontogram_printed',
        summary: 'Odontograma impreso',
        changedFields: [],
        before: null,
        after: { printCount: row.printCount, patientId },
        reason: null,
        actor,
      }),
    });

    return {
      id: row.id,
      printCount: row.printCount,
      lastPrintedAt: at.toISOString(),
    };
  });
};
