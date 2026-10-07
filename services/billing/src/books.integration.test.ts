import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ROLE_PERMISSIONS } from '@odontocrm/contracts';
import { createDiskBlobStore } from '@odontocrm/storage';
import { eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadBillingConfig } from './config.js';
import { createBillingDatabase } from './db/client.js';
import { invoices, invoiceSeries } from './db/schema.js';
import { createBillingServer } from './server.js';

/**
 * El **libro de ventas** por HTTP, contra PostgreSQL real: el archivo que se le entrega al contador.
 *
 * Lo que se comprueba de verdad es el **rango**: una factura del mes en curso sale en el libro del mes
 * y una de 2020 **no**, y pidiendo el rango de 2020 pasa lo contrario. El día se decide en Caracas, así
 * que el corte no es el del reloj del servidor.
 *
 * **Es hermética**: usa su propia serie (`R`) y unas fechas que ninguna otra suite toca, y limpia lo
 * que crea. Las demás suites de facturación comparten base, así que una suite que no sea hermética
 * tumba a las otras (ya pasó con la de rutas).
 */
const billingUrl = process.env['TEST_BILLING_DATABASE_URL'];
const ready = billingUrl !== undefined;
const describeWithDatabase = ready ? describe : describe.skip;

const MARKER = `pruebas-libro-${String(Date.now()).slice(-7)}`;
const SERIE = 'R';
const TASA = 36_542_000;

const identidad = (): Record<string, string> => ({
  'x-user-id': globalThis.crypto.randomUUID(),
  'x-user-username': `secretario-${MARKER}`,
  'x-user-roles': 'secretario',
  'x-user-permissions': ROLE_PERMISSIONS['secretario'].join(','),
  'x-user-must-change-password': 'false',
  'x-session-id': globalThis.crypto.randomUUID(),
});

describeWithDatabase('el libro de ventas', () => {
  let handle: Awaited<ReturnType<typeof createBillingDatabase>>;
  let app: FastifyInstance;
  const dirAlmacen = mkdtempSync(join(tmpdir(), 'odontocrm-libro-'));
  const idsFacturas: string[] = [];
  /** Del mes en curso y de 2020: el rango tiene que separarlos. */
  const deEsteMes = 810_001;
  const de2020 = 810_002;

  const factura = async (numero: number, emittedAt: Date): Promise<void> => {
    const [fila] = await handle.db
      .insert(invoices)
      .values({
        status: 'emitida',
        series: SERIE,
        invoiceNumber: numero,
        controlNumber: `C${String(numero)}`,
        patientId: globalThis.crypto.randomUUID(),
        patientName: 'Rosa Delgado',
        patientDocType: 'V',
        patientDocNumber: '99887766',
        exemptAmountCentsUsd: 5000,
        taxableAmountCentsUsd: 1200,
        ivaAmountCentsUsd: 192,
        totalCentsUsd: 6392,
        totalVesCentimos: 233_560,
        balanceCentsUsd: 6392,
        exchangeRateMicros: TASA,
        issuedAt: emittedAt,
        generatedAt: emittedAt,
        pdfPath: `${SERIE}/prueba/factura.pdf`,
        pdfSha256: 'huella-de-prueba',
        createdByUserId: '00000000-0000-0000-0000-000000000000',
        createdByUsername: MARKER,
      })
      .returning({ id: invoices.id });
    if (fila !== undefined) idsFacturas.push(fila.id);
  };

  beforeAll(async () => {
    if (!ready) throw new Error('falta TEST_BILLING_DATABASE_URL');
    const config = loadBillingConfig({ DATABASE_URL: billingUrl, LOG_LEVEL: 'silent' });
    handle = createBillingDatabase(config);
    app = await createBillingServer({
      config,
      database: handle,
      services: {
        blobStore: createDiskBlobStore({ rootDir: dirAlmacen }),
        pdf: {
          render: () => Promise.resolve(Buffer.from('%PDF-1.4 prueba del libro')),
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
    await factura(deEsteMes, new Date());
    await factura(de2020, new Date('2020-06-15T15:00:00.000Z'));
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

  const libro = async (
    query = '',
  ): Promise<{ status: number; tipo: string; cuerpo: string; disposicion: string }> => {
    const respuesta = await app.inject({
      method: 'GET',
      url: `/api/v1/billing/books/sales.csv${query}`,
      headers: identidad(),
    });
    return {
      status: respuesta.statusCode,
      tipo: String(respuesta.headers['content-type'] ?? ''),
      cuerpo: respuesta.body.replace('\uFEFF', ''),
      disposicion: String(respuesta.headers['content-disposition'] ?? ''),
    };
  };

  it('el mes en curso sale como descarga, con cabecera y el desglose', async () => {
    const respuesta = await libro();
    expect(respuesta.status).toBe(200);
    expect(respuesta.tipo).toContain('text/csv');
    expect(respuesta.disposicion).toBe('attachment; filename="libro-de-ventas-inicio_fin.csv"');

    const [cabecera = '', ...filas] = respuesta.cuerpo.trim().split('\r\n');
    expect(cabecera).toContain('Fecha;Documento;N.º de control;Cliente');
    expect(cabecera).toContain('Base 16 % US$;IVA US$;Total US$;Tasa Bs./US$;Total Bs.;Estado');

    const mia = filas.find((fila) => fila.includes(`R-${String(deEsteMes)}`));
    expect(mia).toBeDefined();
    // Desglose, tasa congelada y totales en las dos monedas.
    expect(mia).toContain('50;12;1,92;63,92;36,542;2335,6;emitida');
    expect(mia).toContain('Rosa Delgado');
  });

  it('una factura de 2020 no aparece en el libro de este mes', async () => {
    const respuesta = await libro();
    expect(respuesta.cuerpo).not.toContain(`R-${String(de2020)}`);
  });

  it('y pidiendo el rango de 2020 aparece ella y no la de este mes', async () => {
    const respuesta = await libro('?from=2020-01-01&to=2020-12-31');
    expect(respuesta.status).toBe(200);
    expect(respuesta.disposicion).toBe(
      'attachment; filename="libro-de-ventas-2020-01-01_2020-12-31.csv"',
    );
    expect(respuesta.cuerpo).toContain(`R-${String(de2020)}`);
    expect(respuesta.cuerpo).not.toContain(`R-${String(deEsteMes)}`);
  });

  it('un rango con formato inválido se rechaza antes de consultar (400)', async () => {
    const respuesta = await libro('?from=2020&to=ayer');
    expect(respuesta.status).toBe(400);
  });

  it('el libro de IGTF responde y trae su cabecera', async () => {
    const respuesta = await app.inject({
      method: 'GET',
      url: '/api/v1/billing/books/igtf.csv',
      headers: identidad(),
    });
    expect(respuesta.statusCode).toBe(200);
    expect(String(respuesta.headers['content-type'])).toContain('text/csv');
    expect(respuesta.body.replace('\uFEFF', '')).toContain(
      'Fecha;Recibo;Factura;Medio de pago;Monto;Alícuota %;Percibido por;IGTF US$;IGTF Bs.',
    );
  });

  it('sin sesión no se descarga el libro (401)', async () => {
    const respuesta = await app.inject({ method: 'GET', url: '/api/v1/billing/books/sales.csv' });
    expect(respuesta.statusCode).toBe(401);
  });
});
