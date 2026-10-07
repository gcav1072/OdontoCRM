import { parseOrThrow, requirePermission } from '@odontocrm/kernel';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';

import {
  facturaArchivada,
  notaCreditoArchivada,
  reciboArchivado,
  type DocumentoArchivado,
} from '../billing/archive-service.js';
import type { BillingServices } from '../services.js';

/**
 * Los **documentos archivados**, para verlos y reimprimirlos (ADR 0048).
 *
 * Se sirven `inline` —no como descarga— porque el mostrador los abre para imprimirlos en el navegador.
 * El archivo es el que se guardó al emitir: no se vuelve a componer.
 *
 * Ojo con `reply`: se le ponen las cabeceras **sin `await`** y se devuelve `reply.send(...)`, que es la
 * forma correcta; `await reply.code(...)` interbloquea la respuesta (el fallo que destapó el humo).
 */
const paramsSchema = z.object({ id: z.uuid() });

export const registerDocumentRoutes = (app: FastifyInstance, services: BillingServices): void => {
  const { db, blobStore } = services;
  const read = requirePermission('billing:read');

  const servir = (reply: FastifyReply, documento: DocumentoArchivado): unknown => {
    reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', `inline; filename="${documento.filename}"`);
    return reply.send(documento.bytes);
  };

  /** La factura emitida. */
  app.get('/api/v1/billing/invoices/:id/pdf', { preHandler: read }, async (request, reply) => {
    const { id } = parseOrThrow(paramsSchema, request.params);
    return servir(reply, await facturaArchivada(db, blobStore, id));
  });

  /** El recibo de un cobro. */
  app.get('/api/v1/billing/payments/:id/receipt', { preHandler: read }, async (request, reply) => {
    const { id } = parseOrThrow(paramsSchema, request.params);
    return servir(reply, await reciboArchivado(db, blobStore, id));
  });

  /** La nota de crédito con la que se anuló una factura. */
  app.get('/api/v1/billing/credit-notes/:id/pdf', { preHandler: read }, async (request, reply) => {
    const { id } = parseOrThrow(paramsSchema, request.params);
    return servir(reply, await notaCreditoArchivada(db, blobStore, id));
  });
};
