import {
  CLINICAL_ATTACHMENT_KINDS,
  createPrescriptionSchema,
  annulPrescriptionSchema,
  issuePrescriptionSchema,
  type ClinicalAttachmentKind,
} from '@odontocrm/contracts';
import { CLINIC } from '@odontocrm/contracts';
import { AppError, multipartFieldValue, parseOrThrow, requirePermission } from '@odontocrm/kernel';
import type { MultipartFile } from '@fastify/multipart';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import {
  deleteAttachment,
  getAttachmentFile,
  listAttachments,
  listAttachmentsByPatient,
  saveAttachment,
} from '../clinical/attachment-service.js';
import {
  annulPrescription,
  getPrescriptionDetail,
  issuePrescription,
  listMedications,
  listPrescriptionsByPatient,
  listPrescriptionsBySession,
  readPrescriptionPdf,
  registerPrescriptionPrint,
  saveDraft,
  verifyPrescription,
} from '../clinical/prescription-service.js';
import type { ClinicalServices } from '../services.js';
import { actorFrom } from '../shared/context.js';

const sessionParamsSchema = z.object({ id: z.uuid() });
const prescriptionParamsSchema = z.object({ id: z.uuid() });
const patientParamsSchema = z.object({ patientId: z.uuid() });
const codeParamsSchema = z.object({ code: z.string().trim().min(4).max(40) });

const attachmentParamsSchema = z.object({ id: z.uuid(), attachmentId: z.uuid() });

const uploadFieldsSchema = z.object({
  kind: z.enum(CLINICAL_ATTACHMENT_KINDS),
  caption: z.string().trim().max(240).optional(),
  toothNumber: z.coerce.number().int().min(11).max(85).optional(),
});

/**
 * Adjuntos de la sesión y récipes (Fase 7, sesión B).
 *
 * Todo pasa por aquí salvo la **verificación pública** (`/clinical/verify/:code`),
 * que es la única ruta sin sesión: la abre cualquiera que tenga el papel en la mano
 * y solo confirma que el récipe es auténtico.
 */
export const registerPrescriptionRoutes = (
  app: FastifyInstance,
  services: ClinicalServices,
): void => {
  const { db, blobStore, pdfRenderer, patientLookup, letterheadLookup, config, kickOutbox } =
    services;
  const read = requirePermission('clinical:read');
  const write = requirePermission('clinical:write');

  const publicarYa = (): void => kickOutbox?.();

  /* ── Adjuntos de la sesión ───────────────────────────────────────────────── */

  app.get(
    '/api/v1/clinical/sessions/:id/attachments',
    { preHandler: read },
    async (request, reply) => {
      const { id } = parseOrThrow(sessionParamsSchema, request.params);
      return reply.status(200).send(await listAttachments(db, id));
    },
  );

  /**
   * Todos los adjuntos del paciente, con la sesión a la que pertenece cada uno: es
   * lo que enseña la ficha del paciente (radiografías de todas sus visitas).
   */
  app.get(
    '/api/v1/clinical/patients/:patientId/attachments',
    { preHandler: read },
    async (request, reply) => {
      const { patientId } = parseOrThrow(patientParamsSchema, request.params);
      return reply.status(200).send(await listAttachmentsByPatient(db, patientId));
    },
  );

  /**
   * Subida de una radiografía, foto o documento. `attachFieldsToBody` deja los
   * campos de texto en `request.body` y el archivo en `request.body.file`.
   */
  app.post(
    '/api/v1/clinical/sessions/:id/attachments',
    { preHandler: write },
    async (request, reply) => {
      const actor = actorFrom(request);
      const { id } = parseOrThrow(sessionParamsSchema, request.params);

      const body = request.body as
        | { file?: MultipartFile; kind?: unknown; caption?: unknown; toothNumber?: unknown }
        | undefined;

      const file = body?.file;
      if (file === undefined) {
        throw new AppError({
          status: 400,
          code: 'missing_file',
          message: 'Adjunta un archivo en el campo «file»',
        });
      }

      const fields = parseOrThrow(uploadFieldsSchema, {
        kind: multipartFieldValue(body?.kind),
        caption: multipartFieldValue(body?.caption),
        toothNumber: multipartFieldValue(body?.toothNumber),
      });

      const saved = await saveAttachment(
        db,
        blobStore,
        {
          sessionId: id,
          kind: fields.kind as ClinicalAttachmentKind,
          originalName: file.filename ?? 'archivo',
          mime: file.mimetype,
          data: await file.toBuffer(),
          caption: fields.caption,
          toothNumber: fields.toothNumber ?? null,
        },
        actor,
        config.MAX_FILE_BYTES,
      );

      publicarYa();
      return reply.status(201).send(saved);
    },
  );

  /** Descarga del adjunto: el servicio comprueba que es de esa sesión. */
  app.get(
    '/api/v1/clinical/sessions/:id/attachments/:attachmentId',
    { preHandler: read },
    async (request, reply) => {
      const { id, attachmentId } = parseOrThrow(attachmentParamsSchema, request.params);
      const { attachment, content } = await getAttachmentFile(db, blobStore, id, attachmentId);
      return reply
        .status(200)
        .header('content-type', attachment.mime)
        .header(
          'content-disposition',
          `inline; filename="${encodeURIComponent(attachment.originalName)}"`,
        )
        .send(content);
    },
  );

  app.delete(
    '/api/v1/clinical/sessions/:id/attachments/:attachmentId',
    { preHandler: write },
    async (request, reply) => {
      const actor = actorFrom(request);
      const { id, attachmentId } = parseOrThrow(attachmentParamsSchema, request.params);
      await deleteAttachment(db, blobStore, id, attachmentId, actor);
      publicarYa();
      return reply.status(204).send();
    },
  );

  /* ── Catálogo de medicamentos ────────────────────────────────────────────── */

  app.get('/api/v1/clinical/medications', { preHandler: read }, async (request, reply) => {
    const { search } = request.query as { search?: string };
    return reply.status(200).send(await listMedications(db, search));
  });

  /* ── Récipes ─────────────────────────────────────────────────────────────── */

  /** Los récipes de una sesión (normalmente uno emitido y, si se corrigió, otro). */
  app.get(
    '/api/v1/clinical/sessions/:id/prescriptions',
    { preHandler: read },
    async (request, reply) => {
      const { id } = parseOrThrow(sessionParamsSchema, request.params);
      return reply.status(200).send(await listPrescriptionsBySession(db, id));
    },
  );

  /** Historial de récipes del paciente, del último al primero. */
  app.get(
    '/api/v1/clinical/patients/:patientId/prescriptions',
    { preHandler: read },
    async (request, reply) => {
      const { patientId } = parseOrThrow(patientParamsSchema, request.params);
      return reply.status(200).send(await listPrescriptionsByPatient(db, patientId));
    },
  );

  /** Guarda el borrador del récipe de la sesión (idempotente: reemplaza el anterior). */
  app.put(
    '/api/v1/clinical/sessions/:id/prescription',
    { preHandler: write },
    async (request, reply) => {
      const actor = actorFrom(request);
      const { id } = parseOrThrow(sessionParamsSchema, request.params);
      const input = parseOrThrow(createPrescriptionSchema, {
        ...(request.body ?? {}),
        sessionId: id,
      });
      return reply.status(200).send(await saveDraft(db, id, input, actor));
    },
  );

  app.get('/api/v1/clinical/prescriptions/:id', { preHandler: read }, async (request, reply) => {
    const { id } = parseOrThrow(prescriptionParamsSchema, request.params);
    return reply.status(200).send(await getPrescriptionDetail(db, id));
  });

  /** Emitir: número, PDF A5 archivado y código de verificación. */
  app.post(
    '/api/v1/clinical/prescriptions/:id/issue',
    { preHandler: write },
    async (request, reply) => {
      const actor = actorFrom(request);
      const { id } = parseOrThrow(prescriptionParamsSchema, request.params);
      parseOrThrow(issuePrescriptionSchema, request.body ?? {});
      const prescription = await issuePrescription(db, blobStore, pdfRenderer, id, actor, {
        publicAppUrl: config.PUBLIC_APP_URL,
        logoPath: CLINIC.logoPath,
        patientLookup,
        letterheadLookup,
      });
      publicarYa();
      return reply.status(200).send(prescription);
    },
  );

  /** Anular con motivo: un récipe emitido no se borra. */
  app.post(
    '/api/v1/clinical/prescriptions/:id/annul',
    { preHandler: write },
    async (request, reply) => {
      const actor = actorFrom(request);
      const { id } = parseOrThrow(prescriptionParamsSchema, request.params);
      const input = parseOrThrow(annulPrescriptionSchema, request.body ?? {});
      const prescription = await annulPrescription(db, id, input, actor);
      publicarYa();
      return reply.status(200).send(prescription);
    },
  );

  /**
   * El PDF archivado. Exige solo `clinical:read` porque imprimir es leer (la
   * secretaría imprime los récipes igual que la historia): la descarga deja su
   * constancia en la auditoría con `printed`, que es otro paso.
   */
  app.get(
    '/api/v1/clinical/prescriptions/:id/pdf',
    { preHandler: read },
    async (request, reply) => {
      const { id } = parseOrThrow(prescriptionParamsSchema, request.params);
      const pdf = await readPrescriptionPdf(db, blobStore, id);
      return reply
        .status(200)
        .header('content-type', 'application/pdf')
        .header('content-disposition', `inline; filename="${pdf.filename}"`)
        .send(pdf.buffer);
    },
  );

  /** Constancia de impresión o descarga (reimpresión auditada). */
  app.post(
    '/api/v1/clinical/prescriptions/:id/printed',
    { preHandler: read },
    async (request, reply) => {
      const actor = actorFrom(request);
      const { id } = parseOrThrow(prescriptionParamsSchema, request.params);
      const result = await registerPrescriptionPrint(db, id, actor);
      publicarYa();
      return reply.status(200).send(result);
    },
  );

  /* ── Verificación pública ────────────────────────────────────────────────── */

  /**
   * Página pública `/verificar/<código>`: **sin sesión** (el gateway la deja pasar).
   * Confirma que el récipe es auténtico sin exponer datos clínicos (ADR 0015), y
   * responde `valid: false` —no 404— cuando el código no consta: quien escanea un
   * papel falso tiene que leer «este récipe no consta», no un error del servidor.
   */
  app.get('/api/v1/clinical/verify/:code', async (request, reply) => {
    const { code } = parseOrThrow(codeParamsSchema, request.params);
    const result = await verifyPrescription(db, code, CLINIC.name);
    return reply.status(200).send(result);
  });
};
