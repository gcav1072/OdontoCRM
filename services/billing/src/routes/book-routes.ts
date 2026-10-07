import { bookFileName, bookQuerySchema, igtfBookToCsv, salesBookToCsv } from '@odontocrm/contracts';
import { parseOrThrow, requirePermission } from '@odontocrm/kernel';
import type { FastifyInstance } from 'fastify';

import { igtfBookRows, rangoDelLibro, salesBookRows } from '../billing/book-service.js';
import type { BillingServices } from '../services.js';

/**
 * Los **libros fiscales** en CSV: lo que se le entrega al contador (Art. 75).
 *
 * Se sirven como descarga (`text/csv` + `content-disposition`) porque es un archivo para Excel, no una
 * pantalla. Ojo con `reply`: se le ponen las cabeceras **sin `await`** y se devuelve el texto —`reply`
 * es *thenable* y esperarlo antes de devolverlo interbloquea la respuesta, que es el fallo que destapó
 * el humo en las rutas de la tasa y del lote—.
 */
export const registerBookRoutes = (app: FastifyInstance, services: BillingServices): void => {
  const { db } = services;
  const read = requirePermission('billing:read');

  /** Libro de ventas del período: facturas emitidas y sus notas de crédito, con el desglose. */
  app.get('/api/v1/billing/books/sales.csv', { preHandler: read }, async (request, reply) => {
    const query = parseOrThrow(bookQuerySchema, request.query);
    const csv = salesBookToCsv(await salesBookRows(db, rangoDelLibro(query)));
    reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${bookFileName('ventas', query)}"`);
    return csv;
  });

  /** Libro de IGTF del período: solo los cobros en los que el tributo se causó. */
  app.get('/api/v1/billing/books/igtf.csv', { preHandler: read }, async (request, reply) => {
    const query = parseOrThrow(bookQuerySchema, request.query);
    const csv = igtfBookToCsv(await igtfBookRows(db, rangoDelLibro(query)));
    reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${bookFileName('igtf', query)}"`);
    return csv;
  });
};
