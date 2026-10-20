import {
  comparePeriodontalExamsQuerySchema,
  createPeriodontalExamSchema,
  finalizePeriodontalExamSchema,
  periodontalExamListQuerySchema,
  savePeriodontalExamSchema,
} from '@odontocrm/contracts';
import { parseOrThrow, requirePermission } from '@odontocrm/kernel';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { OdontogramServices } from '../services.js';
import {
  compareExams,
  createExam,
  discardDraft,
  finalizeExam,
  getExam,
  getLatestExam,
  listExams,
  registerPrint,
  saveExam,
} from '../odontogram/periodontogram-service.js';
import { actorFrom } from '../shared/context.js';

const patientParamsSchema = z.object({ patientId: z.uuid() });

/** Params de los exámenes: el paciente y el documento, los dos en la URL. */
const examParamsSchema = z.object({ patientId: z.uuid(), examId: z.uuid() });

/**
 * Periodontograma (v1.1).
 *
 * Cuelga del prefijo existente `/api/v1/odontogram` (el gateway reenvía sin
 * recortar), así que la v1 no se toca. Reutiliza los permisos del odontograma: leer
 * e **imprimir** exigen `odontogram:read` —la secretaría imprime— y escribir exige
 * `odontogram:write`. El snapshot del paciente solo se pide en `latest`, que es el
 * que alimenta el membrete de la vista de impresión.
 */
export const registerPeriodontogramRoutes = (
  app: FastifyInstance,
  services: OdontogramServices,
): void => {
  const { db, patientLookup, kickOutbox } = services;
  const read = requirePermission('odontogram:read');
  const write = requirePermission('odontogram:write');

  /** Avanza el publicador para que la auditoría aparezca al instante. */
  const publicarYa = (): void => kickOutbox?.();

  /**
   * Abre un examen en borrador. Nace del odontograma vigente, del examen anterior o
   * en blanco. 409 si el paciente ya tiene un borrador abierto (extensiones con
   * `existingExamId` para que la interfaz ofrezca cerrarlo o descartarlo).
   */
  app.post(
    '/api/v1/odontogram/patients/:patientId/periodontograms',
    { preHandler: write },
    async (request, reply) => {
      const actor = actorFrom(request);
      const { patientId } = parseOrThrow(patientParamsSchema, request.params);
      const input = parseOrThrow(createPeriodontalExamSchema, request.body ?? {});
      const result = await createExam(db, patientId, input, actor);
      publicarYa();
      return reply.status(201).send(result);
    },
  );

  /** Listado de exámenes del paciente, del más reciente al más antiguo. */
  app.get(
    '/api/v1/odontogram/patients/:patientId/periodontograms',
    { preHandler: read },
    async (request, reply) => {
      const { patientId } = parseOrThrow(patientParamsSchema, request.params);
      const query = parseOrThrow(periodontalExamListQuerySchema, request.query);
      const result = await listExams(db, patientId, query);
      return reply.status(200).send(result);
    },
  );

  /**
   * Último examen (o `exists: false`) con el snapshot del paciente y el último
   * finalizado anterior. Es la lectura que abre la pestaña y la que arma el membrete
   * de la impresión.
   */
  app.get(
    '/api/v1/odontogram/patients/:patientId/periodontograms/latest',
    { preHandler: read },
    async (request, reply) => {
      const { patientId } = parseOrThrow(patientParamsSchema, request.params);
      const patient = await patientLookup(patientId);
      const result = await getLatestExam(db, patientId, patient);
      return reply.status(200).send(result);
    },
  );

  /** Examen completo (boca, factores de riesgo y diagnóstico). */
  app.get(
    '/api/v1/odontogram/patients/:patientId/periodontograms/:examId',
    { preHandler: read },
    async (request, reply) => {
      const params = parseOrThrow(examParamsSchema, request.params);
      const result = await getExam(db, params.patientId, params.examId);
      return reply.status(200).send(result);
    },
  );

  /**
   * Guarda el borrador completo con **revisión optimista**: 409 (con `currentRevision`)
   * si otra pestaña guardó antes, y `unchanged: true` sin escribir ni auditar cuando
   * el documento es idéntico.
   */
  app.put(
    '/api/v1/odontogram/patients/:patientId/periodontograms/:examId',
    { preHandler: write },
    async (request, reply) => {
      const actor = actorFrom(request);
      const params = parseOrThrow(examParamsSchema, request.params);
      const input = parseOrThrow(savePeriodontalExamSchema, request.body ?? {});
      const result = await saveExam(db, params.patientId, params.examId, input, actor);
      if (!result.unchanged) publicarYa();
      return reply.status(200).send(result);
    },
  );

  /** Cierre inmutable. Idempotente: repetirlo devuelve `alreadyFinalized: true`. */
  app.post(
    '/api/v1/odontogram/patients/:patientId/periodontograms/:examId/finalize',
    { preHandler: write },
    async (request, reply) => {
      const actor = actorFrom(request);
      const params = parseOrThrow(examParamsSchema, request.params);
      const input = parseOrThrow(finalizePeriodontalExamSchema, request.body ?? {});
      const result = await finalizeExam(db, params.patientId, params.examId, input, actor);
      if (!result.alreadyFinalized) publicarYa();
      return reply.status(200).send(result);
    },
  );

  /**
   * Descarta un borrador. Es la única salida destructiva del ciclo de vida: un
   * examen finalizado no se borra (409) y el descarte queda auditado.
   */
  app.delete(
    '/api/v1/odontogram/patients/:patientId/periodontograms/:examId',
    { preHandler: write },
    async (request, reply) => {
      const actor = actorFrom(request);
      const params = parseOrThrow(examParamsSchema, request.params);
      const result = await discardDraft(db, params.patientId, params.examId, actor);
      publicarYa();
      return reply.status(200).send(result);
    },
  );

  /** Comparación longitudinal contra el examen indicado en `?with=`. */
  app.get(
    '/api/v1/odontogram/patients/:patientId/periodontograms/:examId/compare',
    { preHandler: read },
    async (request, reply) => {
      const params = parseOrThrow(examParamsSchema, request.params);
      const query = parseOrThrow(comparePeriodontalExamsQuerySchema, request.query);
      const result = await compareExams(db, params.patientId, params.examId, query.with);
      return reply.status(200).send(result);
    },
  );

  /**
   * Deja constancia de una impresión. Exige solo `odontogram:read` porque imprimir
   * es leer: la secretaría imprime el periodontograma sin poder editarlo y el hecho
   * queda en la auditoría con su actor.
   */
  app.post(
    '/api/v1/odontogram/patients/:patientId/periodontograms/:examId/printed',
    { preHandler: read },
    async (request, reply) => {
      const actor = actorFrom(request);
      const params = parseOrThrow(examParamsSchema, request.params);
      const result = await registerPrint(db, params.patientId, params.examId, actor);
      publicarYa();
      return reply.status(200).send(result);
    },
  );
};
