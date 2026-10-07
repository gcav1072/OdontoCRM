import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { outboxEvents } from '@odontocrm/db';
import { createDiskBlobStore } from '@odontocrm/storage';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDraftFromSession } from './billing/invoice-service.js';
import { issueInvoice } from './billing/issue-service.js';
import { getInvoice, replaceDraftItems } from './billing/invoice-service.js';
import { createLot } from './billing/fiscal-forms-service.js';
import { rateDateInCaracas, vesCentimosFromUsd } from '@odontocrm/contracts';
import { loadBillingConfig } from './config.js';
import { createBillingDatabase } from './db/client.js';
import {
  exchangeRates,
  fiscalForms,
  invoiceItems,
  invoiceSeries,
  invoiceSessions,
  invoices,
  processedEvents,
} from './db/schema.js';
import { setRate } from './rates/rate-service.js';

/**
 * Pruebas de integración de la **emisión** (ADR 0047/0048) contra PostgreSQL real:
 *  1. no se emite con partidas sin precio;
 *  2. no se emite sin tasa publicada;
 *  3. emitir toma los **dos números** (correlativo y control), consume la forma y **congela la tasa**;
 *  4. el PDF se archiva con su `sha256` y el evento sale al outbox con su carga de auditoría;
 *  5. una factura emitida **no se emite dos veces**.
 *
 * Usa una serie propia (`P`) con un rango bajo, para no depender de los lotes de otras suites ni de
 * las tasas que dejan. El PDF se compone con un **doble** del renderizador: lo que se prueba aquí es
 * la emisión, no Chromium (que ya está probado por los récipes y los reportes). Y limpia lo suyo,
 * incluido el outbox y el almacén temporal.
 */
const billingUrl = process.env['TEST_BILLING_DATABASE_URL'];
const ready = billingUrl !== undefined;
const describeWithDatabase = ready ? describe : describe.skip;

const MARKER = `prueba-emision-${String(Date.now()).slice(-7)}`;
const SERIE = 'P';
const BASE = 100_000 + (Date.now() % 800_000);
const HOY = rateDateInCaracas();

const actor = {
  actorId: null,
  actorUsername: MARKER,
  ip: '127.0.0.1',
  userAgent: 'vitest',
  requestId: `req-${MARKER}`,
};

/**
 * Cerrojo compartido con la suite de **cobros**.
 *
 * Las dos comparten la base temporal y **se contradicen** en una sola cosa: la tasa de hoy. Esta
 * suite exige que no haya ninguna publicada antes de emitir; la de cobros publica la suya. Vitest
 * arranca los archivos en paralelo, así que en vez de dejarlo a la suerte del planificador se
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
  fullName: 'Luis Márquez',
  docType: 'V',
  docNumber: '18765432',
  taxId: null,
  fiscalAddress: null,
};

const sessionId = globalThis.crypto.randomUUID();
const eventId = globalThis.crypto.randomUUID();

const eventoDeCierre = () => ({
  eventId,
  topic: 'clinical.session.closed',
  sessionId,
  patientId: paciente.patientId,
  procedures: [
    { code: 'obturacion_resina', detail: null, toothNumber: 26, surfaces: ['occlusal'] },
    { code: 'profilaxis', detail: null, toothNumber: null, surfaces: [] },
  ],
});

const CEDULA = 'providencia 0071/2026';
const lote = () => ({
  series: SERIE,
  controlFrom: String(BASE),
  controlTo: String(BASE + 9),
  printerName: `Imprenta ${MARKER}`,
  printerRif: 'J-99887766-5',
  authorizationRef: CEDULA,
  authorizationDate: '2026-09-30',
  printDate: '2026-10-01',
});

describeWithDatabase('emitir la factura', () => {
  let handle: Awaited<ReturnType<typeof createBillingDatabase>>;
  const dirAlmacen = mkdtempSync(join(tmpdir(), 'odontocrm-emision-'));
  const blobStore = createDiskBlobStore({ rootDir: dirAlmacen });
  const pdf = { render: async (): Promise<Buffer> => Buffer.from('%PDF-1.4 factura de prueba') };
  let draftId = '';
  let idLote = '';
  const idsTasas: string[] = [];
  let cerrojo: Client | undefined;

  beforeAll(async () => {
    if (!ready) throw new Error('falta TEST_BILLING_DATABASE_URL');
    handle = createBillingDatabase(
      loadBillingConfig({
        DATABASE_URL: billingUrl,
        LOG_LEVEL: 'silent',
        STORAGE_DIR: dirAlmacen,
      }),
    );
    // Antes de tocar la tasa: que la suite de cobros no esté usándola.
    cerrojo = await tomarCerrojoDeLaTasaDeHoy(billingUrl);
    await handle.db
      .insert(invoiceSeries)
      .values({ series: SERIE, numberingMode: 'formas_libres' })
      .onConflictDoNothing();
  });

  afterAll(async () => {
    if (!ready) return;
    if (draftId !== '') {
      await handle.db.delete(invoiceItems).where(eq(invoiceItems.invoiceId, draftId));
      await handle.db.delete(invoiceSessions).where(eq(invoiceSessions.invoiceId, draftId));
      await handle.db.delete(outboxEvents).where(eq(outboxEvents.aggregateId, draftId));
      await handle.db.delete(invoices).where(eq(invoices.id, draftId));
    }
    await handle.db.delete(processedEvents).where(eq(processedEvents.eventId, eventId));
    // El outbox de TODO lo que deja esta suite, por el actor: la factura, la tasa y el lote.
    await handle.db
      .delete(outboxEvents)
      .where(sql`${outboxEvents.envelope}->'payload'->>'actorUsername' = ${MARKER}`);
    await handle.db.delete(fiscalForms).where(eq(fiscalForms.printerRif, 'J-99887766-5'));
    if (idsTasas.length > 0) {
      await handle.db.delete(exchangeRates).where(inArray(exchangeRates.id, idsTasas));
    }
    await handle.db.delete(invoiceSeries).where(eq(invoiceSeries.series, SERIE));
    await handle.close();
    // Se suelta el último: la otra suite de dinero puede entrar.
    await cerrojo?.end().catch(() => undefined);
    rmSync(dirAlmacen, { recursive: true, force: true });
  });

  it('el cierre de la sesión deja el borrador (y sin precio no se emite)', async () => {
    const deps = { db: handle.db, patientLookup: async () => paciente };
    expect(await createDraftFromSession(deps, eventoDeCierre())).toBe('creado');

    const [fila] = await handle.db
      .select({ id: invoices.id })
      .from(invoices)
      .where(eq(invoices.patientId, paciente.patientId));
    draftId = fila?.id ?? '';
    expect(draftId).not.toBe('');

    // La serie de la prueba, para que el lote y el correlativo sean los suyos.
    await handle.db.update(invoices).set({ series: SERIE }).where(eq(invoices.id, draftId));

    await expect(issueInvoice({ db: handle.db, blobStore, pdf }, draftId, actor)).rejects.toThrow(
      /sin precio/,
    );
  });

  it('sin ninguna tasa publicada no se emite', async () => {
    await replaceDraftItems(handle.db, draftId, [
      {
        code: 'obturacion_resina',
        quantity: 1,
        unitPriceCentsUsd: 5000,
        description: null,
        toothNumber: 26,
        surfaces: ['occlusal'],
      },
      {
        code: 'profilaxis',
        quantity: 1,
        unitPriceCentsUsd: 3000,
        description: null,
        toothNumber: null,
        surfaces: [],
      },
    ]);

    await expect(issueInvoice({ db: handle.db, blobStore, pdf }, draftId, actor)).rejects.toThrow(
      /tasa/,
    );
  });

  it('emitir toma los dos números, consume la forma y congela la tasa', async () => {
    // La tasa del día y el lote de formas: las dos dependencias duras de la emisión.
    const tasa = await setRate(handle.db, { rateDate: HOY, rate: '36,5420', note: null }, actor);
    idsTasas.push(tasa.id);
    const loteCreado = await createLot(handle.db, lote(), actor);
    idLote = loteCreado.id;

    const emitida = await issueInvoice({ db: handle.db, blobStore, pdf }, draftId, actor);

    // Los dos números.
    expect(emitida.invoiceNumber).toBeGreaterThan(0);
    expect(emitida.numberLabel).toBe(`P-${String(emitida.invoiceNumber).padStart(6, '0')}`);
    expect(emitida.controlNumber).toBe(String(BASE));

    // El documento.
    expect(emitida.status).toBe('emitida');
    expect(emitida.exchangeRateMicros).toBe(36_542_000);
    expect(emitida.totalCentsUsd).toBe(8000);
    expect(emitida.ivaAmountCentsUsd).toBe(0);

    // Las dos partidas son servicios odontológicos: todo **exento**, sin IVA.
    const enBsObturacion = vesCentimosFromUsd(5000, 36_542_000);
    const enBsProfilaxis = vesCentimosFromUsd(3000, 36_542_000);
    expect(emitida.exemptAmountVesCentimos).toBe(enBsObturacion + enBsProfilaxis);
    expect(emitida.taxableAmountVesCentimos).toBe(0);
    expect(emitida.totalVesCentimos).toBe(enBsObturacion + enBsProfilaxis);

    // La forma quedó consumida en orden: la siguiente emisión usará el control siguiente.
    const [forma] = await handle.db.select().from(fiscalForms).where(eq(fiscalForms.id, idLote));
    expect(forma?.nextControl).toBe(String(BASE + 1));

    // El PDF quedó archivado con su huella.
    const huella = createHash('sha256')
      .update(Buffer.from('%PDF-1.4 factura de prueba'))
      .digest('hex');
    expect(emitida.pdfSha256).toBe(huella);
    const [guardada] = await handle.db
      .select({ pdfPath: invoices.pdfPath, pdfSha256: invoices.pdfSha256 })
      .from(invoices)
      .where(eq(invoices.id, draftId));
    expect(guardada?.pdfSha256).toBe(huella);
    expect(guardada?.pdfPath).not.toBeNull();
    expect(await blobStore.exists(guardada?.pdfPath ?? '')).toBe(true);
  });

  it('el evento de la emisión sale al outbox con su carga de auditoría', async () => {
    const eventos = await handle.db
      .select({ envelope: outboxEvents.envelope, eventType: outboxEvents.eventType })
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.aggregateId, draftId),
          eq(outboxEvents.eventType, 'billing.invoice.issued'),
        ),
      );

    expect(eventos).toHaveLength(1);
    const carga = (eventos[0]?.envelope as { payload?: Record<string, unknown> } | undefined)
      ?.payload;
    expect(carga?.['action']).toBe('invoice_issued');
    expect(carga?.['entityType']).toBe('invoice');
    expect(carga?.['rate'] ?? carga?.['invoice']).toMatchObject({ rateMicros: 36_542_000 });
  });

  it('una factura emitida no se emite dos veces ni se edita', async () => {
    await expect(issueInvoice({ db: handle.db, blobStore, pdf }, draftId, actor)).rejects.toThrow(
      /no se emite dos veces/,
    );
    await expect(
      replaceDraftItems(handle.db, draftId, [
        { code: 'profilaxis', quantity: 1, description: null, toothNumber: null, surfaces: [] },
      ]),
    ).rejects.toThrow(/no se edita/);

    const detalle = await getInvoice(handle.db, draftId);
    expect(detalle.status).toBe('emitida');
    expect(detalle.totalCentsUsd).toBe(8000);
  });
});
