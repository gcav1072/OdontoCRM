import {
  PERIODONTAL_SCHEMA_VERSION,
  PERIODONTAL_TEETH,
  buildPeriodontalChart,
  comparePeriodontalCharts,
  emptyPeriodontalRiskFactors,
  findPeriodontalTooth,
  periodontalMetrics,
  type AuditAction,
  type CreatePeriodontalExamInput,
  type FinalizePeriodontalExamInput,
  type FinalizePeriodontalExamResult,
  type PeriodontalChart,
  type PeriodontalComparisonResult,
  type PeriodontalDiagnosis,
  type PeriodontalExamDetail,
  type PeriodontalExamListQuery,
  type PeriodontalExamListResult,
  type PeriodontalExamLookup,
  type PeriodontalExamMutationResult,
  type PeriodontalExamSource,
  type PeriodontalExamStatus,
  type PeriodontalExamSummary,
  type PeriodontalInternalSummary,
  type PeriodontalMetrics,
  type PeriodontalPatientSnapshot,
  type PeriodontalRiskFactors,
  type PrintPeriodontalExamResult,
  type SavePeriodontalExamInput,
} from '@odontocrm/contracts';
import { EVENT_TOPICS, type EventTopic } from '@odontocrm/events';
import { ConflictError, NotFoundError } from '@odontocrm/kernel';
import { and, desc, eq, isNull, ne, sql } from 'drizzle-orm';

import type { OdontogramDb } from '../db/client.js';
import {
  odontograms,
  periodontogramExams,
  toothFindings,
  type PeriodontogramExamRow,
} from '../db/schema.js';
import type { ActorContext } from '../shared/context.js';
import { auditPayload, publish } from '../shared/events.js';

/**
 * Periodontograma (v1.1): servicio del **documento de examen**.
 *
 * El odontograma es un estado vigente que evoluciona fila a fila; el periodontograma
 * es una foto biométrica fechada: se sondan 192 sitios, se firma y se compara contra
 * exámenes anteriores. Por eso el documento se guarda entero en `teeth_data` (JSONB)
 * y su ciclo de vida es el de un papel clínico (ADR 0071):
 *
 *  - **Un solo borrador abierto por paciente**: se nace del odontograma vigente, del
 *    examen anterior o en blanco, y para abrir otro hay que cerrar o descartar el que
 *    existe.
 *  - **Guardado optimista**: la revisión vigente viaja en el cuerpo; si no coincide,
 *    409 con `currentRevision`. Sin cambios no se escribe ni se audita (el
 *    autoguardado repite el documento cada pocos segundos).
 *  - **Finalizar es inmutable**: a partir del cierre no se edita ni se descarta; la
 *    corrección es un examen nuevo.
 *  - **La base es el último guardián**: el índice parcial del borrador y los CHECK de
 *    32 piezas y de coherencia de cierre se cumplen aunque alguien escriba a mano.
 *
 * Los eventos viajan por el outbox con `entityType: 'periodontogram'` y llevan el
 * resumen (KPIs y diff legible), nunca la boca entera: la auditoría no se llena de
 * 192 mediciones por guardado.
 */

/* ── Etiquetas y ayudas de presentación ───────────────────────────────────── */

/** De dónde nace la boca de un examen nuevo, en la línea de auditoría. */
const SOURCE_LABELS: Readonly<Record<PeriodontalExamSource, string>> = {
  odontograma: 'el odontograma',
  anterior: 'el examen anterior',
  blanco: 'una boca en blanco',
};

const isoOrNull = (value: Date | null): string | null =>
  value === null ? null : value.toISOString();

/** Número con coma decimal, como se escribe en español («12,5»). */
const decimalText = (value: number): string => String(value).replace('.', ',');

const formatCount = (count: number, singular: string, plural: string): string =>
  `${String(count)} ${count === 1 ? singular : plural}`;

/**
 * Fecha clínica de hoy en la **zona local del servidor**, no en UTC.
 *
 * Un examen abierto a las 21:00 en Caracas no puede fecharse mañana solo porque en
 * UTC ya pasó la medianoche. La fecha del documento es la del consultorio.
 */
export const todayIsoDate = (now: Date = new Date()): string => {
  const year = String(now.getFullYear()).padStart(4, '0');
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `2026-10-18` → `18/10/2026` (la fecha que se lee en la auditoría). */
export const formatExamDate = (isoDate: string): string => {
  const match = ISO_DATE.exec(isoDate);
  if (match === null) return isoDate;
  const [, year, month, day] = match;
  if (year === undefined || month === undefined || day === undefined) return isoDate;
  return `${day}/${month}/${year}`;
};

/**
 * Línea legible del examen para la auditoría («Periodontograma del 18/10/2026 ·
 * borrador · BOP 12,5 % · 6 sitios sondados · estadio 3 · grado B»). Es el resumen
 * que guarda la auditoría, no las mediciones.
 */
export const describeExam = (
  exam: Pick<PeriodontalExamSummary, 'status' | 'examDate' | 'metrics' | 'diagnosis'>,
): string => {
  const partes: string[] = [
    `Periodontograma del ${formatExamDate(exam.examDate)}`,
    exam.status === 'finalizado' ? 'finalizado' : 'borrador',
  ];

  if (exam.metrics.sitesProbed === 0) {
    partes.push('sin sitios sondados');
  } else {
    partes.push(`BOP ${decimalText(exam.metrics.bopPercent ?? 0)} %`);
    partes.push(formatCount(exam.metrics.sitesProbed, 'sitio sondado', 'sitios sondados'));
  }

  if (exam.metrics.retreatmentSites > 0) {
    partes.push(
      formatCount(
        exam.metrics.retreatmentSites,
        'sitio de retratamiento',
        'sitios de retratamiento',
      ),
    );
  }

  if (exam.diagnosis !== null) {
    partes.push(`estadio ${String(exam.diagnosis.stage)} · grado ${exam.diagnosis.grade}`);
  }

  return partes.join(' · ');
};

/* ── Comparación de documentos (puro: se prueba sin base de datos) ─────────── */

/** Lo que compone el documento clínico de un examen, sin los metadatos de la fila. */
export interface PeriodontalDocument {
  examDate: string;
  chart: PeriodontalChart;
  riskFactors: PeriodontalRiskFactors;
  diagnosis: PeriodontalDiagnosis | null;
  notes: string | null;
}

/**
 * Igualdad por contenido para documentos JSON.
 *
 * No sirve `JSON.stringify`: Postgres guarda las claves de `jsonb` en su propio
 * orden, así que dos documentos idénticos pueden serializarse distinto y el
 * autoguardado creería que hay cambios (escribiendo y auditando de más).
 */
const sameJson = (left: unknown, right: unknown): boolean => {
  if (left === right) return true;

  if (Array.isArray(left)) {
    if (!Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => sameJson(value, right[index]));
  }

  if (typeof left !== 'object' || left === null) return false;
  if (typeof right !== 'object' || right === null || Array.isArray(right)) return false;

  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  if (leftKeys.length !== Object.keys(rightRecord).length) return false;

  return leftKeys.every((key) => key in rightRecord && sameJson(leftRecord[key], rightRecord[key]));
};

/**
 * Campos legibles que cambiaron entre dos documentos: las **piezas tocadas** (una
 * entrada por FDI) y, después, los campos del documento. Es lo que se guarda en
 * `changedFields` de la auditoría.
 */
export const changedFieldsBetween = (
  previous: PeriodontalDocument,
  next: PeriodontalDocument,
): string[] => {
  const changedFields: string[] = [];

  for (const fdi of PERIODONTAL_TEETH) {
    const anterior = findPeriodontalTooth(previous.chart, fdi);
    const actual = findPeriodontalTooth(next.chart, fdi);
    if (!sameJson(anterior, actual)) changedFields.push(`pieza ${String(fdi)}`);
  }

  if (!sameJson(previous.riskFactors, next.riskFactors)) changedFields.push('factores de riesgo');
  if (!sameJson(previous.diagnosis, next.diagnosis)) changedFields.push('diagnóstico');
  if (previous.notes !== next.notes) changedFields.push('notas');
  if (previous.examDate !== next.examDate) changedFields.push('fecha');

  return changedFields;
};

/**
 * `true` si guardar `next` no cambiaría el documento. Se comprueba **antes** que la
 * revisión: si el contenido es idéntico no hay nada que guardar ni por qué dar 409
 * (el autoguardado llega tarde con la revisión anterior y no debe molestar).
 */
export const samePeriodontalDocument = (
  previous: PeriodontalDocument,
  next: PeriodontalDocument,
): boolean => changedFieldsBetween(previous, next).length === 0;

/* ── Mapeo de filas a DTOs (puro: se prueba sin base de datos) ─────────────── */

export const toExamSummary = (row: PeriodontogramExamRow): PeriodontalExamSummary => ({
  id: row.id,
  patientId: row.patientId,
  status: row.status as PeriodontalExamStatus,
  examDate: row.examDate,
  revision: row.revision,
  metrics: row.metrics,
  diagnosis: row.diagnosis,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
  finalizedAt: isoOrNull(row.finalizedAt),
  recordedByUsername: row.recordedByUsername,
  finalizedByUsername: row.finalizedByUsername,
  printCount: row.printCount,
  lastPrintedAt: isoOrNull(row.lastPrintedAt),
  notes: row.notes,
});

export const toExamDetail = (row: PeriodontogramExamRow): PeriodontalExamDetail => ({
  ...toExamSummary(row),
  chart: row.teethData,
  riskFactors: row.riskFactors,
  schemaVersion: row.schemaVersion,
  sessionId: row.sessionId,
});

const documentOfRow = (row: PeriodontogramExamRow): PeriodontalDocument => ({
  examDate: row.examDate,
  chart: row.teethData,
  riskFactors: row.riskFactors,
  diagnosis: row.diagnosis,
  notes: row.notes,
});

/* ── Errores de dominio ────────────────────────────────────────────────────── */

const examNotFound = (): NotFoundError =>
  new NotFoundError('El periodontograma no existe o pertenece a otro paciente');

const draftConflict = (existingExamId: string | null): ConflictError =>
  new ConflictError(
    'El paciente ya tiene un periodontograma en borrador: ciérralo o descártalo antes de abrir otro',
    { extensions: { existingExamId } },
  );

const revisionConflict = (currentRevision: number): ConflictError =>
  new ConflictError(
    'El periodontograma cambió desde que lo abriste: recarga el examen y vuelve a guardar',
    { extensions: { currentRevision } },
  );

const finalizedConflict = (row: PeriodontogramExamRow): ConflictError =>
  new ConflictError(
    'El periodontograma está finalizado y no se edita: abre un examen nuevo a partir de él para corregirlo',
    { extensions: { examId: row.id, status: row.status } },
  );

/** `true` si el error de Postgres es una violación de índice único (código 23505). */
const isUniqueViolation = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) return false;
  return (error as { code?: unknown }).code === '23505';
};

/* ── Eventos de dominio ────────────────────────────────────────────────────── */

/** Resumen que viaja en `before`/`after` de la auditoría (nunca la boca entera). */
type PeriodontalAuditSnapshot = {
  status: PeriodontalExamStatus;
  revision: number;
  metrics: PeriodontalMetrics;
  diagnosis: PeriodontalDiagnosis | null;
};

const auditSnapshotOfRow = (row: PeriodontogramExamRow): PeriodontalAuditSnapshot => ({
  status: row.status as PeriodontalExamStatus,
  revision: row.revision,
  metrics: row.metrics,
  diagnosis: row.diagnosis,
});

/**
 * KPIs que viajan en el evento para el reporting futuro: lo que se consulta sin
 * abrir la boca (BOP, placa, bolsas, retratamiento, piezas perdidas e implantes).
 */
const reportMetrics = (metrics: PeriodontalMetrics): Record<string, unknown> => ({
  teethPresent: metrics.teethPresent,
  teethMissing: metrics.teethMissing,
  implants: metrics.implants,
  sitesProbed: metrics.sitesProbed,
  bopPercent: metrics.bopPercent,
  plaquePercent: metrics.plaquePercent,
  deepestPd: metrics.deepestPd,
  worstCal: metrics.worstCal,
  worstInterproximalCal: metrics.worstInterproximalCal,
  pocketsGte4: metrics.pocketsGte4,
  pocketsGte5: metrics.pocketsGte5,
  pocketsGte6: metrics.pocketsGte6,
  retreatmentSites: metrics.retreatmentSites,
  furcationLesions: metrics.furcationLesions,
  mobilityGte2: metrics.mobilityGte2,
});

interface ExamEventInput {
  topic: EventTopic;
  action: AuditAction;
  patientId: string;
  examId: string;
  /** Estado del examen después del cambio (en el descarte, el del borrador borrado). */
  row: PeriodontogramExamRow;
  summary: string;
  changedFields: string[];
  before: PeriodontalAuditSnapshot | null;
  after: PeriodontalAuditSnapshot | null;
  /** Datos extra del hecho (p. ej. `source` al abrir el examen). */
  extra?: Record<string, unknown>;
}

/**
 * Publica el evento en el **outbox** dentro de la transacción del cambio: la carga
 * de auditoría (identity la registra en `/auditoria`) más el resumen para reporting.
 * El descarte usa el tópico de guardado porque es un hecho del borrador; lo que
 * discrimina la acción es `action` (`periodontogram_discarded`).
 */
const publishExamEvent = async (
  db: Pick<OdontogramDb, 'insert'>,
  actor: ActorContext,
  input: ExamEventInput,
): Promise<void> => {
  await publish(db, {
    topic: input.topic,
    aggregateId: input.examId,
    actor,
    payload: {
      ...auditPayload({
        entityId: input.examId,
        action: input.action,
        summary: input.summary,
        changedFields: input.changedFields,
        before: input.before,
        after: input.after,
        actor,
      }),
      // `auditPayload` fija el tipo del odontograma; este es otro documento y la
      // auditoría lo filtra por `entityType: 'periodontogram'` (ADR 0071 §9).
      entityType: 'periodontogram',
      patientId: input.patientId,
      examId: input.examId,
      status: input.row.status as PeriodontalExamStatus,
      examDate: input.row.examDate,
      metrics: reportMetrics(input.row.metrics),
      diagnosis: input.row.diagnosis,
      ...(input.extra ?? {}),
    },
  });
};

/* ── Lectura de filas ──────────────────────────────────────────────────────── */

const findExamRow = async (
  db: OdontogramDb,
  patientId: string,
  examId: string,
): Promise<PeriodontogramExamRow | null> => {
  const rows = await db
    .select()
    .from(periodontogramExams)
    .where(and(eq(periodontogramExams.patientId, patientId), eq(periodontogramExams.id, examId)))
    .limit(1);
  return rows[0] ?? null;
};

/** El borrador abierto del paciente, si lo hay (el índice único garantiza uno solo). */
const findOpenDraft = async (
  db: OdontogramDb,
  patientId: string,
): Promise<PeriodontogramExamRow | null> => {
  const rows = await db
    .select()
    .from(periodontogramExams)
    .where(
      and(eq(periodontogramExams.patientId, patientId), eq(periodontogramExams.status, 'borrador')),
    )
    .orderBy(desc(periodontogramExams.createdAt))
    .limit(1);
  return rows[0] ?? null;
};

/**
 * Boca nueva marcada con lo que el odontograma ya sabe: piezas ausentes/extraídas y
 * con implante. **No copia mediciones**: un examen nuevo no puede heredar cifras que
 * hoy no se sondaron (ADR 0071 §3).
 */
const chartFromOdontogram = async (
  db: OdontogramDb,
  patientId: string,
): Promise<PeriodontalChart> => {
  const odontogramRows = await db
    .select({ id: odontograms.id })
    .from(odontograms)
    .where(eq(odontograms.patientId, patientId))
    .limit(1);
  const odontogram = odontogramRows[0];
  if (odontogram === undefined) return buildPeriodontalChart();

  const vigentes = await db
    .select({ toothNumber: toothFindings.toothNumber, condition: toothFindings.condition })
    .from(toothFindings)
    .where(and(eq(toothFindings.odontogramId, odontogram.id), isNull(toothFindings.resolvedAt)));

  const missing: number[] = [];
  const implants: number[] = [];

  for (const finding of vigentes) {
    // Las piezas temporales (51–85) no existen en el periodontograma; el ayudante del
    // contrato solo recorre las 32 permanentes, así que quedan fuera solas.
    if (finding.condition === 'ausente' || finding.condition === 'extraida') {
      missing.push(finding.toothNumber);
    } else if (finding.condition === 'implante') {
      implants.push(finding.toothNumber);
    }
  }

  return buildPeriodontalChart({ missing, implants });
};

/** Boca del examen nuevo según su origen; la clonación es copia **profunda**. */
const chartForNewExam = async (
  db: OdontogramDb,
  patientId: string,
  input: CreatePeriodontalExamInput,
): Promise<PeriodontalChart> => {
  if (input.source === 'anterior') {
    if (input.previousExamId === null) {
      // El contrato ya lo exige en el borde; el guardián evita un error confuso si
      // alguien llama al servicio sin validar.
      throw new ConflictError('Para clonar un examen anterior hay que indicar cuál');
    }
    const previous = await findExamRow(db, patientId, input.previousExamId);
    if (previous === null) {
      throw new NotFoundError('El periodontograma anterior no existe o pertenece a otro paciente');
    }
    // Copia profunda: el clon es un examen independiente; editar el nuevo no puede
    // tocar las mediciones del anterior (que además suele estar finalizado).
    return structuredClone(previous.teethData);
  }

  if (input.source === 'blanco') return buildPeriodontalChart();

  return chartFromOdontogram(db, patientId);
};

/* ── Creación ──────────────────────────────────────────────────────────────── */

/**
 * Abre un examen en **borrador**. Solo puede haber uno abierto por paciente: la
 * comprobación previa da el 409 amable y el índice parcial de la base cubre la
 * carrera de dos pestañas abriendo a la vez.
 */
export const createExam = async (
  db: OdontogramDb,
  patientId: string,
  input: CreatePeriodontalExamInput,
  actor: ActorContext,
): Promise<PeriodontalExamMutationResult> => {
  let created: PeriodontogramExamRow;

  try {
    created = await db.transaction(async (tx) => {
      const existing = await findOpenDraft(tx, patientId);
      if (existing !== null) throw draftConflict(existing.id);

      const chart = await chartForNewExam(tx, patientId, input);
      const riskFactors = emptyPeriodontalRiskFactors();
      const metrics = periodontalMetrics(chart);
      const examDate = input.examDate ?? todayIsoDate();

      const inserted = await tx
        .insert(periodontogramExams)
        .values({
          patientId,
          status: 'borrador',
          examDate,
          teethData: chart,
          riskFactors,
          diagnosis: null,
          metrics,
          notes: input.notes,
          revision: 0,
          schemaVersion: PERIODONTAL_SCHEMA_VERSION,
          sessionId: input.sessionId,
          recordedBy: actor.actorId,
          recordedByUsername: actor.actorUsername,
        })
        .returning();

      const row = inserted[0];
      if (row === undefined) throw new NotFoundError('No se pudo abrir el periodontograma');

      await publishExamEvent(tx, actor, {
        topic: EVENT_TOPICS.periodontalExamSaved,
        action: 'periodontogram_created',
        patientId,
        examId: row.id,
        row,
        summary: `${describeExam(toExamDetail(row))} · abierto desde ${SOURCE_LABELS[input.source]}`,
        changedFields: [],
        before: null,
        after: auditSnapshotOfRow(row),
        extra: { source: input.source },
      });

      return row;
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const raced = await findOpenDraft(db, patientId);
    throw draftConflict(raced?.id ?? null);
  }

  return { exam: toExamDetail(created), unchanged: false };
};

/* ── Listado y lectura ─────────────────────────────────────────────────────── */

/** Exámenes del paciente, del más reciente al más antiguo. */
export const listExams = async (
  db: OdontogramDb,
  patientId: string,
  query: PeriodontalExamListQuery,
): Promise<PeriodontalExamListResult> => {
  const filters = [eq(periodontogramExams.patientId, patientId)];
  if (query.status !== undefined) filters.push(eq(periodontogramExams.status, query.status));

  const rows = await db
    .select()
    .from(periodontogramExams)
    .where(and(...filters))
    .orderBy(desc(periodontogramExams.createdAt), desc(periodontogramExams.id))
    .limit(query.limit);

  return { items: rows.map(toExamSummary) };
};

/**
 * Último examen del paciente (`exists: false` no es un error: puede no tener
 * periodontograma todavía) y, si existe, el último finalizado anterior para ofrecer
 * la comparación. El snapshot del paciente lo aporta la ruta.
 */
export const getLatestExam = async (
  db: OdontogramDb,
  patientId: string,
  patient: PeriodontalPatientSnapshot | null = null,
): Promise<PeriodontalExamLookup> => {
  const latestRows = await db
    .select()
    .from(periodontogramExams)
    .where(eq(periodontogramExams.patientId, patientId))
    .orderBy(desc(periodontogramExams.createdAt), desc(periodontogramExams.id))
    .limit(1);
  const latest = latestRows[0];
  if (latest === undefined) return { exists: false, patientId, patient };

  const previousRows = await db
    .select()
    .from(periodontogramExams)
    .where(
      and(
        eq(periodontogramExams.patientId, patientId),
        eq(periodontogramExams.status, 'finalizado'),
        ne(periodontogramExams.id, latest.id),
      ),
    )
    .orderBy(desc(periodontogramExams.createdAt), desc(periodontogramExams.id))
    .limit(1);
  const previous = previousRows[0];

  return {
    exists: true,
    // La ficha viaja con el examen: la página de impresión arma el membrete sin pedir
    // `clinical:read` ni una llamada extra al servicio de pacientes.
    patient,
    exam: toExamDetail(latest),
    previousFinalized: previous === undefined ? null : toExamSummary(previous),
  };
};

export const getExam = async (
  db: OdontogramDb,
  patientId: string,
  examId: string,
): Promise<PeriodontalExamDetail> => {
  const row = await findExamRow(db, patientId, examId);
  if (row === null) throw examNotFound();
  return toExamDetail(row);
};

/* ── Guardado optimista ────────────────────────────────────────────────────── */

/**
 * Guarda el borrador completo con la **revisión vigente**. El UPDATE lleva la
 * revisión en el `WHERE`: si otra pestaña guardó antes, no se pisa nada y se
 * responde 409 con la revisión actual para que la interfaz recargue.
 */
export const saveExam = async (
  db: OdontogramDb,
  patientId: string,
  examId: string,
  input: SavePeriodontalExamInput,
  actor: ActorContext,
): Promise<PeriodontalExamMutationResult> => {
  const outcome = await db.transaction(
    async (tx): Promise<{ row: PeriodontogramExamRow; unchanged: boolean }> => {
      const row = await findExamRow(tx, patientId, examId);
      if (row === null) throw examNotFound();
      if (row.status === 'finalizado') throw finalizedConflict(row);

      const previous = documentOfRow(row);
      const next: PeriodontalDocument = {
        examDate: input.examDate,
        chart: input.chart,
        riskFactors: input.riskFactors,
        diagnosis: input.diagnosis,
        notes: input.notes,
      };

      // La revisión manda antes que el contenido: un autoguardado con la revisión
      // vieja se rechaza aunque el cuerpo parezca igual, porque el cliente está
      // trabajando sobre una foto que ya no es la vigente (y la interfaz debe recargar).
      if (row.revision !== input.revision) throw revisionConflict(row.revision);

      // Sin cambios no se escribe ni se audita: el autoguardado repite mucho.
      if (samePeriodontalDocument(previous, next)) return { row, unchanged: true };

      const metrics = periodontalMetrics(input.chart);
      const at = new Date();
      const updated = await tx
        .update(periodontogramExams)
        .set({
          examDate: input.examDate,
          teethData: input.chart,
          riskFactors: input.riskFactors,
          diagnosis: input.diagnosis,
          notes: input.notes,
          metrics,
          revision: row.revision + 1,
          updatedAt: at,
        })
        .where(
          and(
            eq(periodontogramExams.id, examId),
            eq(periodontogramExams.patientId, patientId),
            eq(periodontogramExams.status, 'borrador'),
            eq(periodontogramExams.revision, input.revision),
          ),
        )
        .returning();

      const saved = updated[0];
      if (saved === undefined) {
        // Otra pestaña guardó entre la lectura y el UPDATE: se le dice cuál es la
        // revisión vigente en vez de perder sus mediciones en silencio.
        const current = await findExamRow(tx, patientId, examId);
        if (current === null) throw examNotFound();
        if (current.status === 'finalizado') throw finalizedConflict(current);
        throw revisionConflict(current.revision);
      }

      await publishExamEvent(tx, actor, {
        topic: EVENT_TOPICS.periodontalExamSaved,
        action: 'periodontogram_updated',
        patientId,
        examId: saved.id,
        row: saved,
        summary: `${describeExam(toExamDetail(saved))} · actualizado`,
        changedFields: changedFieldsBetween(previous, next),
        before: auditSnapshotOfRow(row),
        after: auditSnapshotOfRow(saved),
      });

      return { row: saved, unchanged: false };
    },
  );

  return { exam: toExamDetail(outcome.row), unchanged: outcome.unchanged };
};

/* ── Cierre inmutable ──────────────────────────────────────────────────────── */

/**
 * Finaliza el examen: cierre **inmutable** con quién y cuándo. Es idempotente (si ya
 * estaba finalizado devuelve `alreadyFinalized: true`): reintentar el cierre no es un
 * error, la interfaz puede repetirlo sin miedo.
 */
export const finalizeExam = async (
  db: OdontogramDb,
  patientId: string,
  examId: string,
  input: FinalizePeriodontalExamInput,
  actor: ActorContext,
): Promise<FinalizePeriodontalExamResult> => {
  const outcome = await db.transaction(
    async (tx): Promise<{ row: PeriodontogramExamRow; alreadyFinalized: boolean }> => {
      const row = await findExamRow(tx, patientId, examId);
      if (row === null) throw examNotFound();
      if (row.status === 'finalizado') return { row, alreadyFinalized: true };
      if (row.revision !== input.revision) throw revisionConflict(row.revision);

      const at = new Date();
      const updated = await tx
        .update(periodontogramExams)
        .set({
          status: 'finalizado',
          finalizedAt: at,
          finalizedBy: actor.actorId,
          finalizedByUsername: actor.actorUsername,
          revision: row.revision + 1,
          updatedAt: at,
        })
        .where(
          and(
            eq(periodontogramExams.id, examId),
            eq(periodontogramExams.patientId, patientId),
            eq(periodontogramExams.status, 'borrador'),
            eq(periodontogramExams.revision, input.revision),
          ),
        )
        .returning();

      const finalized = updated[0];
      if (finalized === undefined) {
        // Se cerró (u otra pestaña guardó) entre la lectura y el UPDATE.
        const current = await findExamRow(tx, patientId, examId);
        if (current === null) throw examNotFound();
        if (current.status === 'finalizado') return { row: current, alreadyFinalized: true };
        throw revisionConflict(current.revision);
      }

      await publishExamEvent(tx, actor, {
        topic: EVENT_TOPICS.periodontalExamFinalized,
        action: 'periodontogram_finalized',
        patientId,
        examId: finalized.id,
        row: finalized,
        summary: `${describeExam(toExamDetail(finalized))} · cerrado`,
        changedFields: ['estado'],
        before: auditSnapshotOfRow(row),
        after: auditSnapshotOfRow(finalized),
      });

      return { row: finalized, alreadyFinalized: false };
    },
  );

  return { exam: toExamDetail(outcome.row), alreadyFinalized: outcome.alreadyFinalized };
};

/* ── Descarte, comparación e impresión ─────────────────────────────────────── */

/** Resultado de descartar un borrador: el examen que deja de existir. */
export interface DiscardPeriodontalExamResult {
  examId: string;
}

/**
 * Descarta el **borrador** (la única salida destructiva del ciclo de vida). Un
 * examen finalizado no se borra: es un documento firmado. El descarte queda
 * auditado con quién lo hizo y el resumen del documento que se tiró.
 */
export const discardDraft = async (
  db: OdontogramDb,
  patientId: string,
  examId: string,
  actor: ActorContext,
): Promise<DiscardPeriodontalExamResult> => {
  await db.transaction(async (tx) => {
    const row = await findExamRow(tx, patientId, examId);
    if (row === null) throw examNotFound();
    if (row.status === 'finalizado') throw finalizedConflict(row);

    const deleted = await tx
      .delete(periodontogramExams)
      .where(
        and(
          eq(periodontogramExams.id, examId),
          eq(periodontogramExams.patientId, patientId),
          eq(periodontogramExams.status, 'borrador'),
        ),
      )
      .returning({ id: periodontogramExams.id });

    if (deleted[0] === undefined) {
      // Lo finalizó otra pestaña entre la lectura y el DELETE.
      const current = await findExamRow(tx, patientId, examId);
      if (current === null) throw examNotFound();
      throw finalizedConflict(current);
    }

    await publishExamEvent(tx, actor, {
      topic: EVENT_TOPICS.periodontalExamSaved,
      action: 'periodontogram_discarded',
      patientId,
      examId,
      row,
      summary: `${describeExam(toExamDetail(row))} · borrador descartado`,
      changedFields: [],
      before: auditSnapshotOfRow(row),
      after: null,
    });
  });

  return { examId };
};

/**
 * Comparación longitudinal sitio a sitio (`?with=`): el examen anterior contra el
 * actual, con deltas de PS/NIC, bolsas nuevas o resueltas y piezas perdidas/ganadas.
 */
export const compareExams = async (
  db: OdontogramDb,
  patientId: string,
  examId: string,
  withExamId: string,
): Promise<PeriodontalComparisonResult> => {
  const current = await findExamRow(db, patientId, examId);
  if (current === null) throw examNotFound();

  const previous = await findExamRow(db, patientId, withExamId);
  if (previous === null) {
    throw new NotFoundError(
      'El periodontograma con el que se quiere comparar no existe o pertenece a otro paciente',
    );
  }

  return {
    previous: toExamSummary(previous),
    current: toExamSummary(current),
    comparison: comparePeriodontalCharts({
      previousExamId: previous.id,
      previous: previous.teethData,
      currentExamId: current.id,
      current: current.teethData,
    }),
  };
};

/**
 * Deja constancia de una impresión (imprimir es leer: la secretaría puede hacerlo).
 * El contador se incrementa en SQL para que dos impresiones a la vez no pierdan una.
 */
export const registerPrint = async (
  db: OdontogramDb,
  patientId: string,
  examId: string,
  actor: ActorContext,
): Promise<PrintPeriodontalExamResult> => {
  const at = new Date();

  const row = await db.transaction(async (tx) => {
    const updated = await tx
      .update(periodontogramExams)
      .set({
        printCount: sql`${periodontogramExams.printCount} + 1`,
        lastPrintedAt: at,
        updatedAt: at,
      })
      .where(and(eq(periodontogramExams.id, examId), eq(periodontogramExams.patientId, patientId)))
      .returning();

    const printed = updated[0];
    if (printed === undefined) throw examNotFound();

    await publishExamEvent(tx, actor, {
      topic: EVENT_TOPICS.periodontalExamPrinted,
      action: 'periodontogram_printed',
      patientId,
      examId: printed.id,
      row: printed,
      summary: `${describeExam(toExamDetail(printed))} · impreso`,
      changedFields: [],
      before: null,
      after: auditSnapshotOfRow(printed),
      extra: { printCount: printed.printCount },
    });

    return printed;
  });

  return {
    examId: row.id,
    printCount: row.printCount,
    lastPrintedAt: (row.lastPrintedAt ?? at).toISOString(),
  };
};

/* ── Resumen interno (dossier y reportes) ──────────────────────────────────── */

/**
 * Resumen del **último examen finalizado**: lo que el expediente y los reportes
 * necesitan sin abrir el documento. Sin examen finalizado responde `hasExam: false`
 * (un borrador no es un hecho clínico firmado).
 */
export const getInternalSummary = async (
  db: OdontogramDb,
  patientId: string,
): Promise<PeriodontalInternalSummary> => {
  const rows = await db
    .select()
    .from(periodontogramExams)
    .where(
      and(
        eq(periodontogramExams.patientId, patientId),
        eq(periodontogramExams.status, 'finalizado'),
      ),
    )
    // Se ordena por creación, igual que `latest`: «el último» es el documento más
    // reciente del expediente, aunque su fecha clínica sea anterior (captura
    // retroactiva); así el resumen interno y la lectura del último examen coinciden.
    .orderBy(desc(periodontogramExams.createdAt), desc(periodontogramExams.id))
    .limit(1);

  const row = rows[0];
  if (row === undefined) {
    return {
      patientId,
      hasExam: false,
      examId: null,
      examDate: null,
      status: null,
      metrics: null,
      diagnosis: null,
    };
  }

  return {
    patientId,
    hasExam: true,
    examId: row.id,
    examDate: row.examDate,
    status: row.status as PeriodontalExamStatus,
    metrics: row.metrics,
    diagnosis: row.diagnosis,
  };
};
