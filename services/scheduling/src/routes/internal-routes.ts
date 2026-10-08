import {
  appointmentFiltersSchema,
  cancelAppointmentBotSchema,
  confirmAppointmentSchema,
  createRequestSchema,
} from '@odontocrm/contracts';
import { ForbiddenError, NotFoundError, parseOrThrow, parseQuery } from '@odontocrm/kernel';
import type { FastifyInstance } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

import {
  cancelAppointment,
  confirmAppointment,
  getAppointment,
  listAppointments,
} from '../appointments/appointment-service.js';
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

  /**
   * Citas para el bot y para la sección de la bandeja (ADR 0052). Se reutilizan los
   * filtros públicos —fecha, estado, `confirmed`, paciente, búsqueda y página— porque
   * son los mismos que necesita la interfaz; el servicio de notificaciones los pasa
   * tal cual y después cruza el canal vinculado y el último aviso de cada cita.
   */
  app.get('/internal/v1/appointments', async (request, reply) => {
    const filters = parseQuery(appointmentFiltersSchema, request.query);
    return reply.status(200).send(await listAppointments(db, filters));
  });

  /**
   * El **paciente confirma** su cita desde el bot (ADR 0052).
   *
   * Es la única escritura de la agenda que no pide un usuario: la hace el propio
   * paciente por Telegram o WhatsApp, así que el actor es de sistema y va **sin
   * roles**. `confirmAppointment` sabe tratarlo —comprueba el estado pero no la
   * máquina de estados por rol— y es idempotente, que es lo que hace segura la
   * pulsación repetida del botón.
   */
  app.post('/internal/v1/appointments/:id/confirm', async (request, reply) => {
    const { id } = parseOrThrow(idParamsSchema, request.params);
    const input = parseOrThrow(confirmAppointmentSchema, request.body ?? {});
    const summary = await confirmAppointment(
      db,
      id,
      input,
      systemActor(`servicio:${input.channel}`),
    );
    return reply.status(200).send(summary);
  });

  /**
   * El **paciente cancela** su cita desde el bot (ADR 0053). Igual que la
   * confirmación: el actor es de sistema y va **sin roles**, así que
   * `cancelAppointment` salta la máquina de estados por rol y aplica su propia guardia
   * de estado. El **canal** viaja en el cuerpo y se guarda: es lo que distingue una
   * cancelación del paciente de una de la secretaría.
   */
  app.post('/internal/v1/appointments/:id/cancel', async (request, reply) => {
    const { id } = parseOrThrow(idParamsSchema, request.params);
    const input = parseOrThrow(cancelAppointmentBotSchema, request.body ?? {});
    const summary = await cancelAppointment(
      db,
      id,
      { channel: input.channel, reason: input.reason ?? null, config: services.config },
      systemActor(`servicio:${input.channel}`),
    );
    return reply.status(200).send(summary);
  });
};
