import { clinicalAlerts, type ClinicalAlerts } from '@odontocrm/contracts';
import { ForbiddenError, parseOrThrow } from '@odontocrm/kernel';
import type { FastifyInstance } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

import { findRecordByPatient, getRecordDetail } from '../clinical/record-service.js';
import { getSessionStatus } from '../clinical/session-service.js';
import type { ClinicalServices } from '../services.js';

const patientParamsSchema = z.object({ patientId: z.uuid() });
const sessionParamsSchema = z.object({ id: z.uuid() });

const safeEquals = (left: string, right: string): boolean => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

/**
 * Rutas internas: solo entre servicios, con el secreto compartido y sin pasar
 * por el gateway. Las usa el servicio de pantallas para pintar las alertas
 * clínicas del paciente en curso.
 */
export const registerInternalRoutes = (app: FastifyInstance, services: ClinicalServices): void => {
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
   * Alertas clínicas del paciente (alergias, crónicos, anticoagulantes) para la
   * pantalla del consultorio. Responde con la lista vacía cuando todavía no hay
   * historia: la pantalla muestra entonces el aviso de «sin historia clínica».
   */
  app.get('/internal/v1/clinical/patients/:patientId/alerts', async (request, reply) => {
    const { patientId } = parseOrThrow(patientParamsSchema, request.params);
    const record = await findRecordByPatient(db, patientId);
    if (record === null) {
      const vacio: ClinicalAlerts = { patientId, alerts: [], hasRecord: false };
      return reply.status(200).send(vacio);
    }

    const detail = await getRecordDetail(db, record.id);
    const result: ClinicalAlerts = {
      patientId,
      alerts: clinicalAlerts(detail.sections),
      hasRecord: true,
    };
    return reply.status(200).send(result);
  });

  /**
   * Estado de una sesión clínica. La **agenda** lo consulta antes de dejar marcar
   * «atendido» sin motivo: sin esta comprobación, cualquier cliente podría saltarse
   * la regla mandando un identificador inventado.
   */
  app.get('/internal/v1/clinical/sessions/:id/status', async (request, reply) => {
    const { id } = parseOrThrow(sessionParamsSchema, request.params);
    return reply.status(200).send(await getSessionStatus(db, id));
  });
};
