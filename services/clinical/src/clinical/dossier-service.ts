import {
  abbreviateName,
  clinicalAlerts,
  clinicDentistFor,
  formatDossierNumber,
  type DossierExport,
  type DossierVerification,
  type DossierVerificationResult,
} from '@odontocrm/contracts';
import { EVENT_TOPICS } from '@odontocrm/events';
import { ConflictError, NotFoundError, ServiceUnavailableError } from '@odontocrm/kernel';
import type { BrandLookup, LetterheadLookup } from '@odontocrm/kernel';
import { buildStorageKey, type BlobStore } from '@odontocrm/storage';
import { desc, eq, sql } from 'drizzle-orm';

import type { ClinicalDb } from '../db/client.js';
import { dossierExports, type DossierExportRow } from '../db/schema.js';
import type { PdfRenderer } from '../prescriptions/pdf-renderer.js';
import type { ActorContext } from '../shared/context.js';
import { auditPayload, publish } from '../shared/events.js';
import { buildVerifyCode, formatVerifyCode, normalizeVerifyCode } from '../shared/verify-code.js';
import type { PatientSnapshotLookup } from '../shared/patient-client.js';
import { dossierHtml, dossierFooterTemplate } from './dossier-document.js';
import { findRecordByPatient, getRecordDetail } from './record-service.js';
import { getPrescriptionDetail, listPrescriptionsByPatient } from './prescription-service.js';
import { listClosedSessionsChronological } from './session-service.js';
import type { OdontogramChartLookup } from '../shared/odontogram-client.js';

/**
 * El **dossier del expediente**: se reúne todo lo que el consultorio sabe del paciente
 * —filiación, alertas, odontograma, evolución y farmacia— en un PDF A4 foliado, se
 * archiva con su huella y se entrega.
 *
 * El orden de la composición imita al del récipe, y por la misma razón: el PDF se
 * compone **antes** de tocar la base (Chromium tarda y no se tiene una transacción
 * abierta mientras tanto) y luego se confirma el registro en una transacción corta. Si
 * el registro falla, el archivo huérfano se descarta —un dossier sin fila no se puede
 * verificar, así que no sirve—.
 *
 * El correlativo sale de `dossier_exports_number_seq`, igual que el récipe: los huecos
 * que deja un fallo al componer el PDF son aceptables (como en cualquier numeración de
 * documentos) y a cambio dos exportaciones simultáneas nunca comparten número.
 */

interface DossierDeps {
  db: ClinicalDb;
  blobStore: BlobStore;
  pdfRenderer: PdfRenderer;
  patientLookup: PatientSnapshotLookup;
  odontogramLookup: OdontogramChartLookup;
}

export interface IssueDossierOptions {
  /** `PUBLIC_APP_URL`, base del enlace del QR. */
  publicAppUrl: string;
  /** Ruta del logo del membrete (relativa a la raíz del repositorio). */
  logoPath: string | null;
  /** Lectura de la identidad del consultorio (ADR 0056); sin ella, se usa `CLINIC`. */
  letterheadLookup?: LetterheadLookup | undefined;
  /** Lectura de la marca efectiva (ADR 0060); sin ella, se usa `BRAND`. */
  brandLookup?: BrandLookup | undefined;
}

export interface IssuedDossier {
  /** Metadatos de la exportación registrada. */
  export: DossierExport;
  /** El PDF compuesto, listo para enviar al cliente. */
  pdf: Buffer;
}

/**
 * Cuenta las hojas del PDF.
 *
 * Chromium no dice cuántas salieron y el renderizador devuelve solo los bytes, así que
 * se cuentan los objetos `/Type /Page` del documento (`/Type /Pages` es el nodo del
 * árbol, no una hoja). Es una **estimación para el registro** —nada del sistema depende
 * de ella—: si algún día importara de verdad, habría que leer el `/Count` del catálogo.
 */
const countPdfPages = (pdf: Buffer): number =>
  (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;

const nextDossierNumber = async (db: ClinicalDb): Promise<number> => {
  const result = await db.execute<{ number: number }>(
    sql`select nextval('dossier_exports_number_seq') as number`,
  );
  const row = (result.rows as { number: number }[])[0];
  if (row === undefined) throw new ConflictError('No se pudo tomar el número del dossier');
  return Number(row.number);
};

const toExport = (row: DossierExportRow): DossierExport => ({
  id: row.id,
  number: formatDossierNumber(row.number),
  patientId: row.patientId,
  issuedAt: row.issuedAt.toISOString(),
  issuedByUsername: row.issuedByUsername,
  verifyCode: formatVerifyCode(row.verifyCode),
  sha256: row.pdfSha256,
  pageCount: row.pageCount,
});

/** Exportaciones ya archivadas del paciente, de la más reciente a la más antigua. */
export const listDossierExports = async (
  db: ClinicalDb,
  patientId: string,
): Promise<DossierExport[]> => {
  const rows = await db
    .select()
    .from(dossierExports)
    .where(eq(dossierExports.patientId, patientId))
    .orderBy(desc(dossierExports.issuedAt));
  return rows.map(toExport);
};

/**
 * Compone el dossier del paciente y lo archiva.
 *
 * **Sin ficha del paciente se aborta** (503): un dossier sin nombre ni documento no
 * identifica a nadie y sería un documento peligroso. Sin odontograma, en cambio, sigue
 * adelante: el dibujo se sustituye por el aviso de que no hay hallazgos registrados, que
 * es información clínica legítima.
 */
export const issueDossier = async (
  deps: DossierDeps,
  patientId: string,
  actor: ActorContext,
  options: IssueDossierOptions,
): Promise<IssuedDossier> => {
  const patient = await deps.patientLookup(patientId);
  if (patient === null) {
    throw new ServiceUnavailableError(
      'No se pudo leer la ficha del paciente: sin sus datos no se exporta el expediente. Vuelve a intentarlo.',
    );
  }

  // Las cuatro fuentes, en paralelo: son consultas independientes y el dossier las
  // necesita todas antes de componer nada.
  const [record, sessions, prescriptionsList, odontogram] = await Promise.all([
    findRecordByPatient(deps.db, patientId),
    listClosedSessionsChronological(deps.db, patientId),
    listPrescriptionsByPatient(deps.db, patientId),
    deps.odontogramLookup(patientId),
  ]);

  // Las alertas se derivan de la anamnesis (las mismas que pinta el consultorio).
  const alerts =
    record === null ? [] : clinicalAlerts((await getRecordDetail(deps.db, record.id)).sections);

  // Los medicamentos de cada récipe: el resumen no los trae y el historial farmacológico
  // sin los nombres de los fármacos no diría nada.
  const prescriptions = await Promise.all(
    prescriptionsList.items.map(async (summary) => {
      const detail = await getPrescriptionDetail(deps.db, summary.id);
      return { summary, medications: detail.items.map((item) => item.medicationName) };
    }),
  );

  const number = await nextDossierNumber(deps.db);
  const formatted = formatDossierNumber(number);
  const verifyCode = buildVerifyCode();
  const issuedAt = new Date();
  const verificationUrl = `${options.publicAppUrl.replace(/\/+$/, '')}/verificar-expediente/${verifyCode}`;
  const identidad =
    options.letterheadLookup === undefined
      ? null
      : await options.letterheadLookup(actor.actorUsername);
  const marca = options.brandLookup === undefined ? null : await options.brandLookup();

  const html = await dossierHtml({
    number: formatted,
    issuedAt,
    patient,
    alerts,
    odontogram: { dentition: odontogram.dentition, findings: odontogram.findings },
    sessions: sessions.map((session) => ({
      sessionNumber: session.sessionNumber,
      closedAt: session.closedAt,
      content: session.content,
    })),
    prescriptions,
    clinic: identidad?.clinic ?? null,
    dentist: identidad?.dentist ?? clinicDentistFor(actor.actorUsername),
    verificationUrl,
    logoPath: options.logoPath,
    logoDataUri: identidad?.logoDataUri ?? null,
    brand: marca?.theme ?? null,
    fontFaceCss: marca?.fontFaceCss ?? null,
  });

  const pdf = await deps.pdfRenderer.render(html, {
    format: 'A4',
    footerHtml: dossierFooterTemplate(formatted),
    marginMm: { top: 12, bottom: 16, left: 14, right: 14 },
  });

  const key = buildStorageKey('clinical', patientId, `dossier-${verifyCode.toLowerCase()}`, 'pdf');
  const stored = await deps.blobStore.save({ key, data: pdf });
  const pageCount = countPdfPages(pdf);

  try {
    const registered = await deps.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(dossierExports)
        .values({
          number,
          patientId,
          patientSnapshot: {
            fullName: patient.fullName,
            document: patient.document,
            birthDate: patient.birthDate,
            sex: patient.sex,
            age: patient.age,
          },
          issuedAt,
          issuedBy: actor.actorId,
          issuedByUsername: actor.actorUsername,
          verifyCode,
          pdfPath: stored.path,
          pdfSha256: stored.sha256,
          pageCount,
        })
        .returning();

      const row = inserted[0];
      if (row === undefined) throw new ConflictError('No se pudo registrar la exportación');

      await publish(tx, {
        topic: EVENT_TOPICS.dossierExported,
        aggregateId: patientId,
        actor,
        payload: {
          ...auditPayload({
            entityId: row.id,
            action: 'dossier_exported',
            entityType: 'dossier',
            summary: `Expediente ${formatted} exportado (${String(pageCount)} hoja(s))`,
            after: {
              dossierId: row.id,
              number: formatted,
              patientId,
              verifyCode,
              pdfSha256: stored.sha256,
              sessions: sessions.length,
              prescriptions: prescriptions.length,
            },
            actor,
          }),
        },
      });

      return row;
    });

    return { export: toExport(registered), pdf };
  } catch (error) {
    // Sin fila no hay dossier verificable: el archivo no sirve para nada y se borra.
    await deps.blobStore.remove(stored.path).catch(() => undefined);
    throw error;
  }
};

/** El PDF archivado de una exportación (para volver a descargarlo sin recomponerlo). */
export const readDossierPdf = async (
  db: ClinicalDb,
  blobStore: BlobStore,
  id: string,
): Promise<{ buffer: Buffer; number: string }> => {
  const rows = await db.select().from(dossierExports).where(eq(dossierExports.id, id)).limit(1);
  const row = rows[0];
  if (row === undefined) throw new NotFoundError('La exportación del expediente no existe');

  return {
    buffer: await blobStore.read(row.pdfPath),
    number: formatDossierNumber(row.number),
  };
};

/* ── Verificación pública ──────────────────────────────────────────────────── */

/**
 * Lo que responde la página pública: que el papel es auténtico, **sin datos clínicos**
 * (el mismo criterio del récipe, ADR 0015). Del paciente sale solo el nombre abreviado
 * —«María P.»—, que basta para que quien tenga el papel reconozca que es suyo.
 */
export const verifyDossier = async (
  db: ClinicalDb,
  rawCode: string,
  clinicName: string,
): Promise<DossierVerificationResult> => {
  const code = normalizeVerifyCode(rawCode);
  if (code.length === 0) return { valid: false, number: null };

  const rows = await db
    .select()
    .from(dossierExports)
    .where(eq(dossierExports.verifyCode, code))
    .limit(1);
  const row = rows[0];
  if (row === undefined) return { valid: false, number: null };

  const snapshot = (row.patientSnapshot ?? {}) as { fullName?: unknown };
  const nombre = typeof snapshot.fullName === 'string' ? snapshot.fullName : null;
  const odontologo = clinicDentistFor(row.issuedByUsername);

  const verificacion: DossierVerification = {
    valid: true,
    number: formatDossierNumber(row.number),
    clinicName,
    issuedAt: row.issuedAt.toISOString(),
    dentistName: odontologo?.fullName ?? null,
    dentistMpps: odontologo?.mpps ?? null,
    patientReference: nombre === null ? 'Paciente' : abbreviateName(nombre),
    sha256: row.pdfSha256,
  };
  return verificacion;
};
