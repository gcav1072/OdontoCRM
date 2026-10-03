import { createRequestSchema } from '@odontocrm/contracts';
import { ForbiddenError, parseOrThrow } from '@odontocrm/kernel';
import type { FastifyInstance } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

import { createRequest } from '../requests/request-service.js';
import type { SchedulingServices } from '../services.js';
import { systemActor } from '../shared/context.js';

const internalRequestSchema = createRequestSchema.extend({
  /** Quién lo pide cuando no hay usuario: el bot de Telegram o un canal externo. */
  source: z.string().trim().max(60).optional(),
});

const safeEquals = (left: string, right: string): boolean => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

/**
 * Rutas internas: solo para otros servicios (el bot de Telegram en la Fase 4). No
 * pasan por el gateway, escuchan en 127.0.0.1 y exigen el secreto compartido; en la
 * Fase 4 se sustituyen por el JWT de servicio.
 */
export const registerInternalRoutes = (
  app: FastifyInstance,
  services: SchedulingServices,
): void => {
  const { db } = services;

  app.addHook('onRequest', async (request) => {
    if (!request.url.startsWith('/internal/')) return;

    const expected = services.config.INTERNAL_SERVICE_SECRET;
    if (expected === undefined) {
      throw new ForbiddenError('Las rutas internas están deshabilitadas en este entorno');
    }
    const provided = request.headers['x-internal-token'];
    if (typeof provided !== 'string' || !safeEquals(provided, expected)) {
      throw new ForbiddenError('Token interno inválido');
    }
  });

  /** Alta de solicitud desde el bot (o desde otro servicio), con su ticket. */
  app.post('/internal/v1/requests', async (request, reply) => {
    const input = parseOrThrow(internalRequestSchema, request.body);
    const summary = await createRequest(
      db,
      input,
      systemActor(`servicio:${input.source ?? 'interno'}`),
    );
    return reply.status(201).send(summary);
  });
};
