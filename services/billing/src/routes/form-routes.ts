import { createFiscalFormLotSchema, spoilFiscalFormSchema } from '@odontocrm/contracts';
import { parseOrThrow, requirePermission } from '@odontocrm/kernel';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { createLot, listLots, spoilForm } from '../billing/fiscal-forms-service.js';
import type { BillingServices } from '../services.js';
import { actorFrom } from '../shared/context.js';

const loteParamsSchema = z.object({ id: z.uuid() });
const listQuerySchema = z.object({ series: z.string().trim().min(1).max(4).optional() });

/**
 * El lote de formas libres (Fase 11, ADR 0047): el rango de **números de control** que autorizó la
 * imprenta. Ver el lote basta con `billing:read`; darlo de alta o marcar una forma dañada es
 * configuración fiscal (`billing:rates`).
 *
 * La caja avisa cuando quedan pocas formas: quedarse sin formas es quedarse sin poder facturar.
 */
export const registerFormRoutes = (app: FastifyInstance, services: BillingServices): void => {
  const { db, kickOutbox } = services;
  const read = requirePermission('billing:read');
  const config = requirePermission('billing:rates');

  app.get('/api/v1/billing/forms', { preHandler: read }, async (request) => {
    const { series } = parseOrThrow(listQuerySchema, request.query);
    return { items: await listLots(db, series) };
  });

  /** Alta del lote: rango desde/hasta, imprenta, RIF, providencia y fechas. */
  app.post('/api/v1/billing/forms', { preHandler: config }, async (request, reply) => {
    const input = parseOrThrow(createFiscalFormLotSchema, request.body);
    const lote = await createLot(db, input, actorFrom(request));
    kickOutbox?.();
    // Sin `await`: `reply` es *thenable* y esperarlo antes de devolverlo sería un interbloqueo.
    reply.code(201);
    return lote;
  });

  /** Forma estropeada: ocupa su control, se cuenta y **se conserva** (Art. 36 y 40). */
  app.post('/api/v1/billing/forms/:id/spoil', { preHandler: config }, async (request) => {
    const { id } = parseOrThrow(loteParamsSchema, request.params);
    const input = parseOrThrow(spoilFiscalFormSchema, request.body);
    const lote = await spoilForm(db, id, input, actorFrom(request));
    kickOutbox?.();
    return lote;
  });
};
