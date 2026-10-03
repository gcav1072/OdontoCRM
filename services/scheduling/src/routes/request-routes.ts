import {
  createRequestSchema,
  cancelRequestSchema,
  requestFiltersSchema,
} from '@odontocrm/contracts';
import { parseOrThrow, parseQuery, requirePermission } from '@odontocrm/kernel';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import {
  cancelRequest,
  createRequest,
  getRequest,
  listRequests,
} from '../requests/request-service.js';
import type { SchedulingServices } from '../services.js';
import { actorFrom } from '../shared/context.js';

const idParamsSchema = z.object({ id: z.uuid() });

export const registerRequestRoutes = (app: FastifyInstance, services: SchedulingServices): void => {
  const { db } = services;
  const read = requirePermission('scheduling:read');
  const write = requirePermission('scheduling:write');

  /** Cola de solicitudes: por defecto ordenada por ticket (y prioridad). */
  app.get('/api/v1/requests', { preHandler: read }, async (request, reply) => {
    const filters = parseQuery(requestFiltersSchema, request.query);
    return reply.status(200).send(await listRequests(db, filters));
  });

  app.post('/api/v1/requests', { preHandler: write }, async (request, reply) => {
    const actor = actorFrom(request);
    const input = parseOrThrow(createRequestSchema, request.body);
    return reply.status(201).send(await createRequest(db, input, actor));
  });

  app.get('/api/v1/requests/:id', { preHandler: read }, async (request, reply) => {
    const { id } = parseOrThrow(idParamsSchema, request.params);
    return reply.status(200).send(await getRequest(db, id));
  });

  app.post('/api/v1/requests/:id/cancel', { preHandler: write }, async (request, reply) => {
    const actor = actorFrom(request);
    const { id } = parseOrThrow(idParamsSchema, request.params);
    const input = parseOrThrow(cancelRequestSchema, request.body ?? {});
    return reply.status(200).send(await cancelRequest(db, id, input.reason, actor));
  });
};
