import { ForbiddenError, parseOrThrow } from '@odontocrm/kernel';
import type { FastifyInstance } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

import { getInternalChart, getInternalSummary } from '../odontogram/chart-service.js';
import type { OdontogramServices } from '../services.js';

const patientParamsSchema = z.object({ patientId: z.uuid() });

const safeEquals = (left: string, right: string): boolean => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

/**
 * Rutas internas: solo entre servicios, con el secreto compartido y sin pasar
 * por el gateway. El resumen del odontograma lo consumirá la Fase 9 (reportes) y
 * sirve además de comprobación barata sin traerse la boca entera.
 */
export const registerInternalRoutes = (
  app: FastifyInstance,
  services: OdontogramServices,
): void => {
  const { db, config } = services;

  app.addHook('onRequest', async (request) => {
    if (!request.url.startsWith('/internal/')) return;

    const expected = config.INTERNAL_SERVICE_SECRET;
    if (expected === undefined) {
      throw new ForbiddenError('Las rutas internas están deshabilitadas en este entorno');
    }
    const provided = request.headers['x-internal-token'];
    if (typeof provided !== 'string' || !safeEquals(provided, expected)) {
      throw new ForbiddenError('Token interno inválido');
    }
  });

  /**
   * Resumen del odontograma del paciente: cuántas piezas están afectadas, de qué
   * condiciones y cuántas quedan pendientes. Sin odontograma responde 200 con
   * `hasOdontogram: false` y los contadores a cero.
   */
  app.get('/internal/v1/odontogram/patients/:patientId/summary', async (request, reply) => {
    const { patientId } = parseOrThrow(patientParamsSchema, request.params);
    return reply.status(200).send(await getInternalSummary(db, patientId));
  });

  /**
   * La boca entera —dentición y hallazgos vigentes— para quien tenga que **dibujarla**:
   * el dossier del expediente arma con esto el odontograma del PDF. El resumen de
   * arriba sirve de comprobación barata; esto es lo que hace falta para pintar.
   */
  app.get('/internal/v1/odontogram/patients/:patientId/chart', async (request, reply) => {
    const { patientId } = parseOrThrow(patientParamsSchema, request.params);
    return reply.status(200).send(await getInternalChart(db, patientId));
  });
};
