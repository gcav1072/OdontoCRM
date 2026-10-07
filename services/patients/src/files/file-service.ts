import {
  ALLOWED_FILE_MIME_TYPES,
  MAX_FILE_BYTES,
  PATIENT_FILE_KINDS,
  type PatientFile,
  type PatientFileKind,
} from '@odontocrm/contracts';
import { buildStorageKey, safeExtension, type BlobStore } from '@odontocrm/storage';
import { AppError, NotFoundError } from '@odontocrm/kernel';
import { and, desc, eq, isNull } from 'drizzle-orm';

import type { PatientsDb } from '../db/client.js';
import { patientFiles, type PatientFileRow } from '../db/schema.js';
import { findPatientById } from '../patients/patient-service.js';

export const toPatientFile = (row: PatientFileRow): PatientFile => ({
  id: row.id,
  patientId: row.patientId,
  kind: row.kind as PatientFileKind,
  originalName: row.originalName,
  mime: row.mime,
  size: row.size,
  sha256: row.sha256,
  caption: row.caption,
  uploadedBy: row.uploadedBy,
  createdAt: row.createdAt.toISOString(),
});

export interface SaveFileInput {
  patientId: string;
  kind: string;
  originalName: string;
  mime: string;
  data: Buffer;
  caption?: string | undefined;
  uploadedBy: string | null;
}

/** Valida tipo y tamaño antes de escribir nada en el almacén. */
export const assertFileAcceptable = (
  mime: string,
  size: number,
  maxBytes = MAX_FILE_BYTES,
): void => {
  if (!(ALLOWED_FILE_MIME_TYPES as readonly string[]).includes(mime)) {
    throw new AppError({
      status: 415,
      code: 'unsupported_media_type',
      message: 'Solo se aceptan imágenes JPG, PNG, WEBP o documentos PDF',
    });
  }
  if (size > maxBytes) {
    throw new AppError({
      status: 413,
      code: 'file_too_large',
      message: `El archivo supera el máximo de ${String(Math.round(maxBytes / (1024 * 1024)))} MB`,
    });
  }
  if (size === 0) {
    throw new AppError({ status: 400, code: 'empty_file', message: 'El archivo está vacío' });
  }
};

export const savePatientFile = async (
  db: PatientsDb,
  blobStore: BlobStore,
  input: SaveFileInput,
  maxBytes = MAX_FILE_BYTES,
): Promise<PatientFile> => {
  const patient = await findPatientById(db, input.patientId);
  if (patient === null) throw new NotFoundError('El paciente no existe');

  const kind = PATIENT_FILE_KINDS.includes(input.kind as PatientFileKind)
    ? (input.kind as PatientFileKind)
    : null;
  if (kind === null) {
    throw new AppError({
      status: 400,
      code: 'invalid_file_kind',
      message: `Tipo de archivo no reconocido (${PATIENT_FILE_KINDS.join(', ')})`,
    });
  }

  assertFileAcceptable(input.mime, input.data.byteLength, maxBytes);

  const fileId = globalThis.crypto.randomUUID();
  const extension = safeExtension(input.originalName, input.mime);
  const key = buildStorageKey('patients', input.patientId, fileId, extension);
  const stored = await blobStore.save({ key, data: input.data });

  const inserted = await db
    .insert(patientFiles)
    .values({
      id: fileId,
      patientId: input.patientId,
      kind,
      originalName: input.originalName.slice(0, 180),
      mime: input.mime,
      size: stored.size,
      sha256: stored.sha256,
      storagePath: stored.path,
      caption: input.caption ?? null,
      uploadedBy: input.uploadedBy,
    })
    .returning();

  const row = inserted[0];
  if (row === undefined) throw new NotFoundError('No se pudo guardar el archivo');
  return toPatientFile(row);
};

export const listPatientFiles = async (
  db: PatientsDb,
  patientId: string,
): Promise<PatientFile[]> => {
  const rows = await db
    .select()
    .from(patientFiles)
    .where(and(eq(patientFiles.patientId, patientId), isNull(patientFiles.deletedAt)))
    .orderBy(desc(patientFiles.createdAt));
  return rows.map(toPatientFile);
};

export interface FileWithContent {
  file: PatientFile;
  content: Buffer;
}

export const getPatientFile = async (
  db: PatientsDb,
  blobStore: BlobStore,
  patientId: string,
  fileId: string,
): Promise<FileWithContent> => {
  const rows = await db
    .select()
    .from(patientFiles)
    .where(
      and(
        eq(patientFiles.id, fileId),
        eq(patientFiles.patientId, patientId),
        isNull(patientFiles.deletedAt),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (row === undefined) throw new NotFoundError('El archivo no existe');

  // Se lee por el **almacén** y no por la ruta: con el cifrado en reposo activo el archivo
  // en disco no es el contenido, y servir la ruta devolvería basura al navegador.
  return { file: toPatientFile(row), content: await blobStore.read(row.storagePath) };
};

/**
 * Borra el archivo del almacén y marca la fila como eliminada (no se destruye el
 * registro: la auditoría clínica exige saber que existió).
 */
export const deletePatientFile = async (
  db: PatientsDb,
  blobStore: BlobStore,
  patientId: string,
  fileId: string,
): Promise<void> => {
  const rows = await db
    .select()
    .from(patientFiles)
    .where(
      and(
        eq(patientFiles.id, fileId),
        eq(patientFiles.patientId, patientId),
        isNull(patientFiles.deletedAt),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (row === undefined) throw new NotFoundError('El archivo no existe');

  await blobStore.remove(row.storagePath);
  await db.update(patientFiles).set({ deletedAt: new Date() }).where(eq(patientFiles.id, fileId));
};
