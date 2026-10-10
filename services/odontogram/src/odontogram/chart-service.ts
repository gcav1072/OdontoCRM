import {
  CLINICAL_STATE_LABELS,
  CONDITION_LABELS,
  PROCEDURE_LABELS,
  PROCEDURE_TRANSITIONS,
  PROSTHESIS_ARCH_LABELS,
  PROSTHESIS_KIND_LABELS,
  SURFACE_FORM_ORDER,
  SURFACE_LABELS,
  allowedStatesFor,
  archTeeth,
  conditionsConflict,
  dentitionOfTooth,
  isStateAllowed,
  odontogramSummary,
  prosthesesOverlap,
  recordingConflicts,
  sharedTeeth,
  supersedesSurfaces,
  type AuditAction,
  type ClinicalState,
  type ClearSurfaceInput,
  type CompleteProcedureInput,
  type DeleteFindingInput,
  type Dentition,
  type OdontogramDetail,
  type OdontogramHistoryResult,
  type OdontogramLookup,
  type OdontogramMutationResult,
  type OdontogramPatientSnapshot,
  type PrintOdontogramResult,
  type ProsthesisArch,
  type ProsthesisKind,
  type ProsthesisRecord,
  type RecordFindingInput,
  type RecordFindingsBatchInput,
  type RecordProsthesisInput,
  type ToothCondition,
  type ToothFindingHistoryEntry,
  type ToothFindingHistoryEvent,
  type ToothFindingRecord,
  type ToothSurface,
} from '@odontocrm/contracts';
import { EVENT_TOPICS, type EventTopic } from '@odontocrm/events';
import { ConflictError, NotFoundError } from '@odontocrm/kernel';
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';

import type { OdontogramDb } from '../db/client.js';
import {
  odontogramPrints,
  odontograms,
  prosthesisHistory,
  prostheses,
  toothFindingHistory,
  toothFindings,
  type OdontogramRow,
  type ProsthesisRow,
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
 *  - El **estado** de un hallazgo tiene que ser válido para su condición (spec anexo
 *    ADR 0032 §2): no hay «caries completada» ni «extracción indicada completada».
 *  - Los **procedimientos** (`completeProcedure`) mutan un hallazgo en otro en una
 *    sola transacción (extracción cumplida → extraída, caries tratada → restauración).
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

/** «ausente o extraída»: une las condiciones de origen de un procedimiento. */
const conditionsLabel = (conditions: readonly ToothCondition[]): string =>
  conditions.map(conditionLabel).join(' o ');

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

/* ── Mapeo y carga de prótesis removibles (PPR/PRT) ────────────────────────── */

/** Fila de prótesis → DTO, con las fechas en ISO. */
export const toProsthesisRecord = (row: ProsthesisRow): ProsthesisRecord => ({
  id: row.id,
  kind: row.kind as ProsthesisKind,
  arch: row.arch as ProsthesisArch,
  toothNumbers: row.toothNumbers,
  state: row.state as ClinicalState,
  notes: row.notes,
  recordedByUsername: row.recordedByUsername,
  recordedAt: row.recordedAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
  sessionId: row.recordedInSessionId,
});

/** Prótesis removibles **vigentes** de un odontograma, en orden estable. */
const loadActiveProstheses = async (
  db: OdontogramDb,
  odontogramId: string,
): Promise<ProsthesisRecord[]> => {
  const rows = await db
    .select()
    .from(prostheses)
    .where(and(eq(prostheses.odontogramId, odontogramId), isNull(prostheses.resolvedAt)))
    .orderBy(asc(prostheses.arch), asc(prostheses.kind));
  return rows.map(toProsthesisRecord);
};

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
  const prosthesesList = await loadActiveProstheses(db, row.id);

  return {
    id: row.id,
    patientId: row.patientId,
    dentition: row.dentition as Dentition,
    findings,
    prostheses: prosthesesList,
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

/**
 * La boca **entera** para otro servicio: dentición y hallazgos vigentes.
 *
 * El resumen de arriba se queda en los contadores, que es lo que necesitan la agenda y
 * los reportes; el **dossier** del expediente, en cambio, tiene que *dibujar* el
 * odontograma, y para eso hacen falta los hallazgos uno a uno. Sale por la red interna
 * (nunca por el gateway) y degrada en el consumidor: sin odontograma responde
 * `hasOdontogram: false` en vez de 404.
 */
export interface OdontogramInternalChart {
  patientId: string;
  hasOdontogram: boolean;
  dentition: Dentition | null;
  findings: Record<string, ToothFindingRecord[]>;
  prostheses: ProsthesisRecord[];
}

export const getInternalChart = async (
  db: OdontogramDb,
  patientId: string,
): Promise<OdontogramInternalChart> => {
  const odontogram = await findOdontogramByPatient(db, patientId);
  if (odontogram === null) {
    return { patientId, hasOdontogram: false, dentition: null, findings: {}, prostheses: [] };
  }

  const { findings } = groupFindings(await loadActiveFindings(db, odontogram.id));
  return {
    patientId,
    hasOdontogram: true,
    dentition: odontogram.dentition as Dentition,
    findings,
    prostheses: await loadActiveProstheses(db, odontogram.id),
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

/**
 * La dentición del odontograma **derivada de los hallazgos vigentes** (ADR 0051): solo
 * permanentes → `permanente`, solo temporales → `temporal`, de las dos → **`mixta`**. Con
 * la boca vacía se conserva la que hubiera.
 *
 * La dentición es un **estado clínico**, no una estampa del primer hallazgo: el día que
 * erupciona el primer molar permanente —o el día que se corrige una captura— la boca
 * cambia de dentición, y el gráfico tiene que seguirle. Por eso se recalcula en cada
 * escritura y no se fija una sola vez.
 */
const syncDentition = async (
  db: OdontogramDb,
  odontogram: OdontogramRow,
): Promise<OdontogramRow> => {
  const vigentes = await db
    .select({ toothNumber: toothFindings.toothNumber })
    .from(toothFindings)
    .where(and(eq(toothFindings.odontogramId, odontogram.id), isNull(toothFindings.resolvedAt)));

  const denticiones = new Set(vigentes.map((fila) => dentitionOfTooth(fila.toothNumber)));
  const next: Dentition =
    denticiones.size === 0
      ? (odontogram.dentition as Dentition)
      : denticiones.size === 1
        ? ([...denticiones][0] as Dentition)
        : 'mixta';

  if (next === odontogram.dentition) return odontogram;

  const rows = await db
    .update(odontograms)
    .set({ dentition: next })
    .where(eq(odontograms.id, odontogram.id))
    .returning();
  return rows[0] ?? { ...odontogram, dentition: next };
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

/**
 * El **estado** tiene que ser válido para la condición (spec anexo ADR 0032 §2). El
 * contrato lo comprueba al parsear, pero el servicio no se fía: sin este guardián,
 * `extraccion_indicada` completada se colaba y dejaba la pieza imposible del informe
 * de fallo («extracción completada + implante»).
 */
export const assertStateAllowed = (condition: ToothCondition, state: ClinicalState): void => {
  if (isStateAllowed(condition, state)) return;
  throw new ConflictError(
    `La condición «${conditionLabel(condition)}» no admite el estado «${state}»: ${allowedStatesFor(
      condition,
    )
      .map((valor) => CLINICAL_STATE_LABELS[valor].toLowerCase())
      .join(' o ')}`,
    { extensions: { condition, state, allowedStates: allowedStatesFor(condition) } },
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
 * (`ausente` y `corona`; ver `WHOLE_TOOTH_RULES`): todas las caras vigentes se dan por
 * superadas en la misma transacción. No se borran: el histórico conserva que
 * existieron y `resolvedSurfaces` dice cuáles fueron.
 *
 * La corona entra aquí porque **recubre el muñón**: lo que hubiera debajo ya no se ve
 * en boca. La caries que aparezca **después** no se supera —esa es la recurrente, y se
 * pinta sobre la corona—, porque esto solo mira lo que había en este momento.
 *
 * `endodoncia`, `implante` y el plan (`extraccion_indicada`) **no** llaman aquí:
 * conviven con las caras (ADR 0032).
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

/**
 * **Resuelve** un hallazgo vigente porque un procedimiento lo ha cumplido: no se
 * edita ni se borra, se da por terminado con su motivo. `resolved_at`, una entrada
 * `resuelto` en el histórico y un evento que reporting lee como retirada de la fila.
 *
 * Es distinto de `supersedeSurfaces` (superar por una condición de pieza completa):
 * aquí el origen no lo tapa otro hallazgo, lo **cierra** el procedimiento (la caries
 * obturada, la extracción hecha).
 */
const resolveFinding = async (
  db: OdontogramDb,
  context: FindingEventContext,
  row: ToothFindingRow,
  options: { reason: string; at: Date },
): Promise<void> => {
  const snapshot = snapshotOf(row);

  await db
    .update(toothFindings)
    .set({ resolvedAt: options.at, updatedAt: options.at })
    .where(eq(toothFindings.id, row.id));

  await writeHistory(db, {
    context,
    findingId: row.id,
    snapshot,
    event: 'resuelto',
    reason: options.reason,
    notes: row.notes,
    sessionId: row.recordedInSessionId,
    occurredAt: options.at,
  });

  await publishFindingEvent(db, context, snapshot, {
    // El hallazgo sale del modelo vigente: reporting lo trata como una retirada
    // (`action === 'tooth_finding_superseded'`), igual que una cara superada.
    topic: EVENT_TOPICS.toothFindingRemoved,
    action: 'tooth_finding_superseded',
    summary: `${describeFinding(snapshot)} · ${options.reason}`,
    changedFields: changedFieldsFor(snapshot),
    before: snapshot,
    after: null,
    resolved: true,
    reason: options.reason,
  });
};

/** Hallazgos vigentes de una condición en una pieza, con filtro opcional de cara. */
const findActiveByCondition = async (
  db: OdontogramDb,
  odontogramId: string,
  toothNumber: number,
  /** Una condición o varias: un procedimiento puede partir de estados distintos. */
  condition: ToothCondition | readonly ToothCondition[],
  /** `null` = pieza completa; `'any'` = cualquier cara; una cara concreta. */
  surface: ToothSurface | null | 'any',
): Promise<ToothFindingRow[]> => {
  const condiciones: ToothCondition[] =
    typeof condition === 'string' ? [condition] : [...condition];
  const filtros = [
    eq(toothFindings.odontogramId, odontogramId),
    eq(toothFindings.toothNumber, toothNumber),
    inArray(toothFindings.condition, condiciones),
    isNull(toothFindings.resolvedAt),
  ];
  if (surface === null) filtros.push(isNull(toothFindings.surface));
  else if (surface !== 'any') filtros.push(eq(toothFindings.surface, surface));

  return db
    .select()
    .from(toothFindings)
    .where(and(...filtros))
    .orderBy(asc(toothFindings.surface));
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
  assertStateAllowed(input.condition, input.state);
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
    const applied = await applyFinding(tx, odontogram, patientId, input, actor);
    // La dentición sigue a los hallazgos: al entrar una pieza de la otra dentición la
    // boca pasa a `mixta` (y al revés al corregir una captura).
    return applied.unchanged
      ? applied
      : { ...applied, odontogram: await syncDentition(tx, applied.odontogram) };
  });

  return toMutationResult(db, outcome);
};

/**
 * Orden de aplicación dentro de un lote: **primero las caras y después las condiciones
 * de pieza completa**.
 *
 * Importa cuando el lote trae las dos cosas para la misma pieza (la hoja táctil manda
 * «corona» con la caries que tenía debajo, en una transacción). Si la corona se aplica
 * antes, la caries que viene detrás queda vigente y se pinta **encima** de la corona:
 * se leería como una caries recurrente que nadie ha diagnosticado. Aplicando las caras
 * primero, la corona las supera como es debido, y el resultado **no depende del orden
 * en que la interfaz mande el lote**.
 */
const ordenDeAplicacion = (
  findings: readonly RecordFindingInput[],
): readonly RecordFindingInput[] => [
  ...findings.filter((finding) => finding.surface !== null),
  ...findings.filter((finding) => finding.surface === null),
];

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

    for (const finding of ordenDeAplicacion(input.findings)) {
      const applied = await applyFinding(tx, odontogram, patientId, finding, actor);
      odontogram = applied.odontogram;
      if (!applied.unchanged) unchanged = false;
      for (const surface of applied.resolvedSurfaces) resueltas.add(surface);
    }

    return {
      odontogram: unchanged ? odontogram : await syncDentition(tx, odontogram),
      unchanged,
      resolvedSurfaces: [...resueltas].sort(byFormOrder),
    };
  });

  return toMutationResult(db, outcome);
};

/**
 * **Cumple un procedimiento** del plan (spec anexo ADR 0032 §5). No es un cambio de
 * estado: es una **mutación** que resuelve el hallazgo de origen y deja vigente el
 * destino, todo en una sola transacción (o todo o nada).
 *
 *  - `obturar`: resuelve la `caries` y deja una `restauracion` (completado) en la
 *    misma cara. Sin cara = **todas** las caries de la pieza.
 *  - `extraer`: resuelve la `extraccion_indicada` y deja la pieza `extraida`
 *    (completado). Es la regla «al cumplirse una extracción indicada, la pieza queda
 *    extraída»: la exodoncia documentada, distinta de la agenesia (`ausente`). La
 *    corona y el conducto que hubiera caen con el diente.
 *  - `rehabilitar`: exige un `implante` vigente, resuelve la ausencia (`ausente` o
 *    `extraida`) y deja una `corona` (completado): fase quirúrgica → rehabilitada.
 *
 * El origen se marca `resolved_at` con su entrada `resuelto` en el histórico (no se
 * borra: es la prueba de que existió) y el destino se aplica con `applyFinding`, así
 * que hereda la convivencia y la validez de estado de cualquier hallazgo.
 */
export const completeProcedure = async (
  db: OdontogramDb,
  patientId: string,
  input: CompleteProcedureInput,
  actor: ActorContext,
): Promise<OdontogramMutationResult> => {
  const transicion = PROCEDURE_TRANSITIONS[input.procedure];

  const outcome = await db.transaction(async (tx): Promise<ApplyOutcome> => {
    const odontogram = await findOdontogramByPatient(tx, patientId);
    if (odontogram === null) throw new NotFoundError('El paciente todavía no tiene odontograma');

    const context = eventContext(odontogram, patientId, actor);
    const at = new Date();
    const motivo = `${PROCEDURE_LABELS[input.procedure].toLowerCase()}: ${conditionsLabel(transicion.from)} → ${conditionLabel(transicion.to)}`;

    // 0) Rehabilitar sin implante no existe: una corona sobre implante necesita el
    //    tornillo que la sostiene (spec §5).
    if (transicion.requiresImplante) {
      const implantes = await findActiveByCondition(
        tx,
        odontogram.id,
        input.toothNumber,
        'implante',
        null,
      );
      if (implantes.length === 0) {
        throw new ConflictError(
          `La pieza ${input.toothNumber} no tiene un implante vigente: la corona sobre implante lo exige`,
          {
            extensions: {
              toothNumber: input.toothNumber,
              procedure: input.procedure,
              requires: 'implante',
            },
          },
        );
      }
    }

    // 1) Origen del procedimiento: por cara (`obturar`, o todas si no se indica) o de
    //    pieza completa (`extraer`, `rehabilitar`).
    const origenes =
      transicion.scope === 'whole'
        ? await findActiveByCondition(tx, odontogram.id, input.toothNumber, transicion.from, null)
        : await findActiveByCondition(
            tx,
            odontogram.id,
            input.toothNumber,
            transicion.from,
            input.surface ?? 'any',
          );

    if (origenes.length === 0) {
      throw new ConflictError(
        `La pieza ${input.toothNumber} no tiene «${conditionsLabel(transicion.from)}» que cumplir`,
        {
          extensions: {
            toothNumber: input.toothNumber,
            procedure: input.procedure,
            from: transicion.from,
          },
        },
      );
    }

    // 2) Al **extraer**, la corona y el conducto caen con el diente: se resuelven para
    //    que no queden vigentes contra el `ausente` que entra (serían incompatibles).
    if (input.procedure === 'extraer') {
      for (const condition of ['corona', 'endodoncia'] as const) {
        const caen = await findActiveByCondition(
          tx,
          odontogram.id,
          input.toothNumber,
          condition,
          null,
        );
        for (const row of caen) {
          if (origenes.some((origen) => origen.id === row.id)) continue;
          await resolveFinding(tx, context, row, {
            reason: 'la extracción deja la pieza extraída',
            at,
          });
        }
      }
    }

    // 3) Se resuelven los orígenes…
    for (const row of origenes) {
      await resolveFinding(tx, context, row, { reason: motivo, at });
    }

    // 4) …y se aplica el destino: una fila por cara de origen, o una de pieza completa.
    const caras: (ToothSurface | null)[] =
      transicion.scope === 'whole' ? [null] : origenes.map((row) => row.surface as ToothSurface);

    let actual = odontogram;
    const resueltas = new Set<ToothSurface>();
    for (const surface of caras) {
      const applied = await applyFinding(
        tx,
        actual,
        patientId,
        {
          toothNumber: input.toothNumber,
          surface,
          condition: transicion.to,
          state: transicion.toState,
          notes: input.notes,
          sessionId: input.sessionId,
        },
        actor,
      );
      actual = applied.odontogram;
      for (const cara of applied.resolvedSurfaces) resueltas.add(cara);
    }

    return {
      odontogram: await syncDentition(tx, actual),
      unchanged: false,
      resolvedSurfaces: [...resueltas].sort(byFormOrder),
    };
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
      odontogram: await syncDentition(tx, await touchOdontogram(tx, odontogram.id, at)),
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
      odontogram: await syncDentition(tx, await touchOdontogram(tx, odontogram.id, at)),
      unchanged: false,
      resolvedSurfaces: [],
    };
  });

  return toMutationResult(db, outcome);
};

/* ── Prótesis removibles (PPR/PRT) ─────────────────────────────────────────── */

/** Lo que se audita de una prótesis: tipo, arcada, tramo y estado. */
type ProsthesisSnapshot = {
  kind: ProsthesisKind;
  arch: ProsthesisArch;
  toothNumbers: number[];
  state: ClinicalState;
};

const snapshotOfProsthesis = (row: ProsthesisRow): ProsthesisSnapshot => ({
  kind: row.kind as ProsthesisKind,
  arch: row.arch as ProsthesisArch,
  toothNumbers: row.toothNumbers,
  state: row.state as ClinicalState,
});

/** «prótesis parcial removible · maxilar superior (indicada)». */
const describeProsthesis = (snapshot: ProsthesisSnapshot): string =>
  `${PROSTHESIS_KIND_LABELS[snapshot.kind].toLowerCase()} · ${PROSTHESIS_ARCH_LABELS[
    snapshot.arch
  ].toLowerCase()} (${CLINICAL_STATE_LABELS[snapshot.state].toLowerCase()})`;

const prosthesisChangedFields = (snapshot: ProsthesisSnapshot): string[] => [
  'prótesis',
  PROSTHESIS_KIND_LABELS[snapshot.kind].toLowerCase(),
  PROSTHESIS_ARCH_LABELS[snapshot.arch].toLowerCase(),
];

/** `true` si las dos listas de piezas traen el mismo conjunto. */
const sameToothNumbers = (a: readonly number[], b: readonly number[]): boolean => {
  if (a.length !== b.length) return false;
  const ordenadoA = [...a].sort((x, y) => x - y);
  const ordenadoB = [...b].sort((x, y) => x - y);
  return ordenadoA.every((value, index) => value === ordenadoB[index]);
};

const writeProsthesisHistory = async (
  db: OdontogramDb,
  input: {
    context: FindingEventContext;
    prosthesisId: string | null;
    snapshot: ProsthesisSnapshot;
    event: 'registrado' | 'actualizado' | 'eliminado';
    reason: string | null;
    notes: string | null;
    sessionId: string | null;
    occurredAt: Date;
  },
): Promise<void> => {
  await db.insert(prosthesisHistory).values({
    odontogramId: input.context.odontogramId,
    prosthesisId: input.prosthesisId,
    patientId: input.context.patientId,
    kind: input.snapshot.kind,
    arch: input.snapshot.arch,
    toothNumbers: input.snapshot.toothNumbers,
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

const publishProsthesisEvent = async (
  db: OdontogramDb,
  context: FindingEventContext,
  snapshot: ProsthesisSnapshot,
  change: {
    topic: EventTopic;
    action: AuditAction;
    summary: string;
    changedFields: string[];
    before: ProsthesisSnapshot | null;
    after: ProsthesisSnapshot | null;
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
      prosthesis: {
        kind: snapshot.kind,
        arch: snapshot.arch,
        toothNumbers: snapshot.toothNumbers,
        state: snapshot.state,
      },
    },
  });
};

/**
 * Registra (o corrige) una **prótesis removible** (PPR/PRT). Crea el odontograma si
 * es el primero. La **PRT** se normaliza a la arcada completa (las 16 piezas): el
 * cliente no tiene que enumerarlas.
 *
 * Una arcada admite **varias prótesis** mientras no compartan piezas: dos o más
 * parciales de tramos distintos sí; la total, que cubre la arcada entera, no convive
 * con ninguna. La clave natural para «actualizar en vez de duplicar» es **tipo +
 * arcada + tramo**: volver a registrar la misma prótesis la actualiza.
 */
export const recordProsthesis = async (
  db: OdontogramDb,
  patientId: string,
  input: RecordProsthesisInput,
  actor: ActorContext,
): Promise<OdontogramMutationResult> => {
  const toothNumbers =
    input.kind === 'prt'
      ? [...archTeeth(input.arch)]
      : [...input.toothNumbers].sort((a, b) => a - b);

  const outcome = await db.transaction(async (tx): Promise<ApplyOutcome> => {
    const odontogram = await ensureOdontogram(tx, patientId, 'permanente', actor);
    const context = eventContext(odontogram, patientId, actor);
    const at = new Date();
    const snapshot: ProsthesisSnapshot = {
      kind: input.kind,
      arch: input.arch,
      toothNumbers,
      state: input.state,
    };

    const vigentes = await tx
      .select()
      .from(prostheses)
      .where(
        and(
          eq(prostheses.odontogramId, odontogram.id),
          eq(prostheses.arch, input.arch),
          isNull(prostheses.resolvedAt),
        ),
      );

    // La que se está corrigiendo: mismo tipo y mismo tramo (actualiza, no duplica).
    const existente = vigentes.find(
      (fila) => fila.kind === input.kind && sameToothNumbers(fila.toothNumbers, toothNumbers),
    );

    // Una arcada admite varias prótesis **mientras no compartan piezas**. La total
    // cubre la arcada entera, así que choca con cualquier otra; dos parciales, solo si
    // sus tramos se pisan. Se pide quitar la que estorba (la ficha muestra el mensaje).
    const choque = vigentes.find(
      (fila) => fila.id !== existente?.id && prosthesesOverlap(fila.toothNumbers, toothNumbers),
    );

    if (choque !== undefined) {
      const compartidas = sharedTeeth(choque.toothNumbers, toothNumbers);
      throw new ConflictError(
        `La ${PROSTHESIS_KIND_LABELS[choque.kind as ProsthesisKind].toLowerCase()} de la arcada «${
          PROSTHESIS_ARCH_LABELS[input.arch]
        }» ya cubre ${compartidas.length === 1 ? 'la pieza' : 'las piezas'} ${compartidas.join(
          ', ',
        )}: quite primero esa prótesis o elija otras piezas`,
        {
          extensions: {
            arch: input.arch,
            conflictingId: choque.id,
            conflictingKind: choque.kind,
            overlappingTeeth: compartidas,
          },
        },
      );
    }

    // Sin cambios no se escribe ni se audita.
    if (
      existente !== undefined &&
      existente.state === input.state &&
      sameToothNumbers(existente.toothNumbers, toothNumbers) &&
      (existente.notes ?? null) === input.notes
    ) {
      return { odontogram, unchanged: true, resolvedSurfaces: [] };
    }

    if (existente !== undefined) {
      await tx
        .update(prostheses)
        .set({
          toothNumbers,
          state: input.state,
          notes: input.notes,
          recordedInSessionId: input.sessionId,
          updatedAt: at,
        })
        .where(eq(prostheses.id, existente.id));

      await writeProsthesisHistory(tx, {
        context,
        prosthesisId: existente.id,
        snapshot,
        event: 'actualizado',
        reason: 'prótesis removible actualizada',
        notes: input.notes,
        sessionId: input.sessionId,
        occurredAt: at,
      });
      await publishProsthesisEvent(tx, context, snapshot, {
        topic: EVENT_TOPICS.prosthesisRecorded,
        action: 'prosthesis_recorded',
        summary: `${describeProsthesis(snapshot)} · actualizada`,
        changedFields: prosthesisChangedFields(snapshot),
        before: snapshotOfProsthesis(existente),
        after: snapshot,
      });
    } else {
      const inserted = await tx
        .insert(prostheses)
        .values({
          odontogramId: odontogram.id,
          patientId,
          kind: input.kind,
          arch: input.arch,
          toothNumbers,
          state: input.state,
          notes: input.notes,
          recordedBy: actor.actorId,
          recordedByUsername: actor.actorUsername,
          recordedInSessionId: input.sessionId,
        })
        .returning();
      const row = inserted[0];
      if (row === undefined) throw new NotFoundError('No se pudo registrar la prótesis');

      await writeProsthesisHistory(tx, {
        context,
        prosthesisId: row.id,
        snapshot,
        event: 'registrado',
        reason: 'prótesis removible registrada',
        notes: input.notes,
        sessionId: input.sessionId,
        occurredAt: at,
      });
      await publishProsthesisEvent(tx, context, snapshot, {
        topic: EVENT_TOPICS.prosthesisRecorded,
        action: 'prosthesis_recorded',
        summary: `${describeProsthesis(snapshot)} · registrada`,
        changedFields: prosthesisChangedFields(snapshot),
        before: null,
        after: snapshot,
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

/** Retira una prótesis removible: histórico `eliminado` + evento + fila fuera. */
export const removeProsthesis = async (
  db: OdontogramDb,
  patientId: string,
  id: string,
  actor: ActorContext,
): Promise<OdontogramMutationResult> => {
  const outcome = await db.transaction(async (tx): Promise<ApplyOutcome> => {
    const odontogram = await findOdontogramByPatient(tx, patientId);
    if (odontogram === null) throw new NotFoundError('El paciente todavía no tiene odontograma');

    const rows = await tx
      .select()
      .from(prostheses)
      .where(and(eq(prostheses.id, id), eq(prostheses.odontogramId, odontogram.id)))
      .limit(1);
    const row = rows[0];
    if (row === undefined || row.resolvedAt !== null) {
      return { odontogram, unchanged: true, resolvedSurfaces: [] };
    }

    const context = eventContext(odontogram, patientId, actor);
    const at = new Date();
    const snapshot = snapshotOfProsthesis(row);

    await tx.delete(prostheses).where(eq(prostheses.id, row.id));
    await writeProsthesisHistory(tx, {
      context,
      prosthesisId: null,
      snapshot,
      event: 'eliminado',
      reason: 'prótesis removible retirada',
      notes: row.notes,
      sessionId: row.recordedInSessionId,
      occurredAt: at,
    });
    await publishProsthesisEvent(tx, context, snapshot, {
      topic: EVENT_TOPICS.prosthesisRemoved,
      action: 'prosthesis_removed',
      summary: `${describeProsthesis(snapshot)} · eliminada`,
      changedFields: prosthesisChangedFields(snapshot),
      before: snapshot,
      after: null,
      reason: 'prótesis removible retirada',
    });

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
