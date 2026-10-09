import {
  clearSurfaceSchema,
  completeProcedureSchema,
  deleteFindingSchema,
  recordFindingSchema,
  recordFindingsBatchSchema,
  toothConditionSchema,
  toothSurfaceSchema,
} from '@odontocrm/contracts';
import { parseOrThrow, requirePermission } from '@odontocrm/kernel';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import {
  DEFAULT_HISTORY_LIMIT,
  MAX_HISTORY_LIMIT,
  clearSurface,
  completeProcedure,
  deleteFinding,
  getHistory,
  getOdontogramByPatient,
  recordFinding,
  recordFindingsBatch,
  registerPrint,
} from '../odontogram/chart-service.js';
import type { OdontogramServices } from '../services.js';
import { actorFrom } from '../shared/context.js';

const patientParamsSchema = z.object({ patientId: z.uuid() });

/** Query del borrado por clave natural: en la URL todo llega como texto. */
const deleteFindingQuerySchema = z
  .object({
    toothNumber: z.coerce.number().int(),
    surface: toothSurfaceSchema.optional(),
    condition: toothConditionSchema,
  })
  .strict();

/** Params de «dejar la cara sana»: incluye el paciente y convierten a número. */
const clearSurfaceParamsSchema = z
  .object({
    patientId: z.uuid(),
    toothNumber: z.coerce.number().int(),
    surface: toothSurfaceSchema,
  })
  .strict();

const historyQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(MAX_HISTORY_LIMIT).default(DEFAULT_HISTORY_LIMIT),
  })
  .strict();

/**
 * Odontograma (Fase 6, sesión B).
 *
 * Rutas públicas bajo `/api/v1/odontogram` (el gateway reenvía sin recortar) y
 * protegidas por RBAC: leer e **imprimir** exigen `odontogram:read` —la
 * secretaría imprime el odontograma— y escribir exige `odontogram:write`
 * (odontólogo y admin).
 */
export const registerOdontogramRoutes = (
  app: FastifyInstance,
  services: OdontogramServices,
): void => {
  const { db, patientLookup, kickOutbox } = services;
  const read = requirePermission('odontogram:read');
  const write = requirePermission('odontogram:write');

  /** Avanza el publicador para que la auditoría aparezca al instante. */
  const publicarYa = (): void => kickOutbox?.();

  /**
   * Odontograma del paciente. Responde `exists: false` (200, no 404) cuando
   * todavía no tiene ninguno: la boca sin hallazgos **es** una boca sana, no un
   * recurso que falte.
   */
  app.get(
    '/api/v1/odontogram/patients/:patientId',
    { preHandler: read },
    async (request, reply) => {
      const { patientId } = parseOrThrow(patientParamsSchema, request.params);
      const patient = await patientLookup(patientId);
      const result = await getOdontogramByPatient(db, patientId, patient);
      return reply.status(200).send(result);
    },
  );

  /** Registra o corrige un hallazgo. Crea el odontograma si es el primero. */
  app.put(
    '/api/v1/odontogram/patients/:patientId/findings',
    { preHandler: write },
    async (request, reply) => {
      const actor = actorFrom(request);
      const { patientId } = parseOrThrow(patientParamsSchema, request.params);
      const input = parseOrThrow(recordFindingSchema, request.body ?? {});
      const result = await recordFinding(db, patientId, input, actor);
      if (!result.unchanged) publicarYa();
      return reply.status(200).send(result);
    },
  );

  /**
   * Carga rápida: varios hallazgos en una sola transacción (o todos o ninguno).
   * Un lote que traiga la misma pieza con cara y pieza completa se rechaza con
   * 409 antes de tocar la base.
   */
  app.post(
    '/api/v1/odontogram/patients/:patientId/findings/batch',
    { preHandler: write },
    async (request, reply) => {
      const actor = actorFrom(request);
      const { patientId } = parseOrThrow(patientParamsSchema, request.params);
      const input = parseOrThrow(recordFindingsBatchSchema, request.body ?? {});
      const result = await recordFindingsBatch(db, patientId, input, actor);
      if (!result.unchanged) publicarYa();
      return reply.status(200).send(result);
    },
  );

  /**
   * Cumple un **procedimiento** del plan (spec anexo ADR 0032 §5): extracción
   * realizada, caries obturada o corona sobre implante. El servicio resuelve el
   * origen e inserta el destino en una sola transacción, así que el estado imposible
   * «extracción completada + implante» no puede quedar a medias.
   */
  app.post(
    '/api/v1/odontogram/patients/:patientId/procedures',
    { preHandler: write },
    async (request, reply) => {
      const actor = actorFrom(request);
      const { patientId } = parseOrThrow(patientParamsSchema, request.params);
      const input = parseOrThrow(completeProcedureSchema, request.body ?? {});
      const result = await completeProcedure(db, patientId, input, actor);
      if (!result.unchanged) publicarYa();
      return reply.status(200).send(result);
    },
  );

  /** Borra la clave natural: la pieza vuelve a estar sana (ausencia de fila). */
  app.delete(
    '/api/v1/odontogram/patients/:patientId/findings',
    { preHandler: write },
    async (request, reply) => {
      const actor = actorFrom(request);
      const { patientId } = parseOrThrow(patientParamsSchema, request.params);
      const query = parseOrThrow(deleteFindingQuerySchema, request.query);
      const input = parseOrThrow(deleteFindingSchema, {
        toothNumber: query.toothNumber,
        surface: query.surface ?? null,
        condition: query.condition,
      });
      const result = await deleteFinding(db, patientId, input, actor);
      if (!result.unchanged) publicarYa();
      return reply.status(200).send(result);
    },
  );

  /** Deja la cara sana: limpia **todas** sus condiciones vigentes. */
  app.delete(
    '/api/v1/odontogram/patients/:patientId/surfaces/:toothNumber/:surface',
    { preHandler: write },
    async (request, reply) => {
      const actor = actorFrom(request);
      const params = parseOrThrow(clearSurfaceParamsSchema, request.params);
      const input = parseOrThrow(clearSurfaceSchema, {
        toothNumber: params.toothNumber,
        surface: params.surface,
      });
      const result = await clearSurface(db, params.patientId, input, actor);
      if (!result.unchanged) publicarYa();
      return reply.status(200).send(result);
    },
  );

  /** Histórico append-only de cambios, para la vista de evolución. */
  app.get(
    '/api/v1/odontogram/patients/:patientId/history',
    { preHandler: read },
    async (request, reply) => {
      const { patientId } = parseOrThrow(patientParamsSchema, request.params);
      const { limit } = parseOrThrow(historyQuerySchema, request.query);
      const result = await getHistory(db, patientId, limit);
      return reply.status(200).send(result);
    },
  );

  /**
   * Deja constancia de una impresión. Exige solo `odontogram:read` porque
   * imprimir es leer: la secretaría imprime el odontograma sin poder escribir
   * hallazgos, y el hecho queda igualmente en la auditoría con su actor.
   */
  app.post(
    '/api/v1/odontogram/patients/:patientId/printed',
    { preHandler: read },
    async (request, reply) => {
      const actor = actorFrom(request);
      const { patientId } = parseOrThrow(patientParamsSchema, request.params);
      const result = await registerPrint(db, patientId, actor);
      publicarYa();
      return reply.status(200).send(result);
    },
  );
};
