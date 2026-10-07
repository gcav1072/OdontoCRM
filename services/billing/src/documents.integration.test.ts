import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ROLE_PERMISSIONS } from '@odontocrm/contracts';
import { createDiskBlobStore, type BlobStore } from '@odontocrm/storage';
import { eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadBillingConfig } from './config.js';
import { createBillingDatabase } from './db/client.js';
import { invoices, invoiceSeries } from './db/schema.js';
import { createBillingServer } from './server.js';

/**
 * La **descarga de los documentos archivados** (ADR 0048): lo que se reimprime es el archivo que se
 * guardó al emitir, no una composición nueva.
 *
 * Lo que se comprueba: el PDF sale con su tipo y su nombre, **byte a byte** el que se archivó, y un
 * documento que no tiene archivo (un borrador, o un id que no existe) responde que no hay nada que
 * descargar en vez de devolver un PDF vacío. El archivo es la prueba de la verdad: se guarda una
 * cadena reconocible en el almacén y se exige que salga igual.
 *
 * **Es hermética**: serie propia (`S`) y limpieza de lo suyo.
 */
const billingUrl = process.env['TEST_BILLING_DATABASE_URL'];
const ready = billingUrl !== undefined;
const describeWithDatabase = ready ? describe : describe.skip;

const MARKER = `pruebas-documentos-${String(Date.now()).slice(-7)}`;
const SERIE = 'S';
const PDF = '%PDF-1.4 factura archivada de prueba';

const identidad = (): Record<string, string> => ({
  'x-user-id': globalThis.crypto.randomUUID(),
  'x-user-username': `secretario-${MARKER}`,
  'x-user-roles': 'secretario',
  'x-user-permissions': ROLE_PERMISSIONS['secretario'].join(','),
  'x-user-must-change-password': 'false',
  'x-session-id': globalThis.crypto.randomUUID(),
});

describeWithDatabase('los documentos archivados', () => {
  let handle: Awaited<ReturnType<typeof createBillingDatabase>>;
  let app: FastifyInstance;
  let blobStore: BlobStore;
  const dirAlmacen = mkdtempSync(join(tmpdir(), 'odontocrm-documentos-'));
  const idsFacturas: string[] = [];
  const numero = Number(String(Date.now()).slice(-6));
  let idEmitida = '';
  let idBorrador = '';

  const factura = async (
    status: 'emitida' | 'borrador',
    pdfPath: string | null,
  ): Promise<string> => {
    const emitida = status === 'emitida';
    const [fila] = await handle.db
      .insert(invoices)
      .values({
        status,
        series: SERIE,
        invoiceNumber: emitida ? numero : null,
        patientId: globalThis.crypto.randomUUID(),
        patientName: 'Elena Suárez',
        patientDocType: 'V',
        patientDocNumber: '55667788',
        exemptAmountCentsUsd: 5000,
        taxableAmountCentsUsd: 0,
        ivaAmountCentsUsd: 0,
        totalCentsUsd: 5000,
        totalVesCentimos: 182_710,
        balanceCentsUsd: 5000,
        exchangeRateMicros: emitida ? 36_542_000 : null,
        issuedAt: emitida ? new Date() : null,
        generatedAt: emitida ? new Date() : null,
        pdfPath,
        pdfSha256: pdfPath === null ? null : 'huella-de-prueba',
        createdByUserId: '00000000-0000-0000-0000-000000000000',
        createdByUsername: MARKER,
      })
      .returning({ id: invoices.id });
    const id = fila?.id ?? '';
    idsFacturas.push(id);
    return id;
  };

  beforeAll(async () => {
    if (!ready) throw new Error('falta TEST_BILLING_DATABASE_URL');
    const config = loadBillingConfig({ DATABASE_URL: billingUrl, LOG_LEVEL: 'silent' });
    handle = createBillingDatabase(config);
    blobStore = createDiskBlobStore({ rootDir: dirAlmacen });
    app = await createBillingServer({
      config,
      database: handle,
      services: {
        blobStore,
        pdf: {
          render: () => Promise.resolve(Buffer.from(PDF)),
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

    const archivo = await blobStore.save({
      key: `billing/${SERIE}/factura-de-prueba.pdf`,
      data: Buffer.from(PDF),
    });
    idEmitida = await factura('emitida', archivo.path);
    idBorrador = await factura('borrador', null);
  });

  afterAll(async () => {
    if (!ready) return;
    if (idsFacturas.length > 0) {
      await handle.db.delete(invoices).where(inArray(invoices.id, idsFacturas));
    }
    await handle.db.delete(invoiceSeries).where(eq(invoiceSeries.series, SERIE));
    await app.close();
    await handle.close();
    rmSync(dirAlmacen, { recursive: true, force: true });
  });

  it('la factura emitida sale con su tipo, su nombre y **el archivo tal cual**', async () => {
    const respuesta = await app.inject({
      method: 'GET',
      url: `/api/v1/billing/invoices/${idEmitida}/pdf`,
      headers: identidad(),
    });
    expect(respuesta.statusCode).toBe(200);
    expect(String(respuesta.headers['content-type'])).toContain('application/pdf');
    expect(respuesta.headers['content-disposition']).toBe(
      `inline; filename="factura-${SERIE}-${String(numero).padStart(6, '0')}.pdf"`,
    );
    // Byte a byte: lo archivado es lo que se imprime.
    expect(respuesta.rawPayload.toString('utf8')).toBe(PDF);
  });

  it('un borrador no tiene PDF que descargar (404, no un archivo vacío)', async () => {
    const respuesta = await app.inject({
      method: 'GET',
      url: `/api/v1/billing/invoices/${idBorrador}/pdf`,
      headers: identidad(),
    });
    expect(respuesta.statusCode).toBe(404);
  });

  it('un documento que no existe responde 404, y sin sesión 401', async () => {
    const fantasma = globalThis.crypto.randomUUID();
    const inexistente = await app.inject({
      method: 'GET',
      url: `/api/v1/billing/invoices/${fantasma}/pdf`,
      headers: identidad(),
    });
    expect(inexistente.statusCode).toBe(404);

    const sinSesion = await app.inject({
      method: 'GET',
      url: `/api/v1/billing/invoices/${idEmitida}/pdf`,
    });
    expect(sinSesion.statusCode).toBe(401);
  });

  it('el recibo y la nota de crédito tienen su puerta (y responden 404 si no hay nada)', async () => {
    const fantasma = globalThis.crypto.randomUUID();
    const recibo = await app.inject({
      method: 'GET',
      url: `/api/v1/billing/payments/${fantasma}/receipt`,
      headers: identidad(),
    });
    expect(recibo.statusCode).toBe(404);

    const nota = await app.inject({
      method: 'GET',
      url: `/api/v1/billing/credit-notes/${fantasma}/pdf`,
      headers: identidad(),
    });
    expect(nota.statusCode).toBe(404);
  });
});
