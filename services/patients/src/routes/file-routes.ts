import { ALLOWED_FILE_MIME_TYPES, PATIENT_FILE_KINDS } from '@odontocrm/contracts';
import { AppError, multipartFieldValue, parseOrThrow, requirePermission } from '@odontocrm/kernel';
import type { MultipartFile } from '@fastify/multipart';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import {
  deletePatientFile,
  getPatientFile,
  listPatientFiles,
  savePatientFile,
} from '../files/file-service.js';
import type { PatientsServices } from '../services.js';
import { actorFrom } from './patient-routes.js';

const paramsSchema = z.object({ id: z.uuid() });
const fileParamsSchema = z.object({ id: z.uuid(), fileId: z.uuid() });

const uploadFieldsSchema = z.object({
  kind: z.enum(PATIENT_FILE_KINDS),
  caption: z.string().trim().max(240).optional(),
});

export const registerFileRoutes = (app: FastifyInstance, services: PatientsServices): void => {
  const { db, blobStore, config } = services;
  const read = requirePermission('patients:read');
  const write = requirePermission('patients:write');

  app.get('/api/v1/patients/:id/files', { preHandler: read }, async (request, reply) => {
    const { id } = parseOrThrow(paramsSchema, request.params);
    const items = await listPatientFiles(db, id);
    return reply.status(200).send({ items, total: items.length });
  });

  /**
   * Subida de una radiografía, foto o PDF. `attachFieldsToBody` deja los campos de
   * texto como objetos `{ value }` y el archivo como `MultipartFile`: los campos se
   * sacan con `multipartFieldValue` antes de validarlos (mandarlos tal cual fue el
   * fallo que tuvo esta ruta sin que ninguna prueba lo viera).
   */
  app.post('/api/v1/patients/:id/files', { preHandler: write }, async (request, reply) => {
    const actor = actorFrom(request);
    const { id } = parseOrThrow(paramsSchema, request.params);

    const body = request.body as
      { file?: MultipartFile; kind?: unknown; caption?: unknown } | undefined;

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
    });

    const data = await file.toBuffer();
    const saved = await savePatientFile(
      db,
      blobStore,
      {
        patientId: id,
        kind: fields.kind,
        originalName: file.filename ?? 'archivo',
        mime: file.mimetype,
        data,
        caption: fields.caption,
        uploadedBy: actor.actorId,
      },
      config.MAX_FILE_BYTES,
    );

    return reply.status(201).send(saved);
  });

  /** Descarga del archivo: el servicio comprueba que pertenece a ese paciente. */
  app.get('/api/v1/patients/:id/files/:fileId', { preHandler: read }, async (request, reply) => {
    const { id, fileId } = parseOrThrow(fileParamsSchema, request.params);
    const { file, content } = await getPatientFile(db, blobStore, id, fileId);

    if (!(ALLOWED_FILE_MIME_TYPES as readonly string[]).includes(file.mime)) {
      throw new AppError({
        status: 415,
        code: 'unsupported_media_type',
        message: 'El tipo de archivo no se puede servir',
      });
    }

    return reply
      .status(200)
      .header('content-type', file.mime)
      .header('content-disposition', `inline; filename="${encodeURIComponent(file.originalName)}"`)
      .send(content);
  });

  app.delete(
    '/api/v1/patients/:id/files/:fileId',
    { preHandler: write },
    async (request, reply) => {
      const { id, fileId } = parseOrThrow(fileParamsSchema, request.params);
      await deletePatientFile(db, blobStore, id, fileId);
      return reply.status(204).send();
    },
  );
};
