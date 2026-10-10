import {
  chairInputSchema,
  chairUpdateSchema,
  dateSchema,
  notifyBatchInputSchema,
  notifyPreviewSchema,
  setCapacitySchema,
  slotTemplateInputSchema,
  timeRangeSchema,
  timeSchema,
} from '@odontocrm/contracts';
import { parseOrThrow, parseQuery, requirePermission } from '@odontocrm/kernel';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import {
  createTemplate,
  deleteTemplate,
  listCapacities,
  listTemplates,
  setCapacity,
  updateTemplate,
} from '../agenda/capacity-service.js';
import { createChair, listChairs, updateChair } from '../agenda/chair-service.js';
import { getDayView } from '../agenda/day-view-service.js';
import { notifyBatch, notifyPreview } from '../agenda/notify-service.js';
import type { SchedulingServices } from '../services.js';
import { actorFrom } from '../shared/context.js';

const dateParamsSchema = z.object({ date: dateSchema });
const idParamsSchema = z.object({ id: z.uuid() });
const capacityQuerySchema = z.object({ from: dateSchema, to: dateSchema });
const chairListQuerySchema = z.object({
  /** `true` = incluir los consultorios desactivados (para administrarlos). */
  todos: z.enum(['true', 'false']).optional(),
});

/**
 * Edición parcial de una plantilla. Se declara aparte y no con `.partial()`:
 * Zod 4 no permite derivar un parcial de un esquema que tiene refinamientos
 * (la validación de jornada y pausas de `slotTemplateInputSchema`).
 */
const templatePatchSchema = z.object({
  weekday: z.coerce.number().int().min(0).max(6).optional(),
  chairId: z.uuid().nullable().optional(),
  startTime: timeSchema.optional(),
  endTime: timeSchema.optional(),
  slotMinutes: z.coerce.number().int().min(5).max(240).optional(),
  breaks: z.array(timeRangeSchema).max(6).optional(),
  isActive: z.boolean().optional(),
});

export const registerAgendaRoutes = (app: FastifyInstance, services: SchedulingServices): void => {
  const { db, config } = services;
  const read = requirePermission('scheduling:read');
  const write = requirePermission('scheduling:write');
  const notify = requirePermission('scheduling:notify');
  /** Administrar el catálogo de consultorios: solo el `admin` (`scheduling:manage`). */
  const manage = requirePermission('scheduling:manage');

  /** Todo lo que necesita la pantalla de programación para un día (por consultorio). */
  app.get('/api/v1/agenda/days/:date', { preHandler: read }, async (request, reply) => {
    const { date } = parseOrThrow(dateParamsSchema, request.params);
    return reply
      .status(200)
      .send(await getDayView(db, date, config, { dentistCatalog: services.dentistCatalog }));
  });

  /* ── Consultorios (sillones) ─────────────────────────────────────────────── */

  app.get('/api/v1/agenda/chairs', { preHandler: read }, async (request, reply) => {
    const { todos } = parseQuery(chairListQuerySchema, request.query);
    const items = await listChairs(db, { includeInactive: todos === 'true' });
    return reply.status(200).send({ items, total: items.length });
  });

  app.post('/api/v1/agenda/chairs', { preHandler: manage }, async (request, reply) => {
    const input = parseOrThrow(chairInputSchema, request.body);
    return reply.status(201).send(await createChair(db, input));
  });

  app.patch('/api/v1/agenda/chairs/:id', { preHandler: manage }, async (request, reply) => {
    const { id } = parseOrThrow(idParamsSchema, request.params);
    const input = parseOrThrow(chairUpdateSchema, request.body ?? {});
    return reply.status(200).send(await updateChair(db, id, input));
  });

  app.get('/api/v1/agenda/capacity', { preHandler: read }, async (request, reply) => {
    const { from, to } = parseQuery(capacityQuerySchema, request.query);
    const items = await listCapacities(db, from, to, config);
    return reply.status(200).send({ items, total: items.length });
  });

  /** Cambiar el cupo: se puede en cualquier momento, incluso con citas asignadas. */
  app.put('/api/v1/agenda/capacity', { preHandler: write }, async (request, reply) => {
    const actor = actorFrom(request);
    const input = parseOrThrow(setCapacitySchema, request.body);
    return reply.status(200).send(await setCapacity(db, input, actor, config));
  });

  app.get('/api/v1/agenda/templates', { preHandler: read }, async (_request, reply) => {
    const items = await listTemplates(db);
    return reply.status(200).send({ items, total: items.length });
  });

  app.post('/api/v1/agenda/templates', { preHandler: write }, async (request, reply) => {
    const actor = actorFrom(request);
    const input = parseOrThrow(slotTemplateInputSchema, request.body);
    return reply.status(201).send(await createTemplate(db, input, actor));
  });

  app.patch('/api/v1/agenda/templates/:id', { preHandler: write }, async (request, reply) => {
    const actor = actorFrom(request);
    const { id } = parseOrThrow(idParamsSchema, request.params);
    const input = parseOrThrow(templatePatchSchema, request.body);
    return reply.status(200).send(await updateTemplate(db, id, input, actor));
  });

  app.delete('/api/v1/agenda/templates/:id', { preHandler: write }, async (request, reply) => {
    const actor = actorFrom(request);
    const { id } = parseOrThrow(idParamsSchema, request.params);
    await deleteTemplate(db, id, actor);
    return reply.status(204).send();
  });

  /** Vista previa del lote: exactamente los mensajes que se enviarán. */
  app.post('/api/v1/agenda/notify/preview', { preHandler: read }, async (request, reply) => {
    const input = parseOrThrow(notifyPreviewSchema, request.body ?? {});
    return reply.status(200).send(await notifyPreview(db, input, config, { force: false }));
  });

  /** Marca el lote como notificado y publica el evento que enviará la Fase 4. */
  app.post('/api/v1/agenda/notify', { preHandler: notify }, async (request, reply) => {
    const actor = actorFrom(request);
    const input = parseOrThrow(notifyBatchInputSchema, request.body ?? {});
    return reply
      .status(200)
      .send(await notifyBatch(db, input, actor, config, services.dentistCatalog));
  });
};
