import {
  appointmentFiltersSchema,
  assignAppointmentSchema,
  attendAppointmentSchema,
  cancelAppointmentSchema,
  noShowAppointmentSchema,
  rescheduleAppointmentSchema,
} from '@odontocrm/contracts';
import { parseOrThrow, parseQuery, requirePermission } from '@odontocrm/kernel';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import {
  assignAppointment,
  getAppointment,
  getHistory,
  listAppointments,
  rescheduleAppointment,
  transitionAppointment,
} from '../appointments/appointment-service.js';
import type { SchedulingServices } from '../services.js';
import { actorFrom } from '../shared/context.js';

const idParamsSchema = z.object({ id: z.uuid() });

/**
 * Ciclo de vida de la cita. Cada acción valida la máquina de estados del contrato:
 * si la transición no es válida para el rol, responde 409 con los estados a los que
 * sí se puede ir desde el estado actual.
 */
export const registerAppointmentRoutes = (
  app: FastifyInstance,
  services: SchedulingServices,
): void => {
  const { db, config } = services;
  const read = requirePermission('scheduling:read');
  const write = requirePermission('scheduling:write');

  app.get('/api/v1/appointments', { preHandler: read }, async (request, reply) => {
    const filters = parseQuery(appointmentFiltersSchema, request.query);
    return reply.status(200).send(await listAppointments(db, filters));
  });

  /** Asignar una solicitud a una franja (o crear una cita directa). */
  app.post('/api/v1/appointments', { preHandler: write }, async (request, reply) => {
    const actor = actorFrom(request);
    const input = parseOrThrow(assignAppointmentSchema, request.body);
    return reply.status(201).send(await assignAppointment(db, input, actor, { config }));
  });

  app.get('/api/v1/appointments/:id', { preHandler: read }, async (request, reply) => {
    const { id } = parseOrThrow(idParamsSchema, request.params);
    return reply.status(200).send(await getAppointment(db, id));
  });

  app.get('/api/v1/appointments/:id/history', { preHandler: read }, async (request, reply) => {
    const { id } = parseOrThrow(idParamsSchema, request.params);
    const items = await getHistory(db, 'appointment', id);
    return reply.status(200).send({ items, total: items.length });
  });

  app.post('/api/v1/appointments/:id/check-in', { preHandler: write }, async (request, reply) => {
    const actor = actorFrom(request);
    const { id } = parseOrThrow(idParamsSchema, request.params);
    const result = await transitionAppointment(db, id, 'en_sala_espera', actor, { config });
    return reply.status(200).send(result);
  });

  app.post('/api/v1/appointments/:id/call', { preHandler: write }, async (request, reply) => {
    const actor = actorFrom(request);
    const { id } = parseOrThrow(idParamsSchema, request.params);
    const result = await transitionAppointment(db, id, 'llamado', actor, { config });
    return reply.status(200).send(result);
  });

  app.post('/api/v1/appointments/:id/start', { preHandler: write }, async (request, reply) => {
    const actor = actorFrom(request);
    const { id } = parseOrThrow(idParamsSchema, request.params);
    const result = await transitionAppointment(db, id, 'en_consulta', actor, { config });
    return reply.status(200).send(result);
  });

  /**
   * Marcar atendido. Mientras no exista el módulo clínico (Fase 6) exige un motivo,
   * que queda en la auditoría (el plan pide auditar el «atendido» forzado).
   */
  app.post('/api/v1/appointments/:id/attend', { preHandler: write }, async (request, reply) => {
    const actor = actorFrom(request);
    const { id } = parseOrThrow(idParamsSchema, request.params);
    const input = parseOrThrow(attendAppointmentSchema, request.body ?? {});
    const result = await transitionAppointment(db, id, 'atendido', actor, {
      config,
      forceReason: input.forceReason,
      clinicalSessionId: input.clinicalSessionId,
    });
    return reply.status(200).send(result);
  });

  /** Inasistencia: solo después de la hora de la cita más la tolerancia. */
  app.post('/api/v1/appointments/:id/no-show', { preHandler: write }, async (request, reply) => {
    const actor = actorFrom(request);
    const { id } = parseOrThrow(idParamsSchema, request.params);
    const input = parseOrThrow(noShowAppointmentSchema, request.body ?? {});
    const result = await transitionAppointment(db, id, 'no_asistio', actor, {
      config,
      reason: input.reason,
    });
    return reply.status(200).send(result);
  });

  app.post('/api/v1/appointments/:id/cancel', { preHandler: write }, async (request, reply) => {
    const actor = actorFrom(request);
    const { id } = parseOrThrow(idParamsSchema, request.params);
    const input = parseOrThrow(cancelAppointmentSchema, request.body ?? {});
    const result = await transitionAppointment(db, id, 'cancelada', actor, {
      config,
      reason: input.reason,
    });
    return reply.status(200).send(result);
  });

  /** Reprogramar: la cita original queda trazada y la nueva se enlaza con ella. */
  app.post('/api/v1/appointments/:id/reschedule', { preHandler: write }, async (request, reply) => {
    const actor = actorFrom(request);
    const { id } = parseOrThrow(idParamsSchema, request.params);
    const input = parseOrThrow(rescheduleAppointmentSchema, request.body);
    return reply.status(200).send(await rescheduleAppointment(db, id, input, actor, { config }));
  });
};
