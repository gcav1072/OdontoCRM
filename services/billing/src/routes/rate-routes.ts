import { setExchangeRateSchema } from '@odontocrm/contracts';
import { parseOrThrow, requirePermission } from '@odontocrm/kernel';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { listRates, rateStatus, setRate } from '../rates/rate-service.js';
import type { BillingServices } from '../services.js';
import { actorFrom } from '../shared/context.js';

const historialQuerySchema = z.object({
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

/**
 * La tasa del día (Fase 11, sesión B): el widget de la jornada. Ver la tasa vigente basta con
 * `billing:read`; fijarla o corregirla exige `billing:rates` y **motivo** cuando corrige.
 *
 * La caja nunca llama a internet: si la captura automática falla, la secretaría la ingresa aquí.
 */
export const registerRateRoutes = (app: FastifyInstance, services: BillingServices): void => {
  const { db, kickOutbox } = services;
  const read = requirePermission('billing:read');
  const rates = requirePermission('billing:rates');

  /** La vigente para hoy (o para la fecha que se pida), con el hueco que arrastra. */
  app.get('/api/v1/billing/rates/today', { preHandler: read }, async (request) => {
    const { date } = z.object({ date: z.string().optional() }).parse(request.query);
    return rateStatus(db, date);
  });

  app.get('/api/v1/billing/rates', { preHandler: read }, async (request) => {
    const filtros = parseOrThrow(historialQuerySchema, request.query);
    return { items: await listRates(db, filtros) };
  });

  app.post('/api/v1/billing/rates', { preHandler: rates }, async (request, reply) => {
    const input = parseOrThrow(setExchangeRateSchema, request.body);
    const rate = await setRate(db, input, actorFrom(request));
    // El publicador avanza ya: la tasa queda en la auditoría sin esperar el ciclo.
    kickOutbox?.();
    // Sin `await`: `reply` es *thenable* y esperarlo antes de devolverlo sería un interbloqueo.
    reply.code(201);
    return rate;
  });
};
