import {
  abbreviateName,
  clinicDentistFor,
  formatPrescriptionNumber,
  type AnnulPrescriptionInput,
  type CreatePrescriptionInput,
  type Medication,
  type MedicationList,
  type PrescriptionDetail,
  type PrescriptionItemInput,
  type PrescriptionList,
  type PrescriptionSummary,
  type PrescriptionVerification,
  type PrescriptionVerificationResult,
  type StoredPrescriptionItem,
} from '@odontocrm/contracts';
import { EVENT_TOPICS } from '@odontocrm/events';
import { ConflictError, NotFoundError, ServiceUnavailableError } from '@odontocrm/kernel';
import type { BrandLookup, LetterheadLookup } from '@odontocrm/kernel';
import type { BlobStore } from '@odontocrm/storage';
import { buildStorageKey } from '@odontocrm/storage';
import { and, asc, desc, eq, ilike, or, sql } from 'drizzle-orm';

import type { ClinicalDb } from '../db/client.js';
import {
  medicationsCatalog,
  prescriptionItems,
  prescriptions,
  type PrescriptionItemRow,
  type PrescriptionRow,
} from '../db/schema.js';
import type { ActorContext } from '../shared/context.js';
import { auditPayload, publish } from '../shared/events.js';
import { buildVerifyCode, formatVerifyCode, normalizeVerifyCode } from '../shared/verify-code.js';
import { requireSession } from './session-service.js';
import type { PdfRenderer } from '../prescriptions/pdf-renderer.js';
import {
  prescriptionHtml,
  type PrescriptionDocumentInput,
} from '../prescriptions/prescription-document.js';
import type { PatientSnapshotLookup } from '../shared/patient-client.js';

/**
 * Récipes (Fase 7, sesión B).
 *
 * El ciclo es corto y deliberado:
 *  1. **Borrador** por sesión (uno solo): se guarda y se corrige cuanto haga falta.
 *  2. **Emisión**: se lleva un número de la secuencia, se genera el PDF A5, se
 *     archiva y se deja el código de verificación. A partir de ahí es un documento.
 *  3. **Anulación** con motivo, si hay que dejarlo sin efecto (nunca se borra).
 *  4. **Reimpresión** contada y auditada cada vez que se descarga o se imprime.
 *
 * La numeración sale de `prescription_number_seq`: los huecos que deja un fallo al
 * generar el PDF son aceptables (como en cualquier numeración de documentos), y a
 * cambio dos emisiones simultáneas nunca comparten número.
 */

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

/*
 * El código de verificación es compartido con el dossier del expediente: el alfabeto,
 * el guion y la normalización tienen que ser los mismos o un código no encontraría su
 * documento. Se reexporta para no cambiar la superficie pública de este módulo.
 */
export { formatVerifyCode, normalizeVerifyCode };

/* ── Catálogo ──────────────────────────────────────────────────────────────── */

export const listMedications = async (
  db: ClinicalDb,
  search: string | undefined,
  limit = 30,
): Promise<MedicationList> => {
  const filtro = search === undefined || search.trim() === '' ? undefined : `%${search.trim()}%`;
  const rows = await db
    .select()
    .from(medicationsCatalog)
    .where(
      filtro === undefined
        ? eq(medicationsCatalog.isActive, true)
        : and(
            eq(medicationsCatalog.isActive, true),
            or(
              ilike(medicationsCatalog.name, filtro),
              ilike(medicationsCatalog.indications, filtro),
            ),
          ),
    )
    .orderBy(asc(medicationsCatalog.name))
    .limit(limit);

  const items: Medication[] = rows.map((row) => ({
    id: row.id,
    name: row.name,
    presentations: row.presentations ?? [],
    routes: (row.routes ?? []) as Medication['routes'],
    usualDose: row.usualDose,
    usualFrequency: row.usualFrequency,
    usualDuration: row.usualDuration,
    indications: row.indications,
    isActive: row.isActive,
  }));

  return { items, total: items.length };
};

/* ── Lectura ───────────────────────────────────────────────────────────────── */

const toSummary = (row: PrescriptionRow, itemCount: number): PrescriptionSummary => ({
  id: row.id,
  number: row.prescriptionNumber === null ? null : formatPrescriptionNumber(row.prescriptionNumber),
  prescriptionNumber: row.prescriptionNumber,
  sessionId: row.sessionId,
  patientId: row.patientId,
  status: row.status as PrescriptionSummary['status'],
  issuedAt: iso(row.issuedAt),
  issuedByUsername: row.issuedByUsername,
  itemCount,
  verifyCode: row.verifyCode === null ? null : formatVerifyCode(row.verifyCode),
  hasPdf: row.pdfPath !== null,
  printCount: row.printCount,
  lastPrintedAt: iso(row.lastPrintedAt),
  annulledAt: iso(row.annulledAt),
  annulReason: row.annulReason,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

const toStoredItem = (row: PrescriptionItemRow): StoredPrescriptionItem => ({
  id: row.id,
  position: row.position,
  medicationId: row.medicationId,
  medicationName: row.medicationName,
  presentation: row.presentation,
  route: (row.route as StoredPrescriptionItem['route']) ?? null,
  dose: row.dose,
  frequency: row.frequency,
  duration: row.duration,
  instructions: row.instructions,
  quantity: row.quantity,
});

const loadItems = async (db: ClinicalDb, prescriptionId: string): Promise<PrescriptionItemRow[]> =>
  db
    .select()
    .from(prescriptionItems)
    .where(eq(prescriptionItems.prescriptionId, prescriptionId))
    .orderBy(asc(prescriptionItems.position));

const loadRowOrFail = async (db: ClinicalDb, id: string): Promise<PrescriptionRow> => {
  const rows = await db.select().from(prescriptions).where(eq(prescriptions.id, id)).limit(1);
  const row = rows[0];
  if (row === undefined) throw new NotFoundError('El récipe no existe');
  return row;
};

export const getPrescriptionDetail = async (
  db: ClinicalDb,
  id: string,
): Promise<PrescriptionDetail> => {
  const row = await loadRowOrFail(db, id);
  const items = await loadItems(db, id);
  return {
    ...toSummary(row, items.length),
    items: items.map(toStoredItem),
    generalInstructions: row.generalInstructions,
  };
};

export const listPrescriptionsByPatient = async (
  db: ClinicalDb,
  patientId: string,
): Promise<PrescriptionList> => {
  const rows = await db
    .select()
    .from(prescriptions)
    .where(eq(prescriptions.patientId, patientId))
    .orderBy(desc(prescriptions.createdAt));

  const items: PrescriptionSummary[] = [];
  for (const row of rows) {
    const filas = await loadItems(db, row.id);
    items.push(toSummary(row, filas.length));
  }
  return { items, total: items.length };
};

export const listPrescriptionsBySession = async (
  db: ClinicalDb,
  sessionId: string,
): Promise<PrescriptionList> => {
  const rows = await db
    .select()
    .from(prescriptions)
    .where(eq(prescriptions.sessionId, sessionId))
    .orderBy(desc(prescriptions.createdAt));

  const items: PrescriptionSummary[] = [];
  for (const row of rows) {
    const filas = await loadItems(db, row.id);
    items.push(toSummary(row, filas.length));
  }
  return { items, total: items.length };
};

/* ── Borrador ──────────────────────────────────────────────────────────────── */

const itemValues = (prescriptionId: string, items: readonly PrescriptionItemInput[]) =>
  items.map((item, index) => ({
    prescriptionId,
    position: index + 1,
    medicationId: item.medicationId,
    medicationName: item.medicationName,
    presentation: item.presentation,
    route: item.route,
    dose: item.dose,
    frequency: item.frequency,
    duration: item.duration,
    instructions: item.instructions,
    quantity: item.quantity,
  }));

/**
 * Guarda el **borrador del récipe** de una sesión (uno solo por sesión).
 *
 * Es idempotente en el sentido útil: si ya había borrador se reemplaza entero
 * (líneas y indicaciones), que es lo que espera un formulario que se edita y se
 * vuelve a guardar. Si el récipe ya se emitió, no se toca: se anula y se emite otro.
 */
export const saveDraft = async (
  db: ClinicalDb,
  sessionId: string,
  input: CreatePrescriptionInput,
  actor: ActorContext,
): Promise<PrescriptionDetail> => {
  const session = await requireSession(db, sessionId);

  const existentes = await db
    .select()
    .from(prescriptions)
    .where(and(eq(prescriptions.sessionId, sessionId), eq(prescriptions.status, 'borrador')))
    .limit(1);
  const borrador = existentes[0];

  if (borrador === undefined) {
    // Solo bloquea un récipe **vigente**: si el anterior se anuló, esta misma visita
    // puede llevar otro (es lo que pasa cuando el primero salió mal).
    const vigentes = await db
      .select({ id: prescriptions.id })
      .from(prescriptions)
      .where(and(eq(prescriptions.sessionId, sessionId), eq(prescriptions.status, 'emitida')))
      .limit(1);
    if (vigentes.length > 0) {
      throw new ConflictError(
        'Esta sesión ya tiene un récipe emitido: anúlalo con su motivo antes de preparar otro',
      );
    }
  }

  const id = await db.transaction(async (tx) => {
    let prescriptionId = borrador?.id;

    if (prescriptionId === undefined) {
      const inserted = await tx
        .insert(prescriptions)
        .values({
          sessionId,
          patientId: session.patientId,
          status: 'borrador',
          generalInstructions: input.generalInstructions,
          createdBy: actor.actorId,
          createdByUsername: actor.actorUsername,
        })
        .returning({ id: prescriptions.id });
      const row = inserted[0];
      if (row === undefined) throw new NotFoundError('No se pudo guardar el récipe');
      prescriptionId = row.id;
    } else {
      await tx
        .update(prescriptions)
        .set({
          generalInstructions: input.generalInstructions,
          updatedAt: new Date(),
        })
        .where(eq(prescriptions.id, prescriptionId));
      await tx
        .delete(prescriptionItems)
        .where(eq(prescriptionItems.prescriptionId, prescriptionId));
    }

    await tx.insert(prescriptionItems).values(itemValues(prescriptionId, input.items));
    return prescriptionId;
  });

  return getPrescriptionDetail(db, id);
};

/* ── Emisión ───────────────────────────────────────────────────────────────── */

export interface IssueOptions {
  /** Base del enlace del QR (`PUBLIC_APP_URL`). */
  publicAppUrl: string;
  /** Ruta del logo del membrete (relativa a la raíz del repositorio). */
  logoPath: string | null;
  patientLookup: PatientSnapshotLookup;
  /**
   * Lectura de la identidad del consultorio (ADR 0056). Si no se pasa —o si identity
   * no responde—, el membrete sale con `CLINIC` (el respaldo del código).
   */
  letterheadLookup?: LetterheadLookup | undefined;
  /**
   * Lectura de la marca efectiva de los imprimibles (ADR 0060). Si no se pasa —o si
   * identity no responde—, el récipe sale con `BRAND` (el respaldo del código).
   */
  brandLookup?: BrandLookup | undefined;
}

const nextPrescriptionNumber = async (db: ClinicalDb): Promise<number> => {
  const result = await db.execute(sql`select nextval('prescription_number_seq') as number`);
  const fila = result.rows[0];
  if (fila === undefined) throw new NotFoundError('No se pudo tomar el número del récipe');
  return Number(fila['number']);
};

/**
 * Compone el PDF del récipe con Chromium (Playwright).
 *
 * El navegador **no vive en el código**: se busca en `PLAYWRIGHT_BROWSERS_PATH` (o en la caché
 * del usuario del servicio). Si falta —una instalación a la que no se le bajó el navegador—, le
 * faltan sus bibliotecas, o el proceso no puede arrancarlo por el endurecimiento de systemd,
 * `playwright` lanza un error de bajo nivel que, sin esto, llegaría al mostrador como un **500
 * opaco** («error interno del servidor»). Aquí se convierte en un **503 explicado** —el mismo
 * trato que le da el PDF de los reportes— para que quien lo vea sepa que es del servidor.
 */
const renderPrescriptionPdf = async (pdfRenderer: PdfRenderer, html: string): Promise<Buffer> => {
  try {
    return await pdfRenderer.render(html);
  } catch (error) {
    throw new ServiceUnavailableError(
      'No se pudo generar el PDF del récipe: revisa el navegador (Chromium) del servidor. ' +
        (error instanceof Error ? error.message : String(error)),
    );
  }
};

/**
 * Emite el récipe: número, PDF A5 archivado y código de verificación.
 *
 * El PDF se genera **antes** de tocar la base (Chromium tarda, y no se tiene una
 * transacción abierta mientras tanto) y después se confirma todo en una sola
 * transacción que solo avanza si el récipe sigue siendo borrador: si dos peticiones
 * emiten a la vez, la segunda recibe 409 y su PDF se descarta.
 */
export const issuePrescription = async (
  db: ClinicalDb,
  blobStore: BlobStore,
  pdfRenderer: PdfRenderer,
  id: string,
  actor: ActorContext,
  options: IssueOptions,
): Promise<PrescriptionDetail> => {
  const row = await loadRowOrFail(db, id);
  if (row.status !== 'borrador') {
    throw new ConflictError('El récipe ya está emitido (o anulado): no se emite dos veces', {
      extensions: { status: row.status, number: row.prescriptionNumber },
    });
  }

  const [items, session] = await Promise.all([
    loadItems(db, id),
    requireSession(db, row.sessionId),
  ]);
  if (items.length === 0) {
    throw new ConflictError('Un récipe sin medicamentos no se emite: añade al menos uno');
  }

  const patient = await options.patientLookup(row.patientId);
  if (patient === null) {
    throw new ServiceUnavailableError(
      'No se pudo leer la ficha del paciente: sin sus datos no se emite el récipe. Vuelve a intentarlo.',
    );
  }

  const prescriptionNumber = await nextPrescriptionNumber(db);
  const number = formatPrescriptionNumber(prescriptionNumber);
  const verifyCode = buildVerifyCode();
  const issuedAt = new Date();
  const verificationUrl = `${options.publicAppUrl.replace(/\/+$/, '')}/verificar/${verifyCode}`;
  const identidad =
    options.letterheadLookup === undefined
      ? null
      : await options.letterheadLookup(actor.actorUsername);
  const marca = options.brandLookup === undefined ? null : await options.brandLookup();

  const html = await prescriptionHtml({
    number,
    issuedAt,
    patientName: patient.fullName,
    patientDocument: patient.document,
    patientBirthDate: patient.birthDate === '' ? null : patient.birthDate,
    // El sexo decide la concordancia de «nacido / nacida» en el papel.
    patientSex: patient.sex === '' ? null : patient.sex,
    patientAge: patient.age,
    // La identidad del consultorio se lee una sola vez por emisión (con caché y
    // respaldo): de aquí salen quién firma, el membrete y el logo.
    clinic: identidad?.clinic ?? null,
    dentist: identidad?.dentist ?? clinicDentistFor(actor.actorUsername),
    items,
    generalInstructions: row.generalInstructions,
    verificationUrl,
    logoPath: options.logoPath,
    logoDataUri: identidad?.logoDataUri ?? null,
    brand: marca?.theme ?? null,
    fontFaceCss: marca?.fontFaceCss ?? null,
  } satisfies PrescriptionDocumentInput);

  const pdf = await renderPrescriptionPdf(pdfRenderer, html);
  const key = buildStorageKey('clinical', row.patientId, id, 'pdf');
  const stored = await blobStore.save({ key, data: pdf });

  try {
    const emitido = await db.transaction(async (tx) => {
      const updated = await tx
        .update(prescriptions)
        .set({
          prescriptionNumber,
          verifyCode,
          status: 'emitida',
          issuedAt,
          issuedBy: actor.actorId,
          issuedByUsername: actor.actorUsername,
          pdfPath: stored.path,
          pdfSha256: stored.sha256,
          generatedAt: new Date(),
          patientSnapshot: {
            fullName: patient.fullName,
            document: patient.document,
            birthDate: patient.birthDate,
            sex: patient.sex,
            age: patient.age,
          },
          updatedAt: new Date(),
        })
        // Solo avanza si sigue siendo borrador: es el cerrojo de la emisión.
        .where(and(eq(prescriptions.id, id), eq(prescriptions.status, 'borrador')))
        .returning();

      const fila = updated[0];
      if (fila === undefined) {
        throw new ConflictError('El récipe se emitió en otra pestaña hace un instante', {
          extensions: { prescriptionId: id },
        });
      }

      await publish(tx, {
        topic: EVENT_TOPICS.prescriptionIssued,
        aggregateId: id,
        actor,
        payload: {
          ...auditPayload({
            entityId: id,
            action: 'prescription_issued',
            entityType: 'prescription',
            summary: `Récipe ${number} emitido: ${String(items.length)} medicamento(s)`,
            changedFields: ['status'],
            before: { status: 'borrador' },
            after: {
              status: 'emitida',
              number,
              sessionId: row.sessionId,
              sessionNumber: session.sessionNumber,
              patientId: row.patientId,
              itemCount: items.length,
              verifyCode,
              pdfSha256: stored.sha256,
            },
            reason: null,
            actor,
          }),
          // Lo que la Fase 9 contará: medicamentos y fecha, sin datos clínicos.
          prescription: {
            id,
            number,
            sessionId: row.sessionId,
            patientId: row.patientId,
            issuedAt: issuedAt.toISOString(),
            medications: items.map((item) => item.medicationName),
          },
        },
      });

      return fila;
    });

    return {
      ...toSummary(emitido, items.length),
      items: items.map(toStoredItem),
      generalInstructions: emitido.generalInstructions,
    };
  } catch (error) {
    // La emisión no cuajó: el PDF tampoco se queda archivado.
    await blobStore.remove(stored.path).catch(() => undefined);
    throw error;
  }
};

/* ── Anulación y reimpresión ───────────────────────────────────────────────── */

export const annulPrescription = async (
  db: ClinicalDb,
  id: string,
  input: AnnulPrescriptionInput,
  actor: ActorContext,
): Promise<PrescriptionDetail> => {
  const row = await loadRowOrFail(db, id);
  if (row.status !== 'emitida') {
    throw new ConflictError(
      row.status === 'anulada'
        ? 'El récipe ya está anulado'
        : 'Un récipe en borrador se borra o se emite: no hay nada que anular',
      { extensions: { status: row.status } },
    );
  }

  await db.transaction(async (tx) => {
    await tx
      .update(prescriptions)
      .set({
        status: 'anulada',
        annulledAt: new Date(),
        annulledBy: actor.actorId,
        annulledByUsername: actor.actorUsername,
        annulReason: input.reason,
        updatedAt: new Date(),
      })
      .where(eq(prescriptions.id, id));

    await publish(tx, {
      topic: EVENT_TOPICS.prescriptionAnnulled,
      aggregateId: id,
      actor,
      payload: auditPayload({
        entityId: id,
        action: 'prescription_annulled',
        entityType: 'prescription',
        summary: `Récipe ${formatPrescriptionNumber(row.prescriptionNumber ?? 0)} anulado`,
        changedFields: ['status'],
        before: { status: 'emitida' },
        after: { status: 'anulada' },
        reason: input.reason,
        actor,
      }),
    });
  });

  return getPrescriptionDetail(db, id);
};

export interface PrintPrescriptionResult {
  id: string;
  printCount: number;
  lastPrintedAt: string;
}

/**
 * Deja constancia de una impresión o descarga. Lo cuenta la primera vez y todas las
 * demás: imprimir un récipe es un acto que queda en la auditoría (ADR 0015).
 */
export const registerPrescriptionPrint = async (
  db: ClinicalDb,
  id: string,
  actor: ActorContext,
): Promise<PrintPrescriptionResult> => {
  const row = await loadRowOrFail(db, id);
  if (row.pdfPath === null) {
    throw new ConflictError('El récipe todavía no está emitido: no hay PDF que imprimir', {
      extensions: { status: row.status },
    });
  }

  const ahora = new Date();
  const updated = await db.transaction(async (tx) => {
    const filas = await tx
      .update(prescriptions)
      .set({ printCount: row.printCount + 1, lastPrintedAt: ahora, updatedAt: ahora })
      .where(eq(prescriptions.id, id))
      .returning();
    const fila = filas[0];
    if (fila === undefined) throw new NotFoundError('El récipe no existe');

    await publish(tx, {
      topic: EVENT_TOPICS.prescriptionReprinted,
      aggregateId: id,
      actor,
      payload: auditPayload({
        entityId: id,
        action: 'prescription_reprinted',
        entityType: 'prescription',
        summary: `Récipe ${formatPrescriptionNumber(row.prescriptionNumber ?? 0)} impreso (${String(fila.printCount)}.ª vez)`,
        changedFields: ['printCount'],
        before: { printCount: row.printCount },
        after: { printCount: fila.printCount },
        reason: null,
        actor,
      }),
    });

    return fila;
  });

  return {
    id: updated.id,
    printCount: updated.printCount,
    lastPrintedAt: (updated.lastPrintedAt ?? ahora).toISOString(),
  };
};

/* ── PDF archivado ─────────────────────────────────────────────────────────── */

export interface PrescriptionPdf {
  buffer: Buffer;
  filename: string;
  sha256: string;
}

export const readPrescriptionPdf = async (
  db: ClinicalDb,
  blobStore: BlobStore,
  id: string,
): Promise<PrescriptionPdf> => {
  const row = await loadRowOrFail(db, id);
  if (row.pdfPath === null) {
    throw new ConflictError('El récipe todavía no está emitido: no hay PDF', {
      extensions: { status: row.status },
    });
  }
  const buffer = await blobStore.read(row.pdfPath);
  return {
    buffer,
    filename: `${formatPrescriptionNumber(row.prescriptionNumber ?? 0)}.pdf`,
    sha256: row.pdfSha256 ?? '',
  };
};

/* ── Verificación pública ──────────────────────────────────────────────────── */

/**
 * Lo que responde la página pública: que el papel es auténtico, **sin datos
 * clínicos** (ADR 0015). El nombre abreviado —«María P.», el mismo que usan las
 * pantallas de la sala— es lo único del paciente que sale, y sirve para que quien
 * tenga el papel reconozca que es suyo.
 */
export const verifyPrescription = async (
  db: ClinicalDb,
  rawCode: string,
  clinicName: string,
): Promise<PrescriptionVerificationResult> => {
  const code = normalizeVerifyCode(rawCode);
  const mostrar = formatVerifyCode(code);

  const rows = await db
    .select()
    .from(prescriptions)
    .where(eq(prescriptions.verifyCode, code))
    .limit(1);
  const row = rows[0];
  if (row === undefined) return { valid: false, code: mostrar };

  const items = await loadItems(db, row.id);
  const snapshot = (row.patientSnapshot ?? {}) as { fullName?: unknown };
  const nombre = typeof snapshot.fullName === 'string' ? snapshot.fullName : null;
  const odontologo = clinicDentistFor(row.issuedByUsername);

  const verificacion: PrescriptionVerification = {
    valid: true,
    code: mostrar,
    clinicName,
    issuedAt: (row.issuedAt ?? row.createdAt).toISOString(),
    dentistName: odontologo?.fullName ?? null,
    dentistMpps: odontologo?.mpps ?? null,
    patientReference: nombre === null ? 'Paciente' : abbreviateName(nombre),
    status: row.status as PrescriptionVerification['status'],
    itemCount: items.length,
  };
  return verificacion;
};
