import { upsertPatientSchema } from '@odontocrm/contracts';
import { ForbiddenError, NotFoundError, parseOrThrow } from '@odontocrm/kernel';
import type { FastifyInstance } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

import {
  getPatientDetail,
  listPatientSummaries,
  lookupByDocumentText,
  upsertPatientByDocument,
} from '../patients/patient-service.js';
import type { PatientsServices } from '../services.js';

const channelSchema = z.object({
  channel: z.enum(['telegram', 'registro', 'telefono', 'presencial']).default('registro'),
  reason: z.string().trim().max(200).optional(),
});

const documentParamsSchema = z.object({
  docType: z.enum(['V', 'E', 'P', 'SC']),
  docNumber: z.string().trim().min(1).max(20),
});

const idParamsSchema = z.object({ id: z.uuid() });

/**
 * Identificadores para el resumen en lote. Se corta en 100 para que la consulta no
 * crezca sin límite: la bandeja de canales pide como mucho eso de una vez.
 */
const summariesQuerySchema = z.object({
  ids: z
    .string()
    .trim()
    .min(1)
    .transform((value) => value.split(',').map((id) => id.trim()))
    .pipe(z.array(z.uuid()).min(1).max(100)),
});

const safeEquals = (left: string, right: string): boolean => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

/**
 * Rutas internas: solo para otros servicios del sistema (el bot de Telegram, el
 * registro o la agenda). No pasan por el gateway, escuchan en 127.0.0.1 y exigen
 * el secreto compartido; en la Fase 4 se sustituye por el JWT de servicio.
 */
export const registerInternalRoutes = (app: FastifyInstance, services: PatientsServices): void => {
  const { db, config } = services;

  app.addHook('onRequest', async (request) => {
    if (!request.url.startsWith('/internal/')) return;

    const expected = config.INTERNAL_SERVICE_SECRET;
    if (expected === undefined) {
      throw new ForbiddenError('Las rutas internas están deshabilitadas en este entorno');
    }
    const provided = request.headers['x-internal-token'];
    if (typeof provided !== 'string' || !safeEquals(provided, expected)) {
      throw new ForbiddenError('Token interno inválido');
    }
  });

  /**
   * Búsqueda por documento para otros servicios (el bot confirma los datos antes
   * de dar de alta). Responde 404 cuando no existe, que es información útil: el
   * asistente sabe así que tiene que pedir los datos completos.
   */
  app.get('/internal/v1/patients/by-document/:docType/:docNumber', async (request, reply) => {
    const params = parseOrThrow(documentParamsSchema, request.params);
    const patient = await lookupByDocumentText(db, `${params.docType}-${params.docNumber}`);
    if (patient === null) {
      throw new NotFoundError('No hay ningún paciente con ese documento');
    }
    return reply.status(200).send(patient);
  });

  /**
   * Resúmenes de varios pacientes por id (para la tabla de canales de la bandeja de
   * notificaciones). Va **antes** de `/:id` por claridad, aunque Fastify prioriza las
   * rutas estáticas; los identificadores que no existen simplemente no vuelven.
   */
  app.get('/internal/v1/patients/summaries', async (request, reply) => {
    const { ids } = parseOrThrow(summariesQuerySchema, request.query);
    const items = await listPatientSummaries(db, ids);
    return reply.status(200).send({ items, total: items.length });
  });

  /**
   * Ficha del paciente por id, para los servicios que solo tienen el
   * identificador (la pantalla del consultorio necesita la fecha de nacimiento
   * para calcular la edad). Responde 404 si no existe.
   */
  app.get('/internal/v1/patients/:id', async (request, reply) => {
    const { id } = parseOrThrow(idParamsSchema, request.params);
    return reply.status(200).send(await getPatientDetail(db, id));
  });

  /**
   * Alta o actualización por documento. Es idempotente y responde si el paciente
   * se creó o se actualizó, con los campos que cambiaron.
   */
  app.post('/internal/v1/patients/upsert-by-cedula', async (request, reply) => {
    const input = parseOrThrow(upsertPatientSchema, request.body);
    const extra = parseOrThrow(channelSchema, (request.body as Record<string, unknown>) ?? {});
    const userAgent = request.headers['user-agent'];

    const result = await upsertPatientByDocument(db, input, {
      actorId: null,
      actorUsername: `servicio:${extra.channel}`,
      ip: request.ip ?? null,
      userAgent: typeof userAgent === 'string' ? userAgent : null,
      requestId: request.id,
      reason: extra.reason ?? `alta o actualización desde ${extra.channel}`,
    });

    return reply.status(200).send({
      created: result.created,
      patient: result.detail,
      changedFields: result.diff?.changedFields ?? [],
    });
  });
};
