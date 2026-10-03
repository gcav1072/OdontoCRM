import {
  changePatientStatusSchema,
  createPatientSchema,
  patientFiltersSchema,
  parseDocumentText,
  updatePatientSchema,
  validateDocument,
  type PatientLookupResult,
} from '@odontocrm/contracts';
import { parseOrThrow, parseQuery, requireIdentity, requirePermission } from '@odontocrm/kernel';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import {
  changePatientStatus,
  createPatient,
  getPatientDetail,
  listPatients,
  lookupByDocumentText,
  updatePatient,
  type ActorContext,
} from '../patients/patient-service.js';
import type { PatientsServices } from '../services.js';

const idParamsSchema = z.object({ id: z.uuid() });
const lookupQuerySchema = z.object({ document: z.string().trim().min(1, 'Escribe el documento') });

/** Contexto de quién hace el cambio: viaja a la auditoría. */
export const actorFrom = (request: FastifyRequest): ActorContext & { reason?: string } => {
  const identity = requireIdentity(request);
  const userAgent = request.headers['user-agent'];
  return {
    actorId: identity.userId,
    actorUsername: identity.username,
    ip: request.ip ?? null,
    userAgent: typeof userAgent === 'string' ? userAgent : null,
    requestId: request.id,
  };
};

export const registerPatientRoutes = (app: FastifyInstance, services: PatientsServices): void => {
  const { db } = services;
  const read = requirePermission('patients:read');
  const write = requirePermission('patients:write');
  const editSensitive = requirePermission('patients:edit_sensitive');

  app.get('/api/v1/patients', { preHandler: read }, async (request, reply) => {
    const filters = parseQuery(patientFiltersSchema, request.query);
    return reply.status(200).send(await listPatients(db, filters));
  });

  /**
   * Búsqueda por documento escrito de cualquier forma (`V-12345678`,
   * `v 12.345.678`, `12345678`). Devuelve `found: false` en vez de 404 para que
   * la interfaz distinga «no está registrado» de «no pude preguntar».
   */
  app.get('/api/v1/patients/lookup', { preHandler: read }, async (request, reply) => {
    const { document } = parseQuery(lookupQuerySchema, request.query);
    const parsed = parseDocumentText(document);
    const validation = validateDocument(parsed.type, parsed.number);
    const formatted = validation.formatted;

    const patient = await lookupByDocumentText(db, document);
    const result: PatientLookupResult =
      patient === null ? { found: false, document: formatted } : { found: true, patient };

    return reply.status(200).send(result);
  });

  app.post('/api/v1/patients', { preHandler: write }, async (request, reply) => {
    const actor = actorFrom(request);
    const input = parseOrThrow(createPatientSchema, request.body);
    const patient = await createPatient(db, input, { ...actor, reason: 'alta desde registro' });
    return reply.status(201).send(patient);
  });

  app.get('/api/v1/patients/:id', { preHandler: read }, async (request, reply) => {
    const { id } = parseOrThrow(idParamsSchema, request.params);
    return reply.status(200).send(await getPatientDetail(db, id));
  });

  /** Editar datos sensibles exige el permiso específico y un motivo. */
  app.patch('/api/v1/patients/:id', { preHandler: editSensitive }, async (request, reply) => {
    const actor = actorFrom(request);
    const { id } = parseOrThrow(idParamsSchema, request.params);
    const input = parseOrThrow(updatePatientSchema, request.body);
    const result = await updatePatient(db, id, input, actor);
    return reply.status(200).send(result.detail);
  });

  app.post('/api/v1/patients/:id/status', { preHandler: editSensitive }, async (request, reply) => {
    const actor = actorFrom(request);
    const { id } = parseOrThrow(idParamsSchema, request.params);
    const input = parseOrThrow(changePatientStatusSchema, request.body);
    const result = await changePatientStatus(db, id, input.status, input.reason, actor);
    return reply.status(200).send(result.detail);
  });
};
