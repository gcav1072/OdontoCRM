import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ROLE_PERMISSIONS } from '@odontocrm/contracts';
import { outboxEvents } from '@odontocrm/db';
import { createDiskBlobStore } from '@odontocrm/storage';
import { eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadBillingConfig } from './config.js';
import { createBillingDatabase } from './db/client.js';
import { exchangeRates, fiscalForms, invoiceSeries } from './db/schema.js';
import { createBillingServer } from './server.js';

/**
 * Las rutas de facturación **por HTTP**, con `app.inject` contra PostgreSQL real.
 *
 * Existe por un fallo concreto: dos rutas tenían `await reply.code(201)` y `reply` es *thenable*, así
 * que esperarlo antes de devolverlo **interbloqueaba** la respuesta. Las 919 pruebas no lo vieron
 * porque las suites de facturación llaman a las **funciones**, no pasan por la capa HTTP; lo destapó
 * el humo. Aquí se comprueba lo que solo se ve en la puerta: los **201**, las guardas (401 sin sesión,
 * 403 sin permiso), la validación que corta antes de tocar la base y que el servicio sigue vivo.
 *
 * **Es hermética a propósito**: la base es compartida con las otras suites de facturación, así que
 * publica su tasa en una fecha que nadie consulta (`rateStatus` busca la última **anterior o igual** a
 * la fecha pedida) y su lote en una serie propia (`Q`). Si no, la suite de emisión se queda sin su
 * caso «no hay tasa» y la de lotes ve otro «lote activo»: ya pasó.
 */
const billingUrl = process.env['TEST_BILLING_DATABASE_URL'];
const ready = billingUrl !== undefined;
const describeWithDatabase = ready ? describe : describe.skip;

const MARKER = `pruebas-rutas-${String(Date.now()).slice(-7)}`;
/** Una fecha que ninguna otra suite consulta: lejana hacia adelante. */
const FECHA_TASA = '2027-01-15';
const SERIE = 'Q';
const BASE = Number(String(Date.now()).slice(-9)) * 1000;

/** Las cabeceras que en producción inyecta el gateway tras validar el JWT. */
const identidad = (
  role: 'admin' | 'secretario' | 'odontologo',
  permisos: readonly string[] = ROLE_PERMISSIONS[role],
): Record<string, string> => ({
  'x-user-id': globalThis.crypto.randomUUID(),
  'x-user-username': `${role}-${MARKER}`,
  'x-user-roles': role,
  'x-user-permissions': permisos.join(','),
  'x-user-must-change-password': 'false',
  'x-session-id': globalThis.crypto.randomUUID(),
});

describeWithDatabase('las rutas de facturación por HTTP', () => {
  let handle: Awaited<ReturnType<typeof createBillingDatabase>>;
  let app: FastifyInstance;
  const dirAlmacen = mkdtempSync(join(tmpdir(), 'odontocrm-rutas-'));
  const idsTasas: string[] = [];
  const idsLotes: string[] = [];

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
          render: () => Promise.resolve(Buffer.from('%PDF-1.4 prueba de rutas')),
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
  });

  afterAll(async () => {
    if (!ready) return;
    // El outbox de TODO lo que publican estas rutas, por el actor.
    await handle.db
      .delete(outboxEvents)
      .where(sql`${outboxEvents.envelope}->'payload'->>'actorUsername' like ${`%-${MARKER}`}`);
    if (idsTasas.length > 0) {
      await handle.db.delete(exchangeRates).where(inArray(exchangeRates.id, idsTasas));
    }
    if (idsLotes.length > 0) {
      await handle.db.delete(fiscalForms).where(inArray(fiscalForms.id, idsLotes));
    }
    await handle.db.delete(invoiceSeries).where(eq(invoiceSeries.series, SERIE));
    await app.close();
    await handle.close();
    rmSync(dirAlmacen, { recursive: true, force: true });
  });

  it('la tasa se publica con 201 (y la respuesta no se queda colgada)', async () => {
    const respuesta = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/rates',
      headers: identidad('admin'),
      payload: { rateDate: FECHA_TASA, rate: '36,5420', note: null },
    });
    expect(respuesta.statusCode).toBe(201);
    const cuerpo = respuesta.json<{ id: string; rateMicros: number; rateDate: string }>();
    expect(cuerpo.rateMicros).toBe(36_542_000);
    expect(cuerpo.rateDate).toBe(FECHA_TASA);
    idsTasas.push(cuerpo.id);
  });

  it('el lote de formas se da de alta con 201', async () => {
    const respuesta = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/forms',
      headers: identidad('secretario'),
      payload: {
        series: SERIE,
        controlFrom: String(BASE),
        controlTo: String(BASE + 4),
        printerName: `Imprenta ${MARKER}`,
        printerRif: 'J-11223344-5',
        authorizationRef: 'Providencia 0071/2026',
        authorizationDate: '2026-09-30',
        printDate: '2026-10-01',
      },
    });
    expect(respuesta.statusCode).toBe(201);
    const lote = respuesta.json<{ id: string; controlFrom: string; nextControl: string }>();
    expect(lote.controlFrom).toBe(String(BASE));
    expect(lote.nextControl).toBe(String(BASE));
    idsLotes.push(lote.id);
  });

  it('sin sesión no se pasa (401) y sin permiso tampoco (403)', async () => {
    const sinSesion = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/rates',
      payload: { rateDate: FECHA_TASA, rate: '36,5420', note: null },
    });
    expect(sinSesion.statusCode).toBe(401);

    // El odontólogo solo tiene `billing:read`: no publica tasas.
    const odontologo = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/rates',
      headers: identidad('odontologo'),
      payload: { rateDate: FECHA_TASA, rate: '36,5420', note: null },
    });
    expect(odontologo.statusCode).toBe(403);

    // Y tampoco cobra: `billing:collect` no es suyo.
    const cobroSinPermiso = await app.inject({
      method: 'POST',
      url: `/api/v1/billing/invoices/${globalThis.crypto.randomUUID()}/payments`,
      headers: identidad('odontologo'),
      payload: { method: 'cash_usd', tenderedAmount: 100, confirmRate: false },
    });
    expect(cobroSinPermiso.statusCode).toBe(403);
  });

  it('la validación corta antes de tocar la base (400)', async () => {
    const tasaMala = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/rates',
      headers: identidad('admin'),
      // Sin fecha y con una tasa que no es un número: el contrato lo rechaza.
      payload: { rate: 'treinta y seis', note: null },
    });
    expect(tasaMala.statusCode).toBe(400);

    const cobroMalo = await app.inject({
      method: 'POST',
      url: `/api/v1/billing/invoices/${globalThis.crypto.randomUUID()}/payments`,
      headers: identidad('secretario'),
      // Un medio de pago que no existe.
      payload: { method: 'bitcoin', tenderedAmount: 100, confirmRate: false },
    });
    expect(cobroMalo.statusCode).toBe(400);
  });

  it('la secretaría lee los borradores, el historial, la tasa del día y el catálogo', async () => {
    const borradores = await app.inject({
      method: 'GET',
      url: '/api/v1/billing/drafts',
      headers: identidad('secretario'),
    });
    expect(borradores.statusCode).toBe(200);
    expect(Array.isArray(borradores.json<{ items: unknown[] }>().items)).toBe(true);

    // El historial: paginado y con filtros, con la forma del contrato.
    const historialFacturas = await app.inject({
      method: 'GET',
      url: '/api/v1/billing/invoices?page=1&pageSize=5&status=anulada',
      headers: identidad('secretario'),
    });
    expect(historialFacturas.statusCode).toBe(200);
    const pagina = historialFacturas.json<{
      items: unknown[];
      total: number;
      pageSize: number;
      totalPages: number;
    }>();
    expect(Array.isArray(pagina.items)).toBe(true);
    expect(pagina.pageSize).toBe(5);
    expect(pagina.totalPages).toBeGreaterThanOrEqual(1);

    // Un filtro que no existe en el contrato corta con 400 (no llega a la base).
    const filtroMalo = await app.inject({
      method: 'GET',
      url: '/api/v1/billing/invoices?status=inventado',
      headers: identidad('secretario'),
    });
    expect(filtroMalo.statusCode).toBe(400);

    const tasaDeHoy = await app.inject({
      method: 'GET',
      url: '/api/v1/billing/rates/today',
      headers: identidad('secretario'),
    });
    expect(tasaDeHoy.statusCode).toBe(200);
    // Puede haber tasa de hoy o no (depende de lo que hayan dejado otras suites): lo que se comprueba
    // es que la ruta responde con la forma del contrato.
    expect(tasaDeHoy.json<Record<string, unknown>>()).toHaveProperty('needsConfirmation');

    const catalogo = await app.inject({
      method: 'GET',
      url: '/api/v1/billing/catalog',
      headers: identidad('secretario'),
    });
    expect(catalogo.statusCode).toBe(200);
    expect(Array.isArray(catalogo.json<{ items: unknown[] }>().items)).toBe(true);

    const historial = await app.inject({
      method: 'GET',
      url: '/api/v1/billing/rates',
      headers: identidad('secretario'),
    });
    expect(historial.statusCode).toBe(200);
  });

  it('reimprimir exige sesión y una factura que exista (y el odontólogo puede leer)', async () => {
    const sinSesion = await app.inject({
      method: 'POST',
      url: `/api/v1/billing/invoices/${globalThis.crypto.randomUUID()}/printed`,
    });
    expect(sinSesion.statusCode).toBe(401);

    // Imprimir es leer: el odontólogo (`billing:read`) puede reimprimir el papel.
    const inexistente = await app.inject({
      method: 'POST',
      url: `/api/v1/billing/invoices/${globalThis.crypto.randomUUID()}/printed`,
      headers: identidad('odontologo'),
    });
    expect(inexistente.statusCode).toBe(404);

    const idInvalido = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/invoices/no-es-un-uuid/printed',
      headers: identidad('secretario'),
    });
    expect(idInvalido.statusCode).toBe(400);

    const reciboInexistente = await app.inject({
      method: 'POST',
      url: `/api/v1/billing/payments/${globalThis.crypto.randomUUID()}/printed`,
      headers: identidad('secretario'),
    });
    expect(reciboInexistente.statusCode).toBe(404);
  });

  it('una ruta que no existe responde 404 (y el servicio sigue vivo)', async () => {
    const respuesta = await app.inject({
      method: 'GET',
      url: '/api/v1/billing/no-existe',
      headers: identidad('admin'),
    });
    expect(respuesta.statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
  });
});
