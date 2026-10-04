import {
  clinicalAlerts,
  clinicalSectionSchemaFor,
  completedClinicalSections,
  missingSignatureSections,
  type AcceptConsentInput,
  type ClinicalAmendment,
  type ClinicalConsent,
  type ClinicalPatientSnapshot,
  type ClinicalRecordDetail,
  type ClinicalRecordSummary,
  type ClinicalSectionKey,
  type CreateAmendmentInput,
} from '@odontocrm/contracts';
import { EVENT_TOPICS } from '@odontocrm/events';
import { ConflictError, NotFoundError, parseOrThrow } from '@odontocrm/kernel';
import { asc, desc, eq } from 'drizzle-orm';

import type { ClinicalDb } from '../db/client.js';
import {
  medicalRecordAmendments,
  medicalRecordConsents,
  medicalRecords,
  medicalRecordSections,
  type MedicalRecordAmendmentRow,
  type MedicalRecordConsentRow,
  type MedicalRecordRow,
} from '../db/schema.js';
import type { ActorContext } from '../shared/context.js';
import { auditPayload, publish } from '../shared/events.js';

type SectionsMap = Partial<Record<ClinicalSectionKey, Record<string, unknown>>>;

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

/* ── Lectura ───────────────────────────────────────────────────────────────── */

export const findRecordByPatient = async (
  db: ClinicalDb,
  patientId: string,
): Promise<MedicalRecordRow | null> => {
  const rows = await db
    .select()
    .from(medicalRecords)
    .where(eq(medicalRecords.patientId, patientId))
    .limit(1);
  return rows[0] ?? null;
};

const findRecordById = async (db: ClinicalDb, id: string): Promise<MedicalRecordRow | null> => {
  const rows = await db.select().from(medicalRecords).where(eq(medicalRecords.id, id)).limit(1);
  return rows[0] ?? null;
};

const loadRecordOrFail = async (db: ClinicalDb, id: string): Promise<MedicalRecordRow> => {
  const row = await findRecordById(db, id);
  if (row === null) throw new NotFoundError('La historia clínica no existe');
  return row;
};

const loadSections = async (db: ClinicalDb, recordId: string): Promise<SectionsMap> => {
  const rows = await db
    .select()
    .from(medicalRecordSections)
    .where(eq(medicalRecordSections.recordId, recordId));
  const sections: SectionsMap = {};
  for (const row of rows) {
    sections[row.sectionKey as ClinicalSectionKey] = row.content;
  }
  return sections;
};

const loadAmendments = async (
  db: ClinicalDb,
  recordId: string,
): Promise<MedicalRecordAmendmentRow[]> =>
  db
    .select()
    .from(medicalRecordAmendments)
    .where(eq(medicalRecordAmendments.recordId, recordId))
    .orderBy(desc(medicalRecordAmendments.createdAt), asc(medicalRecordAmendments.id));

const loadConsent = async (
  db: ClinicalDb,
  recordId: string,
): Promise<MedicalRecordConsentRow | null> => {
  const rows = await db
    .select()
    .from(medicalRecordConsents)
    .where(eq(medicalRecordConsents.recordId, recordId))
    .limit(1);
  return rows[0] ?? null;
};

const toAmendment = (row: MedicalRecordAmendmentRow): ClinicalAmendment => ({
  id: row.id,
  sectionKey: (row.sectionKey as ClinicalSectionKey | null) ?? null,
  reason: row.reason,
  content: row.content,
  authorUsername: row.authorUsername,
  createdAt: row.createdAt.toISOString(),
});

const toConsent = (row: MedicalRecordConsentRow | null): ClinicalConsent | null =>
  row === null
    ? null
    : {
        accepted: row.accepted,
        acceptedAt: iso(row.acceptedAt),
        acceptedByName: row.acceptedByName,
        acceptedByDocument: row.acceptedByDocument,
        relationship: row.relationship,
        witnessName: row.witnessName,
        notes: row.notes,
      };

const toSummary = (
  row: MedicalRecordRow,
  sections: SectionsMap,
  consentAccepted: boolean,
  amendmentCount: number,
): ClinicalRecordSummary => ({
  id: row.id,
  patientId: row.patientId,
  status: row.status as ClinicalRecordSummary['status'],
  openedAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
  signedAt: iso(row.signedAt),
  signedByUsername: row.signedByUsername,
  amendmentCount,
  completedSections: completedClinicalSections(sections),
  missingSections: missingSignatureSections(sections),
  consentAccepted,
  alerts: clinicalAlerts(sections),
});

const buildDetail = async (
  db: ClinicalDb,
  row: MedicalRecordRow,
  patient: ClinicalPatientSnapshot | null = null,
): Promise<ClinicalRecordDetail> => {
  const [sections, amendments, consent] = await Promise.all([
    loadSections(db, row.id),
    loadAmendments(db, row.id),
    loadConsent(db, row.id),
  ]);

  return {
    ...toSummary(row, sections, consent?.accepted === true, amendments.length),
    patient,
    sections,
    amendments: amendments.map(toAmendment),
    consent: toConsent(consent),
  };
};

/** Detalle de la historia de un paciente, o `null` si es «primera visita». */
export const getRecordDetailByPatient = async (
  db: ClinicalDb,
  patientId: string,
  patient: ClinicalPatientSnapshot | null = null,
): Promise<ClinicalRecordDetail | null> => {
  const row = await findRecordByPatient(db, patientId);
  if (row === null) return null;
  return buildDetail(db, row, patient);
};

export const getRecordDetail = async (
  db: ClinicalDb,
  recordId: string,
  patient: ClinicalPatientSnapshot | null = null,
): Promise<ClinicalRecordDetail> => {
  const row = await loadRecordOrFail(db, recordId);
  return buildDetail(db, row, patient);
};

/* ── Apertura ──────────────────────────────────────────────────────────────── */

export interface OpenRecordResult {
  created: boolean;
  detail: ClinicalRecordDetail;
}

/**
 * Abre la historia del paciente. Es **idempotente**: si ya existe, la devuelve
 * tal cual. Quien llama (la interfaz) decide si muestra el aviso de «primera
 * visita» según exista o no.
 */
export const openRecord = async (
  db: ClinicalDb,
  patientId: string,
  actor: ActorContext,
  patient: ClinicalPatientSnapshot | null = null,
): Promise<OpenRecordResult> => {
  const existing = await findRecordByPatient(db, patientId);
  if (existing !== null) {
    return { created: false, detail: await buildDetail(db, existing, patient) };
  }

  try {
    const created = await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(medicalRecords)
        .values({ patientId, createdBy: actor.actorId, updatedBy: actor.actorId })
        .returning();
      const row = inserted[0];
      if (row === undefined) throw new NotFoundError('No se pudo abrir la historia clínica');

      await publish(tx, {
        topic: EVENT_TOPICS.recordCreated,
        aggregateId: row.id,
        actor,
        payload: auditPayload({
          entityId: row.id,
          action: 'medical_record_created',
          summary: 'Historia clínica abierta',
          changedFields: ['status'],
          after: { patientId, status: 'borrador' },
          reason: 'primera visita',
          actor,
        }),
      });

      return row;
    });

    return { created: true, detail: await buildDetail(db, created, patient) };
  } catch (error) {
    // Dos pestañas pueden abrir la historia a la vez: el índice único por
    // paciente lo impide y, en ese caso, se devuelve la que ya existe.
    if ((error as { code?: string }).code !== '23505') throw error;
    const row = await findRecordByPatient(db, patientId);
    if (row === null) throw error;
    return { created: false, detail: await buildDetail(db, row, patient) };
  }
};

/* ── Guardado por sección ──────────────────────────────────────────────────── */

const changedTopLevelFields = (
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown>,
): string[] =>
  before === undefined
    ? Object.keys(after)
    : Object.keys(after).filter(
        (field) => JSON.stringify(before[field] ?? null) !== JSON.stringify(after[field] ?? null),
      );

/**
 * Guarda una sección (solo en borrador). La transición queda en el outbox en la
 * misma transacción que el dato, así que la auditoría no puede quedar
 * desincronizada de la historia.
 */
export const saveSection = async (
  db: ClinicalDb,
  recordId: string,
  sectionKey: ClinicalSectionKey,
  content: Record<string, unknown>,
  actor: ActorContext,
): Promise<ClinicalRecordDetail> => {
  const record = await loadRecordOrFail(db, recordId);
  if (record.status !== 'borrador') {
    throw new ConflictError('La historia está firmada: las correcciones se hacen con una adenda', {
      extensions: { status: record.status },
    });
  }

  const clean = parseOrThrow(
    clinicalSectionSchemaFor(sectionKey),
    content,
    'La sección tiene datos inválidos',
  ) as Record<string, unknown>;

  const previousRows = await db
    .select()
    .from(medicalRecordSections)
    .where(eq(medicalRecordSections.recordId, recordId));
  const previous = previousRows.find((row) => row.sectionKey === sectionKey)?.content;

  const changedFields = changedTopLevelFields(previous, clean);
  // Sin cambios no se escribe ni se audita: la historia no se ensucia con
  // guardados vacíos del formulario.
  if (previous !== undefined && changedFields.length === 0) {
    return buildDetail(db, record);
  }

  const updated = await db.transaction(async (tx) => {
    await tx
      .insert(medicalRecordSections)
      .values({ recordId, sectionKey, content: clean, updatedBy: actor.actorId })
      .onConflictDoUpdate({
        target: [medicalRecordSections.recordId, medicalRecordSections.sectionKey],
        set: { content: clean, updatedBy: actor.actorId, updatedAt: new Date() },
      });

    const rows = await tx
      .update(medicalRecords)
      .set({ updatedBy: actor.actorId, updatedAt: new Date() })
      .where(eq(medicalRecords.id, recordId))
      .returning();
    const row = rows[0];
    if (row === undefined) throw new NotFoundError('La historia clínica no existe');

    await publish(tx, {
      topic: EVENT_TOPICS.recordUpdated,
      aggregateId: recordId,
      actor,
      payload: auditPayload({
        entityId: recordId,
        action: 'medical_record_updated',
        summary: `Historia clínica: sección «${sectionKey}» actualizada`,
        changedFields,
        before: previous ?? null,
        after: clean,
        reason: null,
        actor,
      }),
    });

    return row;
  });

  return buildDetail(db, updated);
};

/* ── Consentimiento ────────────────────────────────────────────────────────── */

export const acceptConsent = async (
  db: ClinicalDb,
  recordId: string,
  input: AcceptConsentInput,
  actor: ActorContext,
): Promise<ClinicalRecordDetail> => {
  const record = await loadRecordOrFail(db, recordId);
  if (record.status !== 'borrador') {
    throw new ConflictError(
      'La historia ya está firmada: registra el consentimiento antes de firmar',
      { extensions: { status: record.status } },
    );
  }

  const updated = await db.transaction(async (tx) => {
    await tx
      .insert(medicalRecordConsents)
      .values({
        recordId,
        accepted: true,
        acceptedByName: input.acceptedByName,
        acceptedByDocument: input.acceptedByDocument,
        relationship: input.relationship,
        witnessName: input.witnessName,
        notes: input.notes,
        registeredBy: actor.actorId,
        registeredByUsername: actor.actorUsername,
      })
      .onConflictDoUpdate({
        target: [medicalRecordConsents.recordId],
        set: {
          accepted: true,
          acceptedAt: new Date(),
          acceptedByName: input.acceptedByName,
          acceptedByDocument: input.acceptedByDocument,
          relationship: input.relationship,
          witnessName: input.witnessName,
          notes: input.notes,
          registeredBy: actor.actorId,
          registeredByUsername: actor.actorUsername,
          updatedAt: new Date(),
        },
      });

    const rows = await tx
      .update(medicalRecords)
      .set({ updatedBy: actor.actorId, updatedAt: new Date() })
      .where(eq(medicalRecords.id, recordId))
      .returning();
    const row = rows[0];
    if (row === undefined) throw new NotFoundError('La historia clínica no existe');

    await publish(tx, {
      topic: EVENT_TOPICS.recordUpdated,
      aggregateId: recordId,
      actor,
      payload: auditPayload({
        entityId: recordId,
        action: 'medical_record_consent_accepted',
        summary: `Consentimiento informado aceptado por ${input.acceptedByName} (${input.relationship})`,
        changedFields: ['consentimiento'],
        after: {
          acceptedByName: input.acceptedByName,
          relationship: input.relationship,
          witnessName: input.witnessName,
        },
        reason: null,
        actor,
      }),
    });

    return row;
  });

  return buildDetail(db, updated);
};

/* ── Firma ─────────────────────────────────────────────────────────────────── */

/**
 * Firma la historia. No se puede firmar sin las secciones obligatorias ni sin el
 * consentimiento aceptado: es la misma comprobación que muestra la interfaz, pero
 * el servidor no se fía de ella.
 */
export const signRecord = async (
  db: ClinicalDb,
  recordId: string,
  actor: ActorContext,
): Promise<ClinicalRecordDetail> => {
  const record = await loadRecordOrFail(db, recordId);
  if (record.status !== 'borrador') {
    throw new ConflictError('La historia ya está firmada', {
      extensions: { status: record.status },
    });
  }

  const [sections, consent] = await Promise.all([
    loadSections(db, recordId),
    loadConsent(db, recordId),
  ]);

  const missing = missingSignatureSections(sections);
  if (missing.length > 0) {
    throw new ConflictError('Faltan secciones obligatorias para firmar la historia', {
      extensions: { missingSections: missing },
    });
  }
  if (consent === null || !consent.accepted) {
    throw new ConflictError('Registra el consentimiento informado antes de firmar', {
      extensions: { missingSections: ['consentimiento'] },
    });
  }

  const signed = await db.transaction(async (tx) => {
    const rows = await tx
      .update(medicalRecords)
      .set({
        status: 'firmada',
        signedAt: new Date(),
        signedBy: actor.actorId,
        signedByUsername: actor.actorUsername,
        updatedBy: actor.actorId,
        updatedAt: new Date(),
      })
      .where(eq(medicalRecords.id, recordId))
      .returning();
    const row = rows[0];
    if (row === undefined) throw new NotFoundError('La historia clínica no existe');

    await publish(tx, {
      topic: EVENT_TOPICS.recordSigned,
      aggregateId: recordId,
      actor,
      payload: auditPayload({
        entityId: recordId,
        action: 'medical_record_signed',
        summary: 'Historia clínica firmada',
        changedFields: ['status'],
        before: { status: 'borrador' },
        after: { status: 'firmada' },
        reason: null,
        actor,
      }),
    });

    return row;
  });

  return buildDetail(db, signed);
};

/* ── Adendas ───────────────────────────────────────────────────────────────── */

export const createAmendment = async (
  db: ClinicalDb,
  recordId: string,
  input: CreateAmendmentInput,
  actor: ActorContext,
): Promise<ClinicalRecordDetail> => {
  const record = await loadRecordOrFail(db, recordId);
  if (record.status !== 'firmada') {
    throw new ConflictError('La historia es un borrador: edítala directamente antes de firmar', {
      extensions: { status: record.status },
    });
  }

  await db.transaction(async (tx) => {
    await tx.insert(medicalRecordAmendments).values({
      recordId,
      sectionKey: input.sectionKey,
      reason: input.reason,
      content: input.content,
      authorId: actor.actorId,
      authorUsername: actor.actorUsername,
    });

    await publish(tx, {
      topic: EVENT_TOPICS.recordAmended,
      aggregateId: recordId,
      actor,
      payload: auditPayload({
        entityId: recordId,
        action: 'medical_record_amended',
        summary: `Adenda a la historia clínica${
          input.sectionKey === null ? '' : ` (sección «${input.sectionKey}»)`
        }`,
        changedFields: input.sectionKey === null ? [] : [input.sectionKey],
        after: { content: input.content },
        reason: input.reason,
        actor,
      }),
    });
  });

  return getRecordDetail(db, recordId);
};

/* ── Impresión (también la secretaría, que solo lee) ───────────────────────── */

export interface PrintRecordResult {
  id: string;
  printCount: number;
  lastPrintedAt: string;
}

export const registerPrint = async (
  db: ClinicalDb,
  recordId: string,
  actor: ActorContext,
): Promise<PrintRecordResult> => {
  const record = await loadRecordOrFail(db, recordId);

  const updated = await db.transaction(async (tx) => {
    const rows = await tx
      .update(medicalRecords)
      .set({
        printCount: record.printCount + 1,
        lastPrintedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(medicalRecords.id, recordId))
      .returning();
    const row = rows[0];
    if (row === undefined) throw new NotFoundError('La historia clínica no existe');

    await publish(tx, {
      topic: EVENT_TOPICS.recordUpdated,
      aggregateId: recordId,
      actor,
      payload: auditPayload({
        entityId: recordId,
        action: 'medical_record_printed',
        summary: 'Historia clínica impresa',
        changedFields: [],
        reason: null,
        actor,
      }),
    });

    return row;
  });

  return {
    id: updated.id,
    printCount: updated.printCount,
    lastPrintedAt: (updated.lastPrintedAt ?? updated.updatedAt).toISOString(),
  };
};
