import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { outboxEvents } from '@odontocrm/db';
import { createDiskBlobStore } from '@odontocrm/storage';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { rateDateInCaracas, vesCentimosFromUsd } from '@odontocrm/contracts';

import { collectPayment, listInvoicePayments, voidPayment } from './billing/payment-service.js';
import { loadBillingConfig } from './config.js';
import { createBillingDatabase } from './db/client.js';
import {
  billingSettings,
  exchangeRates,
  invoiceItems,
  invoices,
  invoiceSeries,
  payments,
} from './db/schema.js';
import { setRate } from './rates/rate-service.js';

/**
 * Pruebas de integración de los cobros (B6, B8) contra PostgreSQL real:
 *  1. un cobro en Bs. se imputa con la **tasa del día** y deja el saldo correcto;
 *  2. un cobro parcial en divisas deja la factura **abonada**;
 *  3. con la bandera de SPE **encendida** el 3 % de IGTF vuelve a calcularse (el camino no está muerto)
 *     y con ella apagada —la configuración real— no se percibe nada;
 *  4. no se cobra más que el saldo;
 *  5. anular un cobro **devuelve el saldo y retrocede el estado**, con motivo.
 *
 * La factura emitida se inserta directamente: la **emisión** ya tiene sus propias pruebas, y lo que se
 * prueba aquí es el dinero. El recibo se compone con un doble del renderizador (Chromium ya está
 * probado por los récipes y los reportes).
 */
const billingUrl = process.env['TEST_BILLING_DATABASE_URL'];
const ready = billingUrl !== undefined;
const describeWithDatabase = ready ? describe : describe.skip;

const MARKER = `prueba-cobros-${String(Date.now()).slice(-7)}`;
const SERIE = 'P';
const TASA = 36_542_000;
const HOY = rateDateInCaracas();
const TOTAL = 6392;

const actor = {
  actorId: null,
  actorUsername: MARKER,
  ip: '127.0.0.1',
  userAgent: 'vitest',
  requestId: `req-${MARKER}`,
};

/**
 * Cerrojo compartido con la suite de **emisión**.
 *
 * Las dos comparten la base temporal y **se contradicen** en una sola cosa: la tasa de hoy. La de
 * emisión exige que no haya ninguna publicada antes de emitir; esta publica la suya para cobrar.
 * Vitest arranca los archivos en paralelo, así que en vez de dejarlo a la suerte del planificador se
 * serializan con un cerrojo de asesoramiento, que se suelta al cerrar la conexión.
 */
const tomarCerrojoDeLaTasaDeHoy = async (url: string | undefined): Promise<Client> => {
  const cerrojo = new Client({ connectionString: url });
  await cerrojo.connect();
  await cerrojo.query(`select pg_advisory_lock(hashtext('billing: la tasa de hoy'))`);
  return cerrojo;
};

const paciente = {
  patientId: globalThis.crypto.randomUUID(),
  patientName: 'Carmen Rojas',
  patientDocType: 'V',
  patientDocNumber: '11223344',
};

describeWithDatabase('cobrar', () => {
  let handle: Awaited<ReturnType<typeof createBillingDatabase>>;
  const dirAlmacen = mkdtempSync(join(tmpdir(), 'odontocrm-cobros-'));
  const blobStore = createDiskBlobStore({ rootDir: dirAlmacen });
  const pdf = { render: async (): Promise<Buffer> => Buffer.from('%PDF-1.4 recibo de prueba') };
  const deps = () => ({ db: handle.db, blobStore, pdf });
  const idsFacturas: string[] = [];
  const idsTasas: string[] = [];
  const idsPagos: string[] = [];
  let cerrojo: Client | undefined;

  /** Una factura emitida, lista para cobrar. */
  const facturaEmitida = async (numero: number): Promise<string> => {
    const [fila] = await handle.db
      .insert(invoices)
      .values({
        status: 'emitida',
        series: SERIE,
        invoiceNumber: numero,
        controlNumber: `C${String(numero)}`,
        ...paciente,
        exemptAmountCentsUsd: 5000,
        taxableAmountCentsUsd: 1200,
        ivaAmountCentsUsd: 192,
        totalCentsUsd: TOTAL,
        balanceCentsUsd: TOTAL,
        exchangeRateMicros: TASA,
        issuedAt: new Date(),
        generatedAt: new Date(),
        pdfPath: `${SERIE}/prueba/factura.pdf`,
        pdfSha256: 'huella-de-prueba',
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
    handle = createBillingDatabase(
      loadBillingConfig({ DATABASE_URL: billingUrl, LOG_LEVEL: 'silent', STORAGE_DIR: dirAlmacen }),
    );
    // Antes de tocar la tasa: que la suite de emisión no esté usándola.
    cerrojo = await tomarCerrojoDeLaTasaDeHoy(billingUrl);
    await handle.db
      .insert(invoiceSeries)
      .values({ series: SERIE, numberingMode: 'formas_libres' })
      .onConflictDoNothing();
  });

  afterAll(async () => {
    if (!ready) return;
    // El outbox de TODO lo que deja esta suite, por el actor.
    await handle.db
      .delete(outboxEvents)
      .where(sql`${outboxEvents.envelope}->'payload'->>'actorUsername' = ${MARKER}`);
    if (idsFacturas.length > 0) {
      await handle.db.delete(payments).where(inArray(payments.invoiceId, idsFacturas));
      await handle.db.delete(invoiceItems).where(inArray(invoiceItems.invoiceId, idsFacturas));
      await handle.db.delete(invoices).where(inArray(invoices.id, idsFacturas));
    }
    if (idsTasas.length > 0) {
      await handle.db.delete(exchangeRates).where(inArray(exchangeRates.id, idsTasas));
    }
    // La configuración de la clínica no es SPE: se deja como estaba.
    await handle.db
      .update(billingSettings)
      .set({ isSpecialTaxpayer: false })
      .where(eq(billingSettings.id, 1));
    await handle.db.delete(invoiceSeries).where(eq(invoiceSeries.series, SERIE));
    await handle.close();
    // Se suelta el último: la otra suite de dinero puede entrar.
    await cerrojo?.end().catch(() => undefined);
    rmSync(dirAlmacen, { recursive: true, force: true });
  });

  it('un cobro en Bs. se imputa con la tasa del día y deja el saldo correcto', async () => {
    const tasa = await setRate(handle.db, { rateDate: HOY, rate: '36,5420', note: null }, actor);
    idsTasas.push(tasa.id);
    const invoiceId = await facturaEmitida(900_001);

    // El paciente entrega los bolívares **de hoy** por la deuda completa.
    const enBs = vesCentimosFromUsd(TOTAL, TASA);
    const resultado = await collectPayment(
      deps(),
      invoiceId,
      { method: 'pago_movil', tenderedAmount: enBs, reference: 'op-12345', confirmRate: false },
      actor,
    );
    idsPagos.push(resultado.payment.id);

    expect(resultado.payment).toMatchObject({
      tenderedCurrency: 'VES',
      amountCentsUsd: TOTAL,
      exchangeRateMicros: TASA,
      imputationPolicy: 'tasa_del_pago',
      // El medio no causa IGTF y la clínica no es SPE: no se percibe nada.
      appliesIgtf: false,
      igtfPerceivedBy: null,
      igtfAmountCentsUsd: 0,
      receivedByUsername: MARKER,
    });
    expect(resultado.payment.receiptLabel).toMatch(/^REC-\d{6}$/);
    expect(resultado.invoice.status).toBe('pagada');
    expect(resultado.invoice.balanceCentsUsd).toBe(0);

    // El recibo quedó archivado con su huella.
    const huella = createHash('sha256')
      .update(Buffer.from('%PDF-1.4 recibo de prueba'))
      .digest('hex');
    expect(resultado.payment.pdfSha256).toBe(huella);
  });

  it('un cobro parcial en divisas deja la factura abonada', async () => {
    const invoiceId = await facturaEmitida(900_002);
    const resultado = await collectPayment(
      deps(),
      invoiceId,
      { method: 'cash_usd', tenderedAmount: 3000, reference: null, confirmRate: false },
      actor,
    );
    idsPagos.push(resultado.payment.id);

    expect(resultado.payment.tenderedCurrency).toBe('USD');
    expect(resultado.payment.amountCentsUsd).toBe(3000);
    expect(resultado.invoice).toMatchObject({ status: 'parcial', balanceCentsUsd: TOTAL - 3000 });
  });

  it('no se cobra más que el saldo', async () => {
    const invoiceId = await facturaEmitida(900_003);
    await expect(
      collectPayment(
        deps(),
        invoiceId,
        {
          method: 'cash_ves',
          // En bolívares: hay que entregar **más** de lo que vale la deuda (1.000,00 Bs. de más).
          tenderedAmount: vesCentimosFromUsd(TOTAL, TASA) + 100_000,
          reference: null,
          confirmRate: false,
        },
        actor,
      ),
    ).rejects.toThrow(/supera el saldo/);
  });

  it('con la bandera de SPE encendida el 3 % de IGTF vuelve a calcularse', async () => {
    await handle.db
      .update(billingSettings)
      .set({ isSpecialTaxpayer: true })
      .where(eq(billingSettings.id, 1));
    try {
      const invoiceId = await facturaEmitida(900_004);
      const resultado = await collectPayment(
        deps(),
        invoiceId,
        { method: 'cash_usd', tenderedAmount: 3000, reference: 'zelle-1', confirmRate: false },
        actor,
      );
      idsPagos.push(resultado.payment.id);

      // El tributo se **registra** pero no engorda la deuda: es dinero de terceros.
      expect(resultado.payment).toMatchObject({
        appliesIgtf: true,
        igtfBasisPoints: 300,
        igtfPerceivedBy: 'clinica',
        igtfAmountCentsUsd: 90,
        amountCentsUsd: 3000,
      });
    } finally {
      await handle.db
        .update(billingSettings)
        .set({ isSpecialTaxpayer: false })
        .where(eq(billingSettings.id, 1));
    }
  });

  it('anular un cobro devuelve el saldo y retrocede el estado', async () => {
    const invoiceId = await facturaEmitida(900_005);
    const cobro = await collectPayment(
      deps(),
      invoiceId,
      { method: 'cash_usd', tenderedAmount: TOTAL, reference: null, confirmRate: false },
      actor,
    );
    idsPagos.push(cobro.payment.id);
    expect(cobro.invoice.status).toBe('pagada');

    const anulado = await voidPayment(
      { db: handle.db },
      cobro.payment.id,
      { reason: 'El paciente pagó con otro medio' },
      actor,
    );
    expect(anulado.payment.voidReason).toBe('El paciente pagó con otro medio');
    expect(anulado.invoice.status).toBe('emitida');
    expect(anulado.invoice.balanceCentsUsd).toBe(TOTAL);

    const [fila] = await handle.db.select().from(invoices).where(eq(invoices.id, invoiceId));
    expect(fila?.balanceCentsUsd).toBe(TOTAL);
    expect(fila?.status).toBe('emitida');

    // El cobro se conserva (no se borra) y la lista lo sigue mostrando.
    const lista = await listInvoicePayments(handle.db, invoiceId);
    expect(lista).toHaveLength(1);
    expect(lista[0]?.voidedAt).not.toBeNull();

    await expect(
      voidPayment({ db: handle.db }, cobro.payment.id, { reason: 'otra vez' }, actor),
    ).rejects.toThrow(/ya está anulado/);
  });

  it('cada cobro y cada anulación dejan su evento en el outbox', async () => {
    const eventos = await handle.db
      .select({ eventType: outboxEvents.eventType, envelope: outboxEvents.envelope })
      .from(outboxEvents)
      .where(
        and(inArray(outboxEvents.aggregateId, idsPagos), eq(outboxEvents.producer, 'billing')),
      );

    const tipos = eventos.map((evento) => evento.eventType);
    expect(tipos).toContain('billing.payment.received');
    expect(tipos).toContain('billing.payment.voided');
    const acciones = eventos.map(
      (evento) => (evento.envelope as { payload?: { action?: string } }).payload?.action,
    );
    expect(acciones).toContain('payment_received');
    expect(acciones).toContain('payment_voided');
  });
});
