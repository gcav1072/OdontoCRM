import { CLINIC, dossierVerificationResultSchema } from '@odontocrm/contracts';
import { parseOrThrow, requirePermission } from '@odontocrm/kernel';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import {
  issueDossier,
  listDossierExports,
  readDossierPdf,
  verifyDossier,
} from '../clinical/dossier-service.js';
import type { ClinicalServices } from '../services.js';
import { actorFrom } from '../shared/context.js';

const patientParamsSchema = z.object({ patientId: z.uuid() });
const dossierParamsSchema = z.object({ id: z.uuid() });
const codeParamsSchema = z.object({ code: z.string().trim().min(4).max(40) });

/**
 * Dossier del expediente (mejoras post-Fase 11).
 *
 * Tres rutas privadas —exportar, listar lo exportado y recuperar un PDF archivado— con
 * `clinical:read`, el mismo permiso con el que la secretaría imprime (ADR 0015: imprimir
 * es leer), y **una pública**: la verificación del código del QR, que abre cualquiera que
 * tenga el papel en la mano y que no devuelve ningún dato clínico.
 */
export const registerDossierRoutes = (app: FastifyInstance, services: ClinicalServices): void => {
  const { db, blobStore, pdfRenderer, patientLookup, odontogramLookup, config, kickOutbox } =
    services;
  const read = requirePermission('clinical:read');

  /**
   * Exporta el expediente: compone el PDF A4, lo archiva con su huella y lo devuelve.
   *
   * Se responde el propio PDF en vez de un enlace para que descarga y visualización sean
   * el mismo acto: el navegador lo abre con el visor integrado y no hay una URL temporal
   * que guardar. Quien necesite el archivo otra vez tiene `/dossiers/:id/pdf`, que no
   * recompone nada.
   */
  app.get(
    '/api/v1/clinical/patients/:patientId/dossier',
    { preHandler: read },
    async (request, reply) => {
      const { patientId } = parseOrThrow(patientParamsSchema, request.params);
      const actor = actorFrom(request);

      const emitido = await issueDossier(
        { db, blobStore, pdfRenderer, patientLookup, odontogramLookup },
        patientId,
        actor,
        { publicAppUrl: config.PUBLIC_APP_URL, logoPath: CLINIC.logoPath },
      );

      kickOutbox?.();
      return reply
        .status(200)
        .header('content-type', 'application/pdf')
        .header(
          'content-disposition',
          `inline; filename="${encodeURIComponent(`${emitido.export.number}.pdf`)}"`,
        )
        .header('x-dossier-number', emitido.export.number)
        .send(emitido.pdf);
    },
  );

  /** Las exportaciones archivadas del paciente (fecha, número y huella). */
  app.get(
    '/api/v1/clinical/patients/:patientId/dossiers',
    { preHandler: read },
    async (request, reply) => {
      const { patientId } = parseOrThrow(patientParamsSchema, request.params);
      const items = await listDossierExports(db, patientId);
      return reply.status(200).send({ items, total: items.length });
    },
  );

  /** Vuelve a servir un dossier archivado, sin recomponerlo (es el mismo archivo). */
  app.get('/api/v1/clinical/dossiers/:id/pdf', { preHandler: read }, async (request, reply) => {
    const { id } = parseOrThrow(dossierParamsSchema, request.params);
    const { buffer, number } = await readDossierPdf(db, blobStore, id);
    return reply
      .status(200)
      .header('content-type', 'application/pdf')
      .header('content-disposition', `inline; filename="${encodeURIComponent(`${number}.pdf`)}"`)
      .send(buffer);
  });

  /* ── Verificación pública (sin sesión) ───────────────────────────────────── */

  /**
   * Lo que abre el QR del dossier. No lleva datos clínicos (ADR 0015): confirma que el
   * documento consta y a nombre de quién está.
   */
  app.get('/api/v1/clinical/verify-expediente/:code', async (request, reply) => {
    const { code } = parseOrThrow(codeParamsSchema, request.params);
    const resultado = await verifyDossier(db, code, CLINIC.name);
    return reply.status(200).send(dossierVerificationResultSchema.parse(resultado));
  });
};
