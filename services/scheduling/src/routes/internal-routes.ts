import { createRequestSchema } from '@odontocrm/contracts';
import { ForbiddenError, NotFoundError, parseOrThrow } from '@odontocrm/kernel';
import type { FastifyInstance } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

import { getAppointment } from '../appointments/appointment-service.js';
import { cancelRequest, createRequest, findRequestByTicket } from '../requests/request-service.js';
import type { SchedulingServices } from '../services.js';
import { systemActor } from '../shared/context.js';

const internalRequestSchema = createRequestSchema.extend({
  /** Quién lo pide cuando no hay usuario: el bot de Telegram o un canal externo. */
  source: z.string().trim().max(60).optional(),
});

const idParamsSchema = z.object({ id: z.uuid() });
const ticketParamsSchema = z.object({ ticket: z.string().trim().min(1).max(20) });
const reasonSchema = z.object({ reason: z.string().trim().max(300).optional() });

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

  /**
   * Consulta por ticket para el bot (`/estado`, `/cancelar`). Responde 404 si no
   * existe: el asistente lo traduce a «no encuentro tu solicitud».
   */
  app.get('/internal/v1/requests/by-ticket/:ticket', async (request, reply) => {
    const { ticket } = parseOrThrow(ticketParamsSchema, request.params);
    const request_ = await findRequestByTicket(db, ticket);
    if (request_ === null) throw new NotFoundError('No hay ninguna solicitud con ese ticket');
    return reply.status(200).send(request_);
  });

  /** El bot anula la solicitud del paciente cuando él mismo lo pide. */
  app.post('/internal/v1/requests/:id/cancel', async (request, reply) => {
    const { id } = parseOrThrow(idParamsSchema, request.params);
    const input = parseOrThrow(reasonSchema, request.body ?? {});
    const summary = await cancelRequest(
      db,
      id,
      input.reason ?? 'anulada por el paciente por Telegram',
      systemActor('servicio:telegram'),
    );
    return reply.status(200).send(summary);
  });

  /** Datos de la cita para armar el `.ics` y los mensajes de aviso. */
  app.get('/internal/v1/appointments/:id', async (request, reply) => {
    const { id } = parseOrThrow(idParamsSchema, request.params);
    return reply.status(200).send(await getAppointment(db, id));
  });
};
