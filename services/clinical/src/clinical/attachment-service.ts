import {
  CLINICAL_ATTACHMENT_MIME_TYPES,
  MAX_FILE_BYTES,
  type ClinicalAttachment,
  type ClinicalAttachmentKind,
  type ClinicalAttachmentList,
} from '@odontocrm/contracts';
import { EVENT_TOPICS } from '@odontocrm/events';
import { AppError, ConflictError, NotFoundError } from '@odontocrm/kernel';
import { buildStorageKey, safeExtension, type BlobStore } from '@odontocrm/storage';
import { asc, desc, eq } from 'drizzle-orm';

import type { ClinicalDb } from '../db/client.js';
import { clinicalSessionFiles, type ClinicalSessionFileRow } from '../db/schema.js';
import type { ActorContext } from '../shared/context.js';
import { auditPayload, publish } from '../shared/events.js';
import { requireSession } from './session-service.js';

/**
 * Adjuntos de la sesión: radiografías, fotos clínicas y documentos.
 *
 * El binario va al **almacén compartido** (la ruta la construye el servicio a
 * partir de identificadores validados, nunca el cliente) y los metadatos a la base,
 * en la misma operación. Un adjunto pertenece siempre a una sesión: es la sesión la
 * que dice de qué visita es la radiografía.
 */

export const toAttachment = (row: ClinicalSessionFileRow): ClinicalAttachment => ({
  id: row.id,
  sessionId: row.sessionId,
  patientId: row.patientId,
  kind: row.kind as ClinicalAttachmentKind,
  originalName: row.originalName,
  mime: row.mime,
  size: row.sizeBytes,
  sha256: row.sha256,
  caption: row.caption,
  toothNumber: row.toothNumber,
  uploadedByUsername: row.uploadedByUsername,
  createdAt: row.createdAt.toISOString(),
});

/** Valida tipo y tamaño **antes** de escribir nada en el almacén. */
export const assertAttachmentAcceptable = (mime: string, size: number, maxBytes: number): void => {
  if (!(CLINICAL_ATTACHMENT_MIME_TYPES as readonly string[]).includes(mime)) {
    throw new AppError({
      status: 415,
      code: 'unsupported_media_type',
      message: 'Solo se admiten imágenes JPG, PNG, WEBP o PDF',
      extensions: { allowed: [...CLINICAL_ATTACHMENT_MIME_TYPES] },
    });
  }
  if (size > maxBytes) {
    throw new AppError({
      status: 413,
      code: 'file_too_large',
      message: `El archivo supera el máximo de ${String(Math.round(maxBytes / (1024 * 1024)))} MB`,
      extensions: { maxBytes },
    });
  }
};

export interface SaveAttachmentInput {
  sessionId: string;
  kind: ClinicalAttachmentKind;
  originalName: string;
  mime: string;
  data: Buffer;
  caption?: string | undefined;
  toothNumber?: number | null;
}

/**
 * Guarda un adjunto: primero el archivo, luego la fila. Si la fila falla, el
 * archivo se borra (no quedan binarios huérfanos).
 */
export const saveAttachment = async (
  db: ClinicalDb,
  blobStore: BlobStore,
  input: SaveAttachmentInput,
  actor: ActorContext,
  maxBytes = MAX_FILE_BYTES,
): Promise<ClinicalAttachment> => {
  const session = await requireSession(db, input.sessionId);
  assertAttachmentAcceptable(input.mime, input.data.byteLength, maxBytes);

  const fileId = globalThis.crypto.randomUUID();
  const extension = safeExtension(input.originalName, input.mime);
  const key = buildStorageKey('clinical', input.sessionId, fileId, extension);
  const stored = await blobStore.save({ key, data: input.data });

  try {
    return await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(clinicalSessionFiles)
        .values({
          id: fileId,
          sessionId: input.sessionId,
          patientId: session.patientId,
          kind: input.kind,
          originalName: input.originalName,
          mime: input.mime,
          sizeBytes: stored.size,
          storagePath: stored.path,
          sha256: stored.sha256,
          caption: input.caption ?? null,
          toothNumber: input.toothNumber ?? null,
          uploadedBy: actor.actorId,
          uploadedByUsername: actor.actorUsername,
        })
        .returning();

      const row = inserted[0];
      if (row === undefined) throw new NotFoundError('No se pudo guardar el adjunto');

      await publish(tx, {
        topic: EVENT_TOPICS.sessionFileUploaded,
        aggregateId: row.id,
        actor,
        payload: auditPayload({
          entityId: session.id,
          action: 'clinical_session_file_uploaded',
          entityType: 'clinical_session',
          summary: `Adjunto de la sesión ${String(session.sessionNumber)}: ${input.originalName}`,
          changedFields: ['attachments'],
          after: {
            attachmentId: row.id,
            kind: row.kind,
            mime: row.mime,
            size: row.sizeBytes,
            toothNumber: row.toothNumber,
          },
          reason: null,
          actor,
        }),
      });

      return toAttachment(row);
    });
  } catch (error) {
    // La fila no se guardó: el binario tampoco (nada de archivos huérfanos).
    await blobStore.remove(stored.path).catch(() => undefined);
    throw error;
  }
};

export const listAttachments = async (
  db: ClinicalDb,
  sessionId: string,
): Promise<ClinicalAttachmentList> => {
  const rows = await db
    .select()
    .from(clinicalSessionFiles)
    .where(eq(clinicalSessionFiles.sessionId, sessionId))
    .orderBy(asc(clinicalSessionFiles.createdAt));
  return { items: rows.map(toAttachment), total: rows.length };
};

/**
 * Todos los adjuntos del paciente, del más reciente al más antiguo. Es lo que
 * enseña la ficha del paciente: las radiografías de todas sus sesiones, con la
 * sesión a la que pertenece cada una.
 */
export const listAttachmentsByPatient = async (
  db: ClinicalDb,
  patientId: string,
): Promise<ClinicalAttachmentList> => {
  const rows = await db
    .select()
    .from(clinicalSessionFiles)
    .where(eq(clinicalSessionFiles.patientId, patientId))
    .orderBy(desc(clinicalSessionFiles.createdAt));
  return { items: rows.map(toAttachment), total: rows.length };
};

export interface AttachmentFile {
  attachment: ClinicalAttachment;
  content: Buffer;
}

const loadAttachmentOrFail = async (
  db: ClinicalDb,
  blobStore: BlobStore,
  sessionId: string,
  attachmentId: string,
): Promise<{ row: ClinicalSessionFileRow; content: Buffer }> => {
  const rows = await db
    .select()
    .from(clinicalSessionFiles)
    .where(eq(clinicalSessionFiles.id, attachmentId))
    .limit(1);
  const row = rows[0];
  if (row === undefined || row.sessionId !== sessionId) {
    throw new NotFoundError('El adjunto no existe en esta sesión');
  }
  // Se lee por el **almacén** (que descifra si hace falta) y no por la ruta: con el cifrado
  // en reposo activo, el archivo en disco no es el contenido.
  return { row, content: await blobStore.read(row.storagePath) };
};

/** Adjunto con su contenido, para servirlo por una ruta autorizada. */
export const getAttachmentFile = async (
  db: ClinicalDb,
  blobStore: BlobStore,
  sessionId: string,
  attachmentId: string,
): Promise<AttachmentFile> => {
  const { row, content } = await loadAttachmentOrFail(db, blobStore, sessionId, attachmentId);
  return { attachment: toAttachment(row), content };
};

/**
 * Borra un adjunto **solo de una sesión en borrador**: lo que ya se cerró es el
 * documento de la visita, y una radiografía de esa visita no se quita sin dejar
 * rastro. Si estaba equivocada, se sube la correcta y se anota en el pie de foto.
 */
export const deleteAttachment = async (
  db: ClinicalDb,
  blobStore: BlobStore,
  sessionId: string,
  attachmentId: string,
  actor: ActorContext,
): Promise<void> => {
  const session = await requireSession(db, sessionId);
  if (session.status !== 'borrador') {
    throw new ConflictError(
      'La sesión está cerrada: sus adjuntos son parte del documento. Sube el archivo correcto en su lugar.',
      { extensions: { status: session.status } },
    );
  }

  const { row } = await loadAttachmentOrFail(db, blobStore, sessionId, attachmentId);

  await db.transaction(async (tx) => {
    await tx.delete(clinicalSessionFiles).where(eq(clinicalSessionFiles.id, attachmentId));

    await publish(tx, {
      topic: EVENT_TOPICS.sessionFileRemoved,
      aggregateId: row.id,
      actor,
      payload: auditPayload({
        entityId: session.id,
        action: 'clinical_session_file_removed',
        entityType: 'clinical_session',
        summary: `Adjunto quitado de la sesión ${String(session.sessionNumber)}: ${row.originalName}`,
        changedFields: ['attachments'],
        before: { attachmentId: row.id, originalName: row.originalName },
        reason: null,
        actor,
      }),
    });
  });

  await blobStore.remove(row.storagePath).catch(() => undefined);
};
