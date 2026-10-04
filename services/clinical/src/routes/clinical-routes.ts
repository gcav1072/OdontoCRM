import {
  acceptConsentSchema,
  amendClinicalSessionSchema,
  clinicalSectionKeySchema,
  closeClinicalSessionSchema,
  createAmendmentSchema,
  createClinicalSessionSchema,
  saveClinicalSectionSchema,
  saveClinicalSessionSchema,
  signMedicalRecordSchema,
  type ClinicalRecordLookup,
} from '@odontocrm/contracts';
import { parseOrThrow, requirePermission } from '@odontocrm/kernel';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import {
  acceptConsent,
  createAmendment,
  getRecordDetail,
  getRecordDetailByPatient,
  openRecord,
  registerPrint,
  saveSection,
  signRecord,
} from '../clinical/record-service.js';
import {
  amendSession,
  closeSession,
  getSessionDetail,
  listSessionsByAppointment,
  listSessionsByPatient,
  openSession,
  saveSession,
} from '../clinical/session-service.js';
import type { ClinicalServices } from '../services.js';
import { actorFrom } from '../shared/context.js';

const patientParamsSchema = z.object({ patientId: z.uuid() });
const recordParamsSchema = z.object({ id: z.uuid() });
const sessionParamsSchema = z.object({ id: z.uuid() });
const appointmentParamsSchema = z.object({ appointmentId: z.uuid() });
const sectionParamsSchema = z
  .object({ id: z.uuid(), sectionKey: clinicalSectionKeySchema })
  .strict();

/**
 * Historia clínica (Fase 6, sesión A).
 *
 * Rutas públicas bajo `/api/v1/clinical` (el gateway reenvía sin recortar) y
 * protegidas por RBAC: leer exige `clinical:read` (la secretaría imprime) y
 * escribir exige `clinical:write` (odontólogo y admin).
 */
export const registerClinicalRoutes = (app: FastifyInstance, services: ClinicalServices): void => {
  const { db, patientLookup, kickOutbox } = services;
  const read = requirePermission('clinical:read');
  const write = requirePermission('clinical:write');

  /** Avanza el publicador para que la auditoría aparezca al instante. */
  const publicarYa = (): void => kickOutbox?.();

  /**
   * Historia del paciente. Responde `exists: false` (200, no 404) cuando es la
   * primera visita: la interfaz distingue «no tiene historia» de «no pude
   * preguntar» y muestra el aviso obligatorio.
   */
  app.get(
    '/api/v1/clinical/patients/:patientId/record',
    { preHandler: read },
    async (request, reply) => {
      const { patientId } = parseOrThrow(patientParamsSchema, request.params);
      const patient = await patientLookup(patientId);
      const record = await getRecordDetailByPatient(db, patientId, patient);
      const result: ClinicalRecordLookup =
        record === null ? { exists: false, patientId, patient } : { exists: true, record };
      return reply.status(200).send(result);
    },
  );

  /** Abre la historia (idempotente). Solo el odontólogo o el admin. */
  app.post(
    '/api/v1/clinical/patients/:patientId/record',
    { preHandler: write },
    async (request, reply) => {
      const actor = actorFrom(request);
      const { patientId } = parseOrThrow(patientParamsSchema, request.params);
      const patient = await patientLookup(patientId);
      const result = await openRecord(db, patientId, actor, patient);
      if (result.created) publicarYa();
      return reply.status(result.created ? 201 : 200).send(result.detail);
    },
  );

  app.get('/api/v1/clinical/records/:id', { preHandler: read }, async (request, reply) => {
    const { id } = parseOrThrow(recordParamsSchema, request.params);
    const record = await getRecordDetail(db, id);
    const patient = await patientLookup(record.patientId);
    return reply.status(200).send({ ...record, patient });
  });

  /** Guarda una sección como borrador. */
  app.put(
    '/api/v1/clinical/records/:id/sections/:sectionKey',
    { preHandler: write },
    async (request, reply) => {
      const actor = actorFrom(request);
      const { id, sectionKey } = parseOrThrow(sectionParamsSchema, request.params);
      const { content } = parseOrThrow(saveClinicalSectionSchema, request.body ?? {});
      const record = await saveSection(db, id, sectionKey, content, actor);
      publicarYa();
      return reply.status(200).send(record);
    },
  );

  /** Registra la aceptación del consentimiento informado. */
  app.put('/api/v1/clinical/records/:id/consent', { preHandler: write }, async (request, reply) => {
    const actor = actorFrom(request);
    const { id } = parseOrThrow(recordParamsSchema, request.params);
    const input = parseOrThrow(acceptConsentSchema, request.body ?? {});
    const record = await acceptConsent(db, id, input, actor);
    publicarYa();
    return reply.status(200).send(record);
  });

  /** Firma: bloquea la edición y deja la historia inmutable. */
  app.post('/api/v1/clinical/records/:id/sign', { preHandler: write }, async (request, reply) => {
    const actor = actorFrom(request);
    const { id } = parseOrThrow(recordParamsSchema, request.params);
    parseOrThrow(signMedicalRecordSchema, request.body ?? {});
    const record = await signRecord(db, id, actor);
    publicarYa();
    return reply.status(200).send(record);
  });

  /** Adenda: la única forma de corregir una historia firmada. */
  app.post(
    '/api/v1/clinical/records/:id/amendments',
    { preHandler: write },
    async (request, reply) => {
      const actor = actorFrom(request);
      const { id } = parseOrThrow(recordParamsSchema, request.params);
      const input = parseOrThrow(createAmendmentSchema, request.body ?? {});
      const record = await createAmendment(db, id, input, actor);
      publicarYa();
      return reply.status(201).send(record);
    },
  );

  /**
   * Deja constancia de una impresión. Exige solo `clinical:read` porque imprimir
   * es leer: la secretaría imprime la historia sin poder escribirla, y el hecho
   * queda igualmente en la auditoría con su actor.
   */
  app.post('/api/v1/clinical/records/:id/printed', { preHandler: read }, async (request, reply) => {
    const actor = actorFrom(request);
    const { id } = parseOrThrow(recordParamsSchema, request.params);
    const result = await registerPrint(db, id, actor);
    publicarYa();
    return reply.status(200).send(result);
  });

  /* ── Sesiones clínicas (Fase 7, sesión A) ────────────────────────────────── */

  /** Evolución del paciente, de la última sesión a la primera. */
  app.get(
    '/api/v1/clinical/patients/:patientId/sessions',
    { preHandler: read },
    async (request, reply) => {
      const { patientId } = parseOrThrow(patientParamsSchema, request.params);
      return reply.status(200).send(await listSessionsByPatient(db, patientId));
    },
  );

  /**
   * Abre la sesión del día (idempotente): si ya hay un borrador, devuelve ese.
   * Abre también la historia clínica si el paciente todavía no la tenía.
   */
  app.post(
    '/api/v1/clinical/patients/:patientId/sessions',
    { preHandler: write },
    async (request, reply) => {
      const actor = actorFrom(request);
      const { patientId } = parseOrThrow(patientParamsSchema, request.params);
      const input = parseOrThrow(createClinicalSessionSchema, request.body ?? {});
      const patient = await patientLookup(patientId);
      const result = await openSession(db, patientId, input, actor, patient);
      if (result.created) publicarYa();
      return reply.status(result.created ? 201 : 200).send(result.detail);
    },
  );

  /**
   * Sesiones de una cita. La usa la secretaría —que tiene `clinical:read`— para
   * saber si el doctor ya cerró la sesión antes de marcar «atendido».
   */
  app.get(
    '/api/v1/clinical/appointments/:appointmentId/sessions',
    { preHandler: read },
    async (request, reply) => {
      const { appointmentId } = parseOrThrow(appointmentParamsSchema, request.params);
      return reply.status(200).send(await listSessionsByAppointment(db, appointmentId));
    },
  );

  app.get('/api/v1/clinical/sessions/:id', { preHandler: read }, async (request, reply) => {
    const { id } = parseOrThrow(sessionParamsSchema, request.params);
    return reply.status(200).send(await getSessionDetail(db, id));
  });

  /** Autoguardado del borrador: llega el documento completo de la sesión. */
  app.put('/api/v1/clinical/sessions/:id', { preHandler: write }, async (request, reply) => {
    const { id } = parseOrThrow(sessionParamsSchema, request.params);
    const input = parseOrThrow(saveClinicalSessionSchema, request.body ?? {});
    const result = await saveSession(db, id, input);
    return reply.status(200).send(result.detail);
  });

  /** Cierre: la sesión queda inmutable y el acto clínico en la auditoría. */
  app.post('/api/v1/clinical/sessions/:id/close', { preHandler: write }, async (request, reply) => {
    const actor = actorFrom(request);
    const { id } = parseOrThrow(sessionParamsSchema, request.params);
    const input = parseOrThrow(closeClinicalSessionSchema, request.body ?? {});
    const session = await closeSession(db, id, input, actor);
    publicarYa();
    return reply.status(200).send(session);
  });

  /**
   * Enmienda de una sesión cerrada: abre una nueva en borrador con su contenido
   * copiado y el motivo dicho. Lo cerrado no se reescribe.
   */
  app.post('/api/v1/clinical/sessions/:id/amend', { preHandler: write }, async (request, reply) => {
    const actor = actorFrom(request);
    const { id } = parseOrThrow(sessionParamsSchema, request.params);
    const input = parseOrThrow(amendClinicalSessionSchema, request.body ?? {});
    const session = await amendSession(db, id, input, actor);
    publicarYa();
    return reply.status(201).send(session);
  });
};
