import {
  SENSITIVE_PATIENT_FIELDS,
  ageFromBirthDate,
  diffSensitiveFields,
  formatDocument,
  normalizeDocNumber,
  parseDocumentText,
  type CreatePatientInput,
  type DocType,
  type Paginated,
  type PatientDetail,
  type PatientFilters,
  type PatientSummary,
  type SensitiveDiff,
  type Sex,
  type PatientStatus,
  type UpdatePatientInput,
  type UpsertPatientInput,
} from '@odontocrm/contracts';
import { outboxEvents, toOutboxInsert } from '@odontocrm/db';
import { EVENT_TOPICS, createDomainEvent } from '@odontocrm/events';
import { ConflictError, NotFoundError } from '@odontocrm/kernel';
import { and, asc, count, eq, gte, inArray, isNull, lte, or, sql, type SQL } from 'drizzle-orm';

import type { PatientsDb } from '../db/client.js';
import {
  patientContactsHistory,
  patientGuardians,
  patientFiles,
  patients,
  type PatientGuardianRow,
  type PatientRow,
} from '../db/schema.js';

export const PRODUCER = 'patients';

export interface ActorContext {
  actorId: string | null;
  actorUsername: string | null;
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
}

export const systemActor = (reason?: string): ActorContext & { reason: string | null } => ({
  actorId: null,
  actorUsername: null,
  ip: null,
  userAgent: null,
  requestId: null,
  reason: reason ?? null,
});

const isoDate = (value: Date): string => value.toISOString();

export const toPatientSummary = (
  row: PatientRow,
  options: { hasGuardian: boolean; now?: Date },
): PatientSummary => {
  const now = options.now ?? new Date();
  return {
    id: row.id,
    docType: row.docType as DocType,
    docNumber: row.docNumber,
    document: formatDocument(row.docType as DocType, row.docNumber),
    fullName: row.fullName,
    birthDate: row.birthDate,
    age: ageFromBirthDate(row.birthDate, now),
    isMinor: ageFromBirthDate(row.birthDate, now) < 18,
    sex: row.sex as Sex,
    phone: row.phone,
    phoneAlt: row.phoneAlt,
    status: row.status as PatientStatus,
    isFictitious: row.isFictitious,
    hasGuardian: options.hasGuardian,
    createdAt: isoDate(row.createdAt),
  };
};

export const toPatientDetail = (
  row: PatientRow,
  options: { guardian: PatientGuardianRow | null; fileCount: number; now?: Date },
): PatientDetail => ({
  ...toPatientSummary(row, {
    hasGuardian: options.guardian !== null,
    ...(options.now === undefined ? {} : { now: options.now }),
  }),
  email: row.email,
  address: row.address,
  occupation: row.occupation,
  notes: row.notes,
  guardian:
    options.guardian === null
      ? null
      : {
          id: options.guardian.id,
          fullName: options.guardian.fullName,
          docType: (options.guardian.docType as DocType | null) ?? undefined,
          docNumber: options.guardian.docNumber ?? null,
          relationship: options.guardian.relationship,
          phone: options.guardian.phone,
        },
  updatedAt: isoDate(row.updatedAt),
  fileCount: options.fileCount,
});

export const findPatientByDocument = async (
  db: PatientsDb,
  docType: DocType,
  docNumber: string,
): Promise<PatientRow | null> => {
  const rows = await db
    .select()
    .from(patients)
    .where(
      and(
        eq(patients.docType, docType),
        eq(patients.docNumber, normalizeDocNumber(docNumber)),
        isNull(patients.deletedAt),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
};

export const findPatientById = async (db: PatientsDb, id: string): Promise<PatientRow | null> => {
  const rows = await db
    .select()
    .from(patients)
    .where(and(eq(patients.id, id), isNull(patients.deletedAt)))
    .limit(1);
  return rows[0] ?? null;
};

const loadGuardian = async (
  db: PatientsDb,
  patientId: string,
): Promise<PatientGuardianRow | null> => {
  const rows = await db
    .select()
    .from(patientGuardians)
    .where(eq(patientGuardians.patientId, patientId))
    .limit(1);
  return rows[0] ?? null;
};

const loadGuardianFlags = async (
  db: PatientsDb,
  patientIds: readonly string[],
): Promise<Map<string, boolean>> => {
  const result = new Map<string, boolean>(patientIds.map((id) => [id, false]));
  if (patientIds.length === 0) return result;

  const rows = await db
    .select({ patientId: patientGuardians.patientId })
    .from(patientGuardians)
    .where(inArray(patientGuardians.patientId, [...patientIds]));
  for (const row of rows) result.set(row.patientId, true);
  return result;
};

export const countFiles = async (db: PatientsDb, patientId: string): Promise<number> => {
  const rows = await db
    .select({ value: count() })
    .from(patientFiles)
    .where(and(eq(patientFiles.patientId, patientId), isNull(patientFiles.deletedAt)));
  return rows[0]?.value ?? 0;
};

export const getPatientDetail = async (db: PatientsDb, id: string): Promise<PatientDetail> => {
  const row = await findPatientById(db, id);
  if (row === null) throw new NotFoundError('El paciente no existe');

  const [guardian, fileCount] = await Promise.all([loadGuardian(db, id), countFiles(db, id)]);
  return toPatientDetail(row, { guardian, fileCount });
};

/** Escapa los comodines de LIKE para que la búsqueda sea literal. */
const likePattern = (value: string): string =>
  `%${value.trim().replace(/[\\%_]/g, (match) => `\\${match}`)}%`;

/** Límites de fecha para el rango de edad solicitado (comparados en UTC). */
export const ageBounds = (
  ageMin: number | undefined,
  ageMax: number | undefined,
  now = new Date(),
): { oldestBirthDate?: string; newestBirthDate?: string } => {
  const bounds: { oldestBirthDate?: string; newestBirthDate?: string } = {};

  if (ageMin !== undefined) {
    // Tener al menos `ageMin` años ⇒ nació en o antes de hoy − ageMin.
    const oldest = new Date(
      Date.UTC(now.getUTCFullYear() - ageMin, now.getUTCMonth(), now.getUTCDate()),
    );
    bounds.oldestBirthDate = oldest.toISOString().slice(0, 10);
  }
  if (ageMax !== undefined) {
    // Tener como mucho `ageMax` años ⇒ nació después de hoy − (ageMax + 1).
    const newest = new Date(
      Date.UTC(now.getUTCFullYear() - ageMax - 1, now.getUTCMonth(), now.getUTCDate()),
    );
    bounds.newestBirthDate = newest.toISOString().slice(0, 10);
  }
  return bounds;
};

export const listPatients = async (
  db: PatientsDb,
  filters: PatientFilters,
): Promise<Paginated<PatientSummary>> => {
  const conditions: SQL[] = [isNull(patients.deletedAt) as SQL];

  const search = filters.search?.trim() ?? '';
  if (search !== '') {
    const parsed = parseDocumentText(search);
    const digits = search.replace(/\D/g, '');
    const alternatives: (SQL | undefined)[] = [
      sql`${patients.fullName} ilike ${likePattern(search)} escape '\\'`,
      sql`${patients.phone} like ${`%${digits}%`}`,
      sql`${patients.docNumber} like ${`%${normalizeDocNumber(search)}%`}`,
      and(eq(patients.docType, parsed.type), eq(patients.docNumber, parsed.number)),
    ];
    const usable = alternatives.filter((item): item is SQL => item !== undefined);
    const combined = or(...usable);
    if (combined !== undefined) conditions.push(combined);
  }

  if (filters.status !== undefined) conditions.push(eq(patients.status, filters.status));
  if (filters.docType !== undefined) conditions.push(eq(patients.docType, filters.docType));
  if (filters.sex !== undefined) conditions.push(eq(patients.sex, filters.sex));

  const bounds = ageBounds(filters.ageMin, filters.ageMax);
  if (bounds.oldestBirthDate !== undefined) {
    conditions.push(lte(patients.birthDate, bounds.oldestBirthDate));
  }
  if (bounds.newestBirthDate !== undefined) {
    conditions.push(gte(patients.birthDate, bounds.newestBirthDate));
  }

  const where = and(...conditions);
  const offset = (filters.page - 1) * filters.pageSize;

  const [rows, totals] = await Promise.all([
    db
      .select()
      .from(patients)
      .where(where)
      .orderBy(asc(patients.fullName))
      .limit(filters.pageSize)
      .offset(offset),
    db.select({ value: count() }).from(patients).where(where),
  ]);

  const guardianFlags = await loadGuardianFlags(
    db,
    rows.map((row) => row.id),
  );
  const now = new Date();

  return {
    items: rows.map((row) =>
      toPatientSummary(row, { hasGuardian: guardianFlags.get(row.id) ?? false, now }),
    ),
    total: totals[0]?.value ?? 0,
    page: filters.page,
    pageSize: filters.pageSize,
    totalPages: Math.max(1, Math.ceil((totals[0]?.value ?? 0) / filters.pageSize)),
  };
};

const docTypeOrThrow = (value: string): DocType => value as DocType;

interface WriteOutboxInput {
  topic: (typeof EVENT_TOPICS)[keyof typeof EVENT_TOPICS];
  patientId: string;
  document: string;
  fullName: string;
  action: 'created' | 'updated' | 'status_changed';
  changedFields: string[];
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reason: string | null;
  actor: ActorContext;
}

const outboxRow = (input: WriteOutboxInput, tx: Pick<PatientsDb, 'insert'>): Promise<unknown> =>
  tx.insert(outboxEvents).values(
    toOutboxInsert(
      createDomainEvent({
        topic: input.topic,
        aggregateId: input.patientId,
        producer: PRODUCER,
        actorId: input.actor.actorId,
        correlationId: input.actor.requestId,
        payload: {
          patientId: input.patientId,
          document: input.document,
          fullName: input.fullName,
          action: input.action,
          changedFields: input.changedFields,
          before: input.before,
          after: input.after,
          reason: input.reason,
          actorId: input.actor.actorId,
          actorUsername: input.actor.actorUsername,
          ip: input.actor.ip,
          userAgent: input.actor.userAgent,
          requestId: input.actor.requestId,
        },
      }),
    ),
  );

const contactFields = ['phone', 'phoneAlt', 'email', 'address'] as const;

const insertContactHistory = async (
  tx: Pick<PatientsDb, 'insert'>,
  patientId: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  changedFields: readonly string[],
  reason: string | null,
  actorId: string | null,
): Promise<void> => {
  const rows = contactFields
    .filter((field) => changedFields.includes(field))
    .map((field) => ({
      patientId,
      field,
      previousValue: before[field] === null ? null : String(before[field] ?? ''),
      newValue: after[field] === null ? null : String(after[field] ?? ''),
      reason,
      changedBy: actorId,
    }));

  if (rows.length > 0) await tx.insert(patientContactsHistory).values(rows);
};

const sensitiveSnapshot = (row: PatientRow): Record<string, unknown> => ({
  fullName: row.fullName,
  docNumber: row.docNumber,
  birthDate: row.birthDate,
  phone: row.phone,
  phoneAlt: row.phoneAlt,
  email: row.email,
  address: row.address,
});

export interface PatientWriteResult {
  detail: PatientDetail;
  diff: SensitiveDiff;
}

export interface UpsertResult {
  detail: PatientDetail;
  created: boolean;
  diff: SensitiveDiff | null;
}

/** Alta de paciente. Si el documento ya existe, responde 409 con su id. */
export const createPatient = async (
  db: PatientsDb,
  input: CreatePatientInput,
  actor: ActorContext & { reason?: string | null },
): Promise<PatientDetail> => {
  const existing = await findPatientByDocument(db, input.docType, input.docNumber);
  if (existing !== null) {
    throw new ConflictError(
      `Ya existe un paciente con el documento ${formatDocument(input.docType, input.docNumber)}`,
      {
        extensions: {
          existingPatientId: existing.id,
          document: formatDocument(existing.docType as DocType, existing.docNumber),
        },
      },
    );
  }

  const created = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(patients)
      .values({
        docType: input.docType,
        docNumber: input.docNumber,
        fullName: input.fullName,
        birthDate: input.birthDate,
        sex: input.sex,
        phone: input.phone,
        phoneAlt: input.phoneAlt,
        email: input.email,
        address: input.address,
        occupation: input.occupation,
        notes: input.notes,
        status: 'en_espera_cita',
        createdBy: actor.actorId,
        updatedBy: actor.actorId,
      })
      .returning();

    const row = inserted[0];
    if (row === undefined) throw new NotFoundError('No se pudo registrar al paciente');

    if (input.guardian !== undefined) {
      await tx.insert(patientGuardians).values({
        patientId: row.id,
        fullName: input.guardian.fullName,
        docType: input.guardian.docType ?? null,
        docNumber: input.guardian.docNumber,
        relationship: input.guardian.relationship,
        phone: input.guardian.phone,
      });
    }

    await outboxRow(
      {
        topic: EVENT_TOPICS.patientCreated,
        patientId: row.id,
        document: formatDocument(input.docType, input.docNumber),
        fullName: row.fullName,
        action: 'created',
        changedFields: ['fullName', 'docNumber', 'birthDate', 'phone', 'sex'],
        before: null,
        after: sensitiveSnapshot(row),
        reason: actor.reason ?? 'alta de paciente',
        actor,
      },
      tx,
    );

    return row;
  });

  return getPatientDetail(db, created.id);
};

/** Actualiza datos del paciente. Exige motivo (lo valida el contrato). */
export const updatePatient = async (
  db: PatientsDb,
  id: string,
  input: UpdatePatientInput,
  actor: ActorContext,
): Promise<PatientWriteResult> => {
  const current = await findPatientById(db, id);
  if (current === null) throw new NotFoundError('El paciente no existe');

  const nextDocType = input.docType ?? docTypeOrThrow(current.docType);
  const nextDocNumber =
    input.docNumber === undefined ? current.docNumber : normalizeDocNumber(input.docNumber);

  if (nextDocNumber !== current.docNumber || nextDocType !== current.docType) {
    const other = await findPatientByDocument(db, nextDocType, nextDocNumber);
    if (other !== null && other.id !== id) {
      throw new ConflictError(
        `El documento ${formatDocument(nextDocType, nextDocNumber)} ya pertenece a otro paciente`,
        { extensions: { existingPatientId: other.id } },
      );
    }
  }

  const before = sensitiveSnapshot(current);
  const afterSnapshot = {
    fullName: input.fullName ?? current.fullName,
    docNumber: nextDocNumber,
    birthDate: input.birthDate ?? current.birthDate,
    phone: input.phone ?? current.phone,
    phoneAlt: input.phoneAlt === undefined ? current.phoneAlt : input.phoneAlt,
    email: input.email === undefined ? current.email : input.email,
    address: input.address === undefined ? current.address : input.address,
  };

  const diff = diffSensitiveFields(before, afterSnapshot, SENSITIVE_PATIENT_FIELDS);

  await db.transaction(async (tx) => {
    const updated = await tx
      .update(patients)
      .set({
        docType: nextDocType,
        docNumber: nextDocNumber,
        fullName: afterSnapshot.fullName as string,
        birthDate: afterSnapshot.birthDate as string,
        phone: afterSnapshot.phone as string,
        phoneAlt: afterSnapshot.phoneAlt as string | null,
        email: afterSnapshot.email as string | null,
        address: afterSnapshot.address as string | null,
        ...(input.sex === undefined ? {} : { sex: input.sex }),
        ...(input.occupation === undefined ? {} : { occupation: input.occupation }),
        ...(input.notes === undefined ? {} : { notes: input.notes }),
        ...(input.status === undefined ? {} : { status: input.status }),
        updatedBy: actor.actorId,
        updatedAt: new Date(),
      })
      .where(eq(patients.id, id))
      .returning({ id: patients.id, fullName: patients.fullName });

    if (input.guardian !== undefined) {
      await tx.delete(patientGuardians).where(eq(patientGuardians.patientId, id));
      if (input.guardian !== null) {
        await tx.insert(patientGuardians).values({
          patientId: id,
          fullName: input.guardian.fullName,
          docType: input.guardian.docType ?? null,
          docNumber: input.guardian.docNumber,
          relationship: input.guardian.relationship,
          phone: input.guardian.phone,
        });
      }
    }

    if (diff.changedFields.length > 0) {
      await insertContactHistory(
        tx,
        id,
        before,
        afterSnapshot,
        diff.changedFields,
        input.reason,
        actor.actorId,
      );
      await outboxRow(
        {
          topic: EVENT_TOPICS.patientUpdated,
          patientId: id,
          document: formatDocument(nextDocType, nextDocNumber),
          fullName: updated[0]?.fullName ?? (afterSnapshot.fullName as string),
          action: 'updated',
          changedFields: diff.changedFields,
          before: diff.before,
          after: diff.after,
          reason: input.reason,
          actor,
        },
        tx,
      );
    }
  });

  return { detail: await getPatientDetail(db, id), diff };
};

/** Cambia el estado del paciente (activar, inactivar) dejando rastro. */
export const changePatientStatus = async (
  db: PatientsDb,
  id: string,
  status: PatientStatus,
  reason: string,
  actor: ActorContext,
): Promise<PatientWriteResult> => {
  const current = await findPatientById(db, id);
  if (current === null) throw new NotFoundError('El paciente no existe');

  const before = { status: current.status };
  const after = { status };
  const diff = diffSensitiveFields(before, after, ['status'] as const);

  if (diff.changedFields.length > 0) {
    await db.transaction(async (tx) => {
      await tx
        .update(patients)
        .set({ status, updatedBy: actor.actorId, updatedAt: new Date() })
        .where(eq(patients.id, id));

      await outboxRow(
        {
          topic: EVENT_TOPICS.patientUpdated,
          patientId: id,
          document: formatDocument(current.docType as DocType, current.docNumber),
          fullName: current.fullName,
          action: 'status_changed',
          changedFields: diff.changedFields,
          before: diff.before,
          after: diff.after,
          reason,
          actor,
        },
        tx,
      );
    });
  }

  return { detail: await getPatientDetail(db, id), diff };
};

/**
 * Alta o actualización por documento para los canales automáticos (bot de
 * Telegram, Fase 4) y para otros servicios. Es idempotente: el mismo documento
 * devuelve el paciente existente en lugar de un conflicto.
 */
export const upsertPatientByDocument = async (
  db: PatientsDb,
  input: UpsertPatientInput,
  actor: ActorContext & { reason?: string | null },
): Promise<UpsertResult> => {
  const existing = await findPatientByDocument(db, input.docType, input.docNumber);

  if (existing === null) {
    const detail = await createPatient(db, input, actor);
    return { detail, created: true, diff: null };
  }

  const result = await updatePatient(
    db,
    existing.id,
    {
      fullName: input.fullName,
      birthDate: input.birthDate,
      sex: input.sex,
      phone: input.phone,
      phoneAlt: input.phoneAlt ?? undefined,
      email: input.email ?? undefined,
      address: input.address ?? undefined,
      occupation: input.occupation ?? undefined,
      notes: input.notes ?? undefined,
      ...(input.guardian === undefined ? {} : { guardian: input.guardian }),
      reason: actor.reason ?? 'actualización automática por documento',
    },
    actor,
  );

  return { detail: result.detail, created: false, diff: result.diff };
};

/** Búsqueda por documento escrita a mano (`V-12345678`, `v 12.345.678`…). */
export const lookupByDocumentText = async (
  db: PatientsDb,
  text: string,
): Promise<PatientDetail | null> => {
  const parsed = parseDocumentText(text);
  const row = await findPatientByDocument(db, parsed.type, parsed.number);
  return row === null ? null : getPatientDetail(db, row.id);
};
