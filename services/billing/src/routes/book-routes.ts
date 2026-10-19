import {
  EXCHANGE_DIFF_BOOK_COLUMNS,
  IGTF_BOOK_COLUMNS,
  SALES_BOOK_COLUMNS,
  bookFileName,
  bookQuerySchema,
  exchangeDiffBookToCsv,
  igtfBookToCsv,
  salesBookToCsv,
  type BooksSummary,
  type ExchangeDiffSummary,
  type IgtfSummary,
} from '@odontocrm/contracts';
import { parseOrThrow, requirePermission } from '@odontocrm/kernel';
import type { FastifyInstance, FastifyReply } from 'fastify';

import {
  exchangeDiffBookRows,
  exchangeDiffSummary,
  igtfBookRows,
  igtfSummary,
  rangoDelLibro,
  salesBookRows,
} from '../billing/book-service.js';
import { renderBillingPdf } from '../billing/render-pdf.js';
import { renderBookHtml, type BookKind } from '../documents/book-pdf.js';
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

  /**
   * El **PDF** del libro, compuesto al pedirlo. No se archiva ni consume correlativo: es un informe,
   * no un documento fiscal por operación. Lleva el membrete del consultorio y la marca efectiva,
   * igual que la factura, y va en carta horizontal porque el libro de ventas tiene doce columnas.
   */
  const servirPdf = async (
    reply: FastifyReply,
    tipo: BookKind,
    etiqueta: string,
    columnas: Parameters<typeof renderBookHtml>[0]['columns'],
    filas: Parameters<typeof renderBookHtml>[0]['rows'],
    query: Parameters<typeof rangoDelLibro>[0],
    resumen?: { exchangeDiff?: ExchangeDiffSummary | null; igtf?: IgtfSummary | null } | undefined,
  ): Promise<unknown> => {
    const rango = rangoDelLibro(query);
    const marca = await services.brandLookup();
    const identidad = await services.letterheadLookup();
    const html = await renderBookHtml({
      kind: tipo,
      from: rango.from,
      to: rango.to,
      columns: columnas,
      rows: filas,
      summary: resumen,
      clinic: identidad.clinic,
      logoDataUri: identidad.logoDataUri,
      brand: marca.theme,
      fontFaceCss: marca.fontFaceCss,
    });
    const bytes = await renderBillingPdf(services.pdf, html, etiqueta, {
      landscape: true,
      folios: true,
    });
    // Cabeceras **sin `await`**: `reply` es *thenable* y esperarlo interbloquea la respuesta.
    reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', `attachment; filename="${bookFileName(tipo, query, 'pdf')}"`);
    return reply.send(bytes);
  };

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

  /**
   * **Estado de Ganancias y Pérdidas por Diferencial Cambiario** (ADR 0069, Escuela A): cobros con su
   * diferencial y reversiones por reembolso. Es el reporte contable del que la ley no pide Nota de
   * Débito: lo que rinde la clínica en su lugar.
   */
  app.get(
    '/api/v1/billing/books/exchange-diff.csv',
    { preHandler: read },
    async (request, reply) => {
      const query = parseOrThrow(bookQuerySchema, request.query);
      const csv = exchangeDiffBookToCsv(await exchangeDiffBookRows(db, rangoDelLibro(query)));
      reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header(
          'content-disposition',
          `attachment; filename="${bookFileName('cambiario', query)}"`,
        );
      return csv;
    },
  );

  /** Los resúmenes del período: el neto cambiario y el IGTF con su arqueo (Caja USD vs Banco Bs.). */
  app.get('/api/v1/billing/books/summary', { preHandler: read }, async (request) => {
    const query = parseOrThrow(bookQuerySchema, request.query);
    const rango = rangoDelLibro(query);
    const resumen: BooksSummary = {
      from: rango.from,
      to: rango.to,
      exchangeDiff: await exchangeDiffSummary(db, rango),
      igtf: await igtfSummary(db, rango),
    };
    return resumen;
  });

  /* ── Los mismos libros en PDF, con el membrete del consultorio ───────────── */

  /** El libro de ventas, para imprimir o entregar firmado. */
  app.get('/api/v1/billing/books/sales.pdf', { preHandler: read }, async (request, reply) => {
    const query = parseOrThrow(bookQuerySchema, request.query);
    return servirPdf(
      reply,
      'ventas',
      'el libro de ventas',
      SALES_BOOK_COLUMNS,
      await salesBookRows(db, rangoDelLibro(query)),
      query,
    );
  });

  /** El estado de ganancias y pérdidas por diferencial cambiario (ADR 0069). */
  app.get(
    '/api/v1/billing/books/exchange-diff.pdf',
    { preHandler: read },
    async (request, reply) => {
      const query = parseOrThrow(bookQuerySchema, request.query);
      const rango = rangoDelLibro(query);
      return servirPdf(
        reply,
        'cambiario',
        'el estado de diferencial cambiario',
        EXCHANGE_DIFF_BOOK_COLUMNS,
        await exchangeDiffBookRows(db, rango),
        query,
        { exchangeDiff: await exchangeDiffSummary(db, rango) },
      );
    },
  );

  /** El reporte de percepción del IGTF, con el arqueo separado por caja. */
  app.get('/api/v1/billing/books/igtf.pdf', { preHandler: read }, async (request, reply) => {
    const query = parseOrThrow(bookQuerySchema, request.query);
    const rango = rangoDelLibro(query);
    return servirPdf(
      reply,
      'igtf',
      'el reporte de IGTF',
      IGTF_BOOK_COLUMNS,
      await igtfBookRows(db, rango),
      query,
      { igtf: await igtfSummary(db, rango) },
    );
  });
};
