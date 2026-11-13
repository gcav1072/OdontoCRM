import {
  clinicalAlerts,
  formatPrescriptionNumber,
  type ClinicalAlerts,
} from '@odontocrm/contracts';
import { ConflictError, ForbiddenError, parseOrThrow } from '@odontocrm/kernel';
import type { FastifyInstance } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

import { getPrescriptionDetail, readPrescriptionPdf } from '../clinical/prescription-service.js';
import { findRecordByPatient, getRecordDetail } from '../clinical/record-service.js';
import { getSessionStatus } from '../clinical/session-service.js';
import type { ClinicalServices } from '../services.js';

const patientParamsSchema = z.object({ patientId: z.uuid() });
const sessionParamsSchema = z.object({ id: z.uuid() });
const prescriptionParamsSchema = z.object({ id: z.uuid() });

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
  const { db, blobStore, config } = services;

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

  /**
   * Metadatos de un récipe para el **envío por chat** (Fase D): el servicio de
   * notificaciones no lee bases ajenas (ADR 0004/0015), así que pide por aquí lo
   * que necesita para encolar el mensaje —de quién es, qué número lleva y cómo se
   * llama el archivo— y luego descarga el PDF de la ruta de al lado.
   *
   * `number` es el número formateado (`RX-000001`) y `filename` el nombre que
   * llevará el adjunto: el mismo que devuelve `readPrescriptionPdf` al descargarlo.
   */
  app.get('/internal/v1/clinical/prescriptions/:id/meta', async (request, reply) => {
    const { id } = parseOrThrow(prescriptionParamsSchema, request.params);
    // La lectura existente: 404 si no existe y el estado ya tipado por el contrato.
    const detalle = await getPrescriptionDetail(db, id);
    return reply.status(200).send({
      id: detalle.id,
      patientId: detalle.patientId,
      status: detalle.status,
      number: detalle.number,
      filename: `${formatPrescriptionNumber(detalle.prescriptionNumber ?? 0)}.pdf`,
      issuedAt: detalle.issuedAt,
    });
  });

  /**
   * El PDF archivado, para mandarlo por WhatsApp o Telegram.
   *
   * Se comprueba el estado **antes** de leer: el récipe anulado conserva su PDF
   * archivado —el papel emitido sigue existiendo— y `readPrescriptionPdf` lo
   * devolvería sin chistar; compartirlo sería mandarle al paciente un documento
   * sin efecto. El borrador no tiene PDF, así que también responde 409.
   */
  app.get('/internal/v1/clinical/prescriptions/:id/pdf', async (request, reply) => {
    const { id } = parseOrThrow(prescriptionParamsSchema, request.params);
    const detalle = await getPrescriptionDetail(db, id);
    if (detalle.status !== 'emitida') {
      // `prescriptionStatus` y no `status`: el cuerpo del error ya lleva el estado
      // HTTP en `status` y no se debe pisar.
      throw new ConflictError('Solo se comparten récipes emitidos', {
        extensions: { prescriptionStatus: detalle.status },
      });
    }

    const pdf = await readPrescriptionPdf(db, blobStore, id);
    return reply
      .status(200)
      .header('content-type', 'application/pdf')
      .header('content-disposition', `attachment; filename="${pdf.filename}"`)
      .send(pdf.buffer);
  });
};
