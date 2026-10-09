import {
  appointmentActivityFiltersSchema,
  appointmentCancellationFiltersSchema,
  appointmentFiltersSchema,
  assignAppointmentSchema,
  attendAppointmentSchema,
  cancelAppointmentSchema,
  confirmAppointmentSchema,
  noShowAppointmentSchema,
  rescheduleAppointmentSchema,
} from '@odontocrm/contracts';
import { parseOrThrow, parseQuery, requirePermission } from '@odontocrm/kernel';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import {
  assignAppointment,
  confirmAppointment,
  getAppointment,
  getHistory,
  listAppointmentActivity,
  listAppointments,
  listPatientCancellations,
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

  /**
   * Publica el evento del cambio ahora mismo, sin esperar al temporizador del
   * outbox: el llamado tiene que aparecer en el displaylobby al instante y no
   * medio segundo después. No se espera la publicación (la respuesta al usuario
   * no depende de la cola) y un fallo se registra donde corresponde.
   */
  const publicarYa = (): void => {
    services.kickOutbox?.();
  };

  app.get('/api/v1/appointments', { preHandler: read }, async (request, reply) => {
    const filters = parseQuery(appointmentFiltersSchema, request.query);
    return reply.status(200).send(await listAppointments(db, filters));
  });

  /**
   * **Cancelaciones hechas por el paciente** (ADR 0053): lo que pinta la tarjeta de
   * `/programacion`. Es una ruta **estática**, declarada antes de `/:id` para que
   * «cancellations» no se lea como un identificador (Fastify prioriza las estáticas,
   * pero dejarlo explícito evita sorpresas al añadir rutas).
   */
  app.get('/api/v1/appointments/cancellations', { preHandler: read }, async (request, reply) => {
    const filters = parseQuery(appointmentCancellationFiltersSchema, request.query);
    return reply.status(200).send(await listPatientCancellations(db, filters));
  });

  /**
   * **Novedades de citas** (feed de `/inicio`, ADR 0057): lo último que hicieron los
   * pacientes con sus citas por el bot. Ruta **estática** declarada antes de `/:id` por
   * la misma razón que `cancellations`: que «activity» no se lea como un identificador.
   */
  app.get('/api/v1/appointments/activity', { preHandler: read }, async (request, reply) => {
    const filters = parseQuery(appointmentActivityFiltersSchema, request.query);
    const items = await listAppointmentActivity(db, filters);
    return reply.status(200).send({ items, total: items.length });
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
    publicarYa();
    return reply.status(200).send(result);
  });

  app.post('/api/v1/appointments/:id/call', { preHandler: write }, async (request, reply) => {
    const actor = actorFrom(request);
    const { id } = parseOrThrow(idParamsSchema, request.params);
    const result = await transitionAppointment(db, id, 'llamado', actor, { config });
    publicarYa();
    return reply.status(200).send(result);
  });

  app.post('/api/v1/appointments/:id/start', { preHandler: write }, async (request, reply) => {
    const actor = actorFrom(request);
    const { id } = parseOrThrow(idParamsSchema, request.params);
    const result = await transitionAppointment(db, id, 'en_consulta', actor, { config });
    publicarYa();
    return reply.status(200).send(result);
  });

  /**
   * Marcar atendido. Exige la **sesión clínica cerrada** (Fase 7): la que llega en
   * el cuerpo se verifica contra el servicio clínico, y sin ella hace falta un
   * motivo que queda en la auditoría (el plan pide auditar el «atendido» forzado).
   */
  app.post('/api/v1/appointments/:id/attend', { preHandler: write }, async (request, reply) => {
    const actor = actorFrom(request);
    const { id } = parseOrThrow(idParamsSchema, request.params);
    const input = parseOrThrow(attendAppointmentSchema, request.body ?? {});
    const result = await transitionAppointment(db, id, 'atendido', actor, {
      config,
      forceReason: input.forceReason,
      clinicalSessionId: input.clinicalSessionId,
      sessionLookup: services.sessionLookup,
    });
    publicarYa();
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
    publicarYa();
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
    publicarYa();
    return reply.status(200).send(result);
  });

  /** Reprogramar: la cita original queda trazada y la nueva se enlaza con ella. */
  app.post('/api/v1/appointments/:id/reschedule', { preHandler: write }, async (request, reply) => {
    const actor = actorFrom(request);
    const { id } = parseOrThrow(idParamsSchema, request.params);
    const input = parseOrThrow(rescheduleAppointmentSchema, request.body);
    return reply.status(200).send(await rescheduleAppointment(db, id, input, actor, { config }));
  });

  /**
   * **Confirmación telefónica** (ADR 0052): la secretaría llamó al paciente y deja
   * constancia de que dijo que sí. Es la misma vía que la del bot, pero con un actor
   * con roles, así que aquí sí se aplica la máquina de estados.
   *
   * Exige `scheduling:write` —la tiene la secretaría y el admin— y no
   * `scheduling:notify`: confirmar no es avisar, es anotar la respuesta.
   */
  app.post('/api/v1/appointments/:id/confirm', { preHandler: write }, async (request, reply) => {
    const actor = actorFrom(request);
    const { id } = parseOrThrow(idParamsSchema, request.params);
    const input = parseOrThrow(confirmAppointmentSchema, request.body ?? {});
    const result = await confirmAppointment(db, id, input, actor);
    publicarYa();
    return reply.status(200).send(result);
  });
};
