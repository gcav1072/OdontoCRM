import { formatInvoiceNumber, formatReceiptNumber } from '@odontocrm/contracts';
import { createDiskBlobStore, type BlobStore } from '@odontocrm/storage';
import { eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadBillingConfig } from './config.js';
import { createBillingDatabase } from './db/client.js';
import { invoices, invoiceSeries, payments } from './db/schema.js';
import { createBillingServer } from './server.js';

/**
 * Las **rutas internas de facturación** (Fase D): el envío de documentos por chat pide
 * por aquí los metadatos y los PDFs archivados —factura y recibo—, sin pasar por el
 * gateway. Este servicio es el dueño del almacén y de su base (ADR 0004/0048).
 *
 * Lo que se comprueba es lo que protege al paciente y al documento:
 *  1. sin `x-internal-token` (o con uno equivocado) no hay respuesta: 403;
 *  2. los metadatos traen el estado, el número formateado, el nombre del archivo y el
 *     paciente (en el cobro, resuelto de la factura padre);
 *  3. solo se comparten documentos **vigentes**: el borrador, la factura anulada, el
 *     cobro anulado y el cobro sin recibo archivado responden 409;
 *  4. lo que no existe responde 404.
 *
 * **Es hermética**: serie propia (`D`), facturas y cobros sintéticos y un almacén
 * temporal; al terminar se borra todo lo suyo. La suite se salta sin
 * `TEST_BILLING_DATABASE_URL` (lo pone `tools/test-integration.mjs`).
 */
const billingUrl = process.env['TEST_BILLING_DATABASE_URL'];
const ready = billingUrl !== undefined;
const describeWithDatabase = ready ? describe : describe.skip;

const MARKER = `pruebas-internas-billing-${String(Date.now()).slice(-7)}`;
/** Serie propia: no choca con la real (`A`) ni con la de otras suites. */
const SERIE = 'D';
/** Secreto del servidor de pruebas: la cabecera tiene que coincidir con este. */
const INTERNAL = 'secreto-interno-de-prueba-1234';
const PDF_FACTURA = Buffer.from('%PDF-1.4 factura interna de prueba');
const PDF_RECIBO = Buffer.from('%PDF-1.4 recibo interno de prueba');
const UUID_CERO = '00000000-0000-0000-0000-000000000000';

describeWithDatabase('rutas internas de facturación', () => {
  let handle: Awaited<ReturnType<typeof createBillingDatabase>>;
  let app: FastifyInstance;
  let blobStore: BlobStore;
  const dirAlmacen = mkdtempSync(join(tmpdir(), 'odontocrm-internas-billing-'));

  const patientId = globalThis.crypto.randomUUID();
  const fechaEmision = new Date('2026-03-10T14:30:00.000Z');
  const fechaPago = new Date('2026-03-11T16:45:00.000Z');
  const fechaAnulacion = new Date('2026-03-12T09:00:00.000Z');

  const idsFacturas: string[] = [];
  const idsPagos: string[] = [];

  let idEmitida = '';
  let idBorrador = '';
  let idAnulada = '';
  let numeroEmitida = 0;

  let idPagoVigente = '';
  let idPagoAnulado = '';
  let idPagoSinPdf = '';
  let numeroRecibo = 0;
  let numeroReciboAnulado = 0;

  /** El siguiente número de factura de la serie de pruebas. */
  const siguienteNumeroFactura = async (): Promise<number> => {
    const [fila] = await handle.db
      .select({ maximo: sql<number>`coalesce(max(${invoices.invoiceNumber}), 0)::int` })
      .from(invoices)
      .where(eq(invoices.series, SERIE));
    return Number(fila?.maximo ?? 0) + 1;
  };

  /** El siguiente número de recibo: la secuencia no repite, aunque la base se comparta. */
  const siguienteNumeroRecibo = async (): Promise<number> => {
    const resultado = await handle.db.execute(sql`select nextval('receipt_number_seq') as numero`);
    const fila = (resultado.rows[0] ?? {}) as { numero?: string | number };
    const numero = Number(fila.numero);
    if (!Number.isSafeInteger(numero) || numero <= 0) {
      throw new Error('la secuencia del número de recibo no devolvió un número');
    }
    return numero;
  };

  const insertarFactura = async (valores: typeof invoices.$inferInsert): Promise<string> => {
    const [fila] = await handle.db.insert(invoices).values(valores).returning({ id: invoices.id });
    const id = fila?.id ?? '';
    idsFacturas.push(id);
    return id;
  };

  const insertarPago = async (valores: typeof payments.$inferInsert): Promise<string> => {
    const [fila] = await handle.db.insert(payments).values(valores).returning({ id: payments.id });
    const id = fila?.id ?? '';
    idsPagos.push(id);
    return id;
  };

  /** Petición a una ruta interna con el token bueno. */
  const interna = (url: string) =>
    app.inject({ method: 'GET', url, headers: { 'x-internal-token': INTERNAL } });

  beforeAll(async () => {
    if (!ready) throw new Error('falta TEST_BILLING_DATABASE_URL');

    const config = loadBillingConfig({
      DATABASE_URL: billingUrl,
      LOG_LEVEL: 'silent',
      INTERNAL_SERVICE_SECRET: INTERNAL,
    });
    handle = createBillingDatabase(config);
    blobStore = createDiskBlobStore({ rootDir: dirAlmacen });

    app = await createBillingServer({
      config,
      database: handle,
      services: {
        blobStore,
        pdf: {
          render: () => Promise.resolve(Buffer.from('%PDF-1.4')),
          close: () => Promise.resolve(),
          isRunning: () => false,
        },
        kickOutbox: () => undefined,
      },
    });
    await app.ready();

    await handle.db
      .insert(invoiceSeries)
      .values({ series: SERIE, numberingMode: 'formas_libres' })
      .onConflictDoNothing();

    const archivoFactura = await blobStore.save({
      key: `billing/pruebas/${patientId}/factura.pdf`,
      data: PDF_FACTURA,
    });
    const archivoRecibo = await blobStore.save({
      key: `billing/pruebas/${patientId}/recibo.pdf`,
      data: PDF_RECIBO,
    });

    const facturaEmitida: Omit<typeof invoices.$inferInsert, 'invoiceNumber' | 'status'> = {
      series: SERIE,
      patientId,
      patientName: 'Elena Suárez',
      patientDocType: 'V',
      patientDocNumber: '55667788',
      exemptAmountCentsUsd: 5000,
      totalCentsUsd: 5000,
      balanceCentsUsd: 5000,
      exchangeRateMicros: 36_542_000,
      issuedAt: fechaEmision,
      generatedAt: fechaEmision,
      createdByUserId: UUID_CERO,
      createdByUsername: MARKER,
    };

    // 1. La factura emitida y vigente, con su PDF archivado.
    numeroEmitida = await siguienteNumeroFactura();
    idEmitida = await insertarFactura({
      ...facturaEmitida,
      status: 'emitida',
      invoiceNumber: numeroEmitida,
      pdfPath: archivoFactura.path,
      pdfSha256: archivoFactura.sha256,
    });

    // 2. Un borrador: sin número, sin PDF y sin fecha de emisión.
    idBorrador = await insertarFactura({
      series: SERIE,
      status: 'borrador',
      patientId,
      patientName: 'Elena Suárez',
      patientDocType: 'V',
      patientDocNumber: '55667788',
      exemptAmountCentsUsd: 5000,
      totalCentsUsd: 5000,
      balanceCentsUsd: 5000,
      createdByUserId: UUID_CERO,
      createdByUsername: MARKER,
    });

    // 3. Una factura anulada (borrador descartado): nunca consumió número fiscal.
    idAnulada = await insertarFactura({
      series: SERIE,
      status: 'anulada',
      patientId,
      patientName: 'Elena Suárez',
      patientDocType: 'V',
      patientDocNumber: '55667788',
      exemptAmountCentsUsd: 5000,
      totalCentsUsd: 5000,
      balanceCentsUsd: 5000,
      voidedAt: fechaAnulacion,
      voidReason: 'Descartada en pruebas',
      createdByUserId: UUID_CERO,
      createdByUsername: MARKER,
    });

    const pagoBase: Omit<typeof payments.$inferInsert, 'receiptNumber'> = {
      invoiceId: idEmitida,
      method: 'cash_ves',
      tenderedAmount: 182_710,
      tenderedCurrency: 'VES',
      amountCentsUsd: 5000,
      exchangeRateMicros: 36_542_000,
      imputationPolicy: 'tasa_del_pago',
      effectiveDate: '2026-03-11',
      receivedByUserId: UUID_CERO,
      receivedByUsername: MARKER,
    };

    // 4. Un cobro vigente, con su recibo archivado.
    numeroRecibo = await siguienteNumeroRecibo();
    idPagoVigente = await insertarPago({
      ...pagoBase,
      receiptNumber: numeroRecibo,
      createdAt: fechaPago,
      pdfPath: archivoRecibo.path,
      pdfSha256: archivoRecibo.sha256,
    });

    // 5. Un cobro anulado: conserva su recibo y aun así no se comparte.
    numeroReciboAnulado = await siguienteNumeroRecibo();
    idPagoAnulado = await insertarPago({
      ...pagoBase,
      receiptNumber: numeroReciboAnulado,
      voidedAt: fechaAnulacion,
      voidReason: 'Cobro anulado en pruebas',
      pdfPath: archivoRecibo.path,
      pdfSha256: archivoRecibo.sha256,
    });

    // 6. Un cobro sin recibo archivado (no debería existir, pero la ruta lo cubre).
    idPagoSinPdf = await insertarPago({
      ...pagoBase,
      receiptNumber: await siguienteNumeroRecibo(),
    });
  });

  afterAll(async () => {
    if (!ready) return;
    if (idsPagos.length > 0) {
      await handle.db.delete(payments).where(inArray(payments.id, idsPagos));
    }
    if (idsFacturas.length > 0) {
      await handle.db.delete(invoices).where(inArray(invoices.id, idsFacturas));
    }
    await handle.db.delete(invoiceSeries).where(eq(invoiceSeries.series, SERIE));
    await app.close();
    await handle.close();
    rmSync(dirAlmacen, { recursive: true, force: true });
  });

  it('sin el token compartido, las rutas internas no responden (403)', async () => {
    const rutas = [
      `/internal/v1/billing/invoices/${idEmitida}/meta`,
      `/internal/v1/billing/invoices/${idEmitida}/pdf`,
      `/internal/v1/billing/payments/${idPagoVigente}/meta`,
      `/internal/v1/billing/payments/${idPagoVigente}/receipt`,
    ];

    for (const url of rutas) {
      const sinToken = await app.inject({ method: 'GET', url });
      expect(sinToken.statusCode).toBe(403);

      const tokenAjeno = await app.inject({
        method: 'GET',
        url,
        headers: { 'x-internal-token': 'secreto-equivocado-1234567890' },
      });
      expect(tokenAjeno.statusCode).toBe(403);
    }
  });

  it('los metadatos de la factura emitida traen número, paciente y archivo', async () => {
    expect(idEmitida).not.toBe('');
    const respuesta = await interna(`/internal/v1/billing/invoices/${idEmitida}/meta`);

    const etiqueta = formatInvoiceNumber(SERIE, numeroEmitida);
    expect(respuesta.statusCode).toBe(200);
    expect(respuesta.json()).toEqual({
      id: idEmitida,
      patientId,
      patientName: 'Elena Suárez',
      status: 'emitida',
      number: etiqueta,
      filename: `factura-${etiqueta}.pdf`,
      issuedAt: fechaEmision.toISOString(),
    });
  });

  it('el borrador y la factura anulada informan su estado, sin número', async () => {
    const borrador = await interna(`/internal/v1/billing/invoices/${idBorrador}/meta`);
    expect(borrador.statusCode).toBe(200);
    expect(borrador.json()).toEqual({
      id: idBorrador,
      patientId,
      patientName: 'Elena Suárez',
      status: 'borrador',
      number: null,
      // El mismo nombre que devolvería la descarga de un borrador (que no existe).
      filename: 'factura-borrador.pdf',
      issuedAt: null,
    });

    const anulada = await interna(`/internal/v1/billing/invoices/${idAnulada}/meta`);
    expect(anulada.statusCode).toBe(200);
    expect(anulada.json()).toMatchObject({ id: idAnulada, status: 'anulada', number: null });
  });

  it('el PDF de la factura emitida sale como adjunto, byte a byte', async () => {
    const respuesta = await interna(`/internal/v1/billing/invoices/${idEmitida}/pdf`);

    expect(respuesta.statusCode).toBe(200);
    expect(String(respuesta.headers['content-type'])).toContain('application/pdf');
    expect(respuesta.headers['content-disposition']).toBe(
      `attachment; filename="factura-${formatInvoiceNumber(SERIE, numeroEmitida)}.pdf"`,
    );
    // Lo archivado es lo que se manda: no se recompone el documento.
    expect(respuesta.rawPayload.equals(PDF_FACTURA)).toBe(true);
  });

  it('un borrador o una factura anulada no se comparten (409)', async () => {
    const borrador = await interna(`/internal/v1/billing/invoices/${idBorrador}/pdf`);
    expect(borrador.statusCode).toBe(409);
    expect(borrador.json()).toMatchObject({ status: 409, invoiceStatus: 'borrador' });

    const anulada = await interna(`/internal/v1/billing/invoices/${idAnulada}/pdf`);
    expect(anulada.statusCode).toBe(409);
    expect(anulada.json()).toMatchObject({ status: 409, invoiceStatus: 'anulada' });
  });

  it('los metadatos de un cobro resuelven el paciente de la factura padre', async () => {
    const respuesta = await interna(`/internal/v1/billing/payments/${idPagoVigente}/meta`);
    const recibo = formatReceiptNumber(numeroRecibo);

    expect(respuesta.statusCode).toBe(200);
    expect(respuesta.json()).toEqual({
      id: idPagoVigente,
      invoiceId: idEmitida,
      patientId,
      receiptNumber: recibo,
      filename: `recibo-${recibo}.pdf`,
      paidAt: fechaPago.toISOString(),
    });
  });

  it('el recibo de un cobro vigente sale como adjunto, byte a byte', async () => {
    const respuesta = await interna(`/internal/v1/billing/payments/${idPagoVigente}/receipt`);

    expect(respuesta.statusCode).toBe(200);
    expect(String(respuesta.headers['content-type'])).toContain('application/pdf');
    expect(respuesta.headers['content-disposition']).toBe(
      `attachment; filename="recibo-${formatReceiptNumber(numeroRecibo)}.pdf"`,
    );
    expect(respuesta.rawPayload.equals(PDF_RECIBO)).toBe(true);
  });

  it('un cobro anulado o sin recibo archivado no se comparte (409)', async () => {
    const anulado = await interna(`/internal/v1/billing/payments/${idPagoAnulado}/receipt`);
    expect(anulado.statusCode).toBe(409);
    expect(anulado.json()).toMatchObject({ status: 409, paymentId: idPagoAnulado });

    const sinPdf = await interna(`/internal/v1/billing/payments/${idPagoSinPdf}/receipt`);
    expect(sinPdf.statusCode).toBe(409);
  });

  it('un documento que no existe responde 404 (y un id inválido, 400)', async () => {
    const fantasma = globalThis.crypto.randomUUID();
    for (const ruta of ['meta', 'pdf']) {
      const factura = await interna(`/internal/v1/billing/invoices/${fantasma}/${ruta}`);
      expect(factura.statusCode).toBe(404);
    }
    for (const ruta of ['meta', 'receipt']) {
      const pago = await interna(`/internal/v1/billing/payments/${fantasma}/${ruta}`);
      expect(pago.statusCode).toBe(404);
    }

    const idInvalido = await interna('/internal/v1/billing/invoices/no-es-uuid/meta');
    expect(idInvalido.statusCode).toBe(400);
  });
});
