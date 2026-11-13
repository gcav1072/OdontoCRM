import { formatInvoiceNumber, formatReceiptNumber } from '@odontocrm/contracts';
import { ConflictError, ForbiddenError, NotFoundError, parseOrThrow } from '@odontocrm/kernel';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import {
  facturaArchivada,
  reciboArchivado,
  type DocumentoArchivado,
} from '../billing/archive-service.js';
import { invoices, payments } from '../db/schema.js';
import type { BillingServices } from '../services.js';

const paramsSchema = z.object({ id: z.uuid() });

const safeEquals = (left: string, right: string): boolean => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

/**
 * Nada que no sea `[0-9A-Za-z._-]`: el nombre viaja a `content-disposition` y a la
 * cabecera del chat. Mismo criterio que `archive-service` (el nombre tiene que
 * coincidir con el que el servicio de notificaciones anuncia).
 */
const nombreSeguro = (base: string): string => {
  const limpio = base.replace(/[^0-9A-Za-z._-]/g, '-');
  return `${limpio.length > 0 ? limpio : 'documento'}.pdf`;
};

/** La etiqueta de la factura: su número formateado o «borrador» si aún no lo tiene. */
const etiquetaFactura = (series: string, invoiceNumber: number | null): string =>
  invoiceNumber === null ? 'borrador' : formatInvoiceNumber(series, invoiceNumber);

/**
 * Rutas internas de **facturación**: solo entre servicios, con el secreto compartido
 * y sin pasar por el gateway (igual que clinical, patients y scheduling).
 *
 * Las usa el servicio de notificaciones para mandar por WhatsApp o Telegram los
 * PDFs que facturación **archivó** al emitir (ADR 0048): este servicio es el dueño
 * del almacén y de su base, así que nadie más los lee (ADR 0004/0015).
 *
 * Solo se comparten documentos vigentes: un borrador o una factura anulada responde
 * **409** —el estado choca con lo que se pide— y se reserva el 404 para lo que no
 * existe o no tiene archivo.
 */
export const registerInternalRoutes = (app: FastifyInstance, services: BillingServices): void => {
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

  /** Entrega el archivo como adjunto: el destino lo reenvía a un chat, no lo pinta. */
  const servir = (reply: FastifyReply, documento: DocumentoArchivado): unknown => {
    reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', `attachment; filename="${documento.filename}"`);
    return reply.send(documento.bytes);
  };

  /**
   * Metadatos de una factura para el envío por chat: de quién es, en qué estado está,
   * su número y el nombre del adjunto. Responde igual para un borrador o una anulada
   * —es justo lo que el servicio de notificaciones necesita saber para no encolarlo—.
   */
  app.get('/internal/v1/billing/invoices/:id/meta', async (request, reply) => {
    const { id } = parseOrThrow(paramsSchema, request.params);
    const [fila] = await db
      .select({
        id: invoices.id,
        patientId: invoices.patientId,
        patientName: invoices.patientName,
        status: invoices.status,
        series: invoices.series,
        invoiceNumber: invoices.invoiceNumber,
        issuedAt: invoices.issuedAt,
      })
      .from(invoices)
      .where(eq(invoices.id, id))
      .limit(1);
    if (fila === undefined) throw new NotFoundError('Esa factura no existe');

    return reply.status(200).send({
      id: fila.id,
      patientId: fila.patientId,
      patientName: fila.patientName,
      status: fila.status,
      number:
        fila.invoiceNumber === null ? null : formatInvoiceNumber(fila.series, fila.invoiceNumber),
      filename: nombreSeguro(`factura-${etiquetaFactura(fila.series, fila.invoiceNumber)}`),
      issuedAt: fila.issuedAt === null ? null : fila.issuedAt.toISOString(),
    });
  });

  /**
   * La factura emitida, tal como se archivó. Un borrador o una factura anulada no se
   * comparten: el estado se mira **antes** de leer el archivo, porque la anulada
   * conserva su PDF y `facturaArchivada` lo devolvería sin quejarse.
   */
  app.get('/internal/v1/billing/invoices/:id/pdf', async (request, reply) => {
    const { id } = parseOrThrow(paramsSchema, request.params);
    const [fila] = await db
      .select({ status: invoices.status, voidedAt: invoices.voidedAt })
      .from(invoices)
      .where(eq(invoices.id, id))
      .limit(1);
    if (fila === undefined) throw new NotFoundError('Esa factura no existe');

    const anulada = fila.voidedAt !== null || fila.status === 'anulada';
    if (fila.status === 'borrador' || anulada) {
      // `invoiceStatus` y no `status`: el cuerpo del error ya lleva el estado HTTP
      // en `status` y no se debe pisar.
      throw new ConflictError('Solo se comparten facturas emitidas y vigentes', {
        extensions: {
          invoiceStatus: fila.status,
          voided: fila.voidedAt !== null,
        },
      });
    }

    return servir(reply, await facturaArchivada(db, blobStore, id));
  });

  /**
   * Metadatos de un cobro. El paciente **no** se guarda en el pago: se resuelve de la
   * factura padre, que es la que lleva la instantánea del paciente (ADR 0048).
   */
  app.get('/internal/v1/billing/payments/:id/meta', async (request, reply) => {
    const { id } = parseOrThrow(paramsSchema, request.params);
    const [fila] = await db
      .select({
        id: payments.id,
        invoiceId: payments.invoiceId,
        receiptNumber: payments.receiptNumber,
        createdAt: payments.createdAt,
        patientId: invoices.patientId,
      })
      .from(payments)
      .innerJoin(invoices, eq(payments.invoiceId, invoices.id))
      .where(eq(payments.id, id))
      .limit(1);
    if (fila === undefined) throw new NotFoundError('Ese cobro no existe');

    const recibo = formatReceiptNumber(fila.receiptNumber);
    return reply.status(200).send({
      id: fila.id,
      invoiceId: fila.invoiceId,
      patientId: fila.patientId,
      receiptNumber: recibo,
      filename: nombreSeguro(`recibo-${recibo}`),
      paidAt: fila.createdAt.toISOString(),
    });
  });

  /**
   * El recibo de un cobro. Un cobro anulado no se comparte —su recibo ya no
   * corresponde a dinero vigente— y uno sin PDF archivado tampoco: los dos casos
   * chocan con el estado y responden 409, no un archivo vacío.
   */
  app.get('/internal/v1/billing/payments/:id/receipt', async (request, reply) => {
    const { id } = parseOrThrow(paramsSchema, request.params);
    const [fila] = await db
      .select({ voidedAt: payments.voidedAt, pdfPath: payments.pdfPath })
      .from(payments)
      .where(eq(payments.id, id))
      .limit(1);
    if (fila === undefined) throw new NotFoundError('Ese cobro no existe');
    if (fila.voidedAt !== null) {
      throw new ConflictError('Ese cobro está anulado: su recibo no se comparte', {
        extensions: { paymentId: id },
      });
    }
    if (fila.pdfPath === null) {
      throw new ConflictError('Ese cobro todavía no tiene recibo archivado', {
        extensions: { paymentId: id },
      });
    }

    return servir(reply, await reciboArchivado(db, blobStore, id));
  });
};
