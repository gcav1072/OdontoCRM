import { EVENT_TOPICS, domainEventSchema, type DomainEvent } from '@odontocrm/events';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getDraft, listCatalog, listDrafts, replaceDraftItems } from './billing/invoice-service.js';
import { loadBillingConfig } from './config.js';
import { handleDomainEvents } from './consumer.js';
import { createBillingDatabase } from './db/client.js';
import {
  billingSettings,
  invoiceItems,
  invoiceSeries,
  invoiceSessions,
  invoices,
  processedEvents,
} from './db/schema.js';

/**
 * Pruebas de integración de la Fase 11 (sesión A) contra PostgreSQL real:
 *  1. la migración deja sembrada la **configuración cerrada** (no SPE, tasa del pago, formas libres,
 *     catálogo con los servicios exentos y bienes al 16 %);
 *  2. cerrar una sesión crea el **borrador** con sus partidas (código, pieza y caras);
 *  3. el **mismo evento** dos veces no crea dos facturas (idempotencia por `eventId`);
 *  4. un evento **nuevo** de la misma sesión tampoco (la segunda red: `uq_invoice_sessions_session`);
 *  5. editar las líneas recalcula los totales **sumando las partidas**, con el IVA solo del bien.
 *
 * El acervo de identidad no hace falta aquí: el consumidor de facturación no publica nada todavía.
 */
const billingUrl = process.env['TEST_BILLING_DATABASE_URL'];
const ready = billingUrl !== undefined;
const describeWithDatabase = ready ? describe : describe.skip;

const MARKER = `prueba-fase11-${String(Date.now()).slice(-7)}`;
const patientId = globalThis.crypto.randomUUID();
const sessionId = globalThis.crypto.randomUUID();
const eventId = globalThis.crypto.randomUUID();
const eventIdNuevo = globalThis.crypto.randomUUID();

const paciente = {
  patientId,
  fullName: 'Ana Pérez',
  docType: 'V',
  docNumber: '12345678',
  taxId: null,
  fiscalAddress: null,
};

/**
 * El sobre se arma con el esquema del contrato para **fijar el `eventId`**: es lo que permite probar
 * que el mismo evento repetido no crea dos facturas.
 */
const eventoDeCierre = (eventId: string): DomainEvent =>
  domainEventSchema.parse({
    eventId,
    eventType: EVENT_TOPICS.sessionClosed,
    version: 1,
    occurredAt: new Date().toISOString(),
    aggregateId: sessionId,
    producer: 'clinical',
    actorId: null,
    correlationId: `prueba-${MARKER}`,
    payload: {
      session: {
        sessionId,
        patientId,
        procedures: [
          {
            code: 'obturacion_resina',
            detail: null,
            toothNumber: 26,
            surfaces: ['occlusal', 'mesial'],
          },
          { code: 'profilaxis', detail: null, toothNumber: null, surfaces: [] },
        ],
      },
    },
  });

describeWithDatabase('la caja: del cierre de la sesión al borrador', () => {
  let handle: Awaited<ReturnType<typeof createBillingDatabase>>;
  let draftId = '';

  const deps = () => ({ db: handle.db, patientLookup: async () => paciente });

  const borradorDeLaPrueba = async () => {
    const filas = await handle.db
      .select({ id: invoices.id })
      .from(invoices)
      .where(eq(invoices.patientId, patientId));
    return filas;
  };

  beforeAll(async () => {
    if (!ready) throw new Error('falta TEST_BILLING_DATABASE_URL');
    handle = createBillingDatabase(
      loadBillingConfig({ DATABASE_URL: billingUrl, LOG_LEVEL: 'silent' }),
    );
  });

  afterAll(async () => {
    if (!ready) return;
    const filas = await borradorDeLaPrueba();
    const ids = filas.map((fila) => fila.id);
    if (ids.length > 0) {
      await handle.db.delete(invoiceItems).where(inArray(invoiceItems.invoiceId, ids));
      await handle.db.delete(invoiceSessions).where(inArray(invoiceSessions.invoiceId, ids));
      await handle.db.delete(invoices).where(inArray(invoices.id, ids));
    }
    await handle.db
      .delete(processedEvents)
      .where(inArray(processedEvents.eventId, [eventId, eventIdNuevo]));
    await handle.close();
  });

  it('la migración deja sembrada la configuración cerrada del 2026-10-05', async () => {
    const [ajustes] = await handle.db.select().from(billingSettings);
    expect(ajustes).toMatchObject({
      id: 1,
      isSpecialTaxpayer: false,
      imputationPolicy: 'tasa_del_pago',
      foreignCurrencyIvaBasisPoints: 0,
    });

    const series = await handle.db.select().from(invoiceSeries);
    expect(series.find((fila) => fila.series === 'A')?.numberingMode).toBe('formas_libres');

    const catalogo = await listCatalog(handle.db);
    const exentos = catalogo.filter((item) => item.taxCategory === 'exento');
    const gravados = catalogo.filter((item) => item.taxCategory === 'general');
    expect(exentos.length).toBeGreaterThanOrEqual(28);
    expect(gravados.length).toBeGreaterThanOrEqual(2);
    expect(catalogo.every((item) => item.priceCentsUsd >= 0)).toBe(true);
  });

  it('cerrar una sesión crea el borrador con sus partidas (una sola vez)', async () => {
    const resultado = await handleDomainEvents(deps(), [eventoDeCierre(eventId)]);
    expect(resultado).toMatchObject({ creados: 1, duplicados: 0, yaCobradas: 0 });

    const filas = await borradorDeLaPrueba();
    expect(filas).toHaveLength(1);
    expect(filas[0]?.id).toBeDefined();
    draftId = filas[0]?.id ?? '';

    const detalle = await getDraft(handle.db, draftId);
    expect(detalle.status).toBe('borrador');
    expect(detalle.patientName).toBe('Ana Pérez');
    expect(detalle.patientDocNumber).toBe('12345678');
    expect(detalle.clinicalSessionIds).toEqual([sessionId]);

    // Las partidas llevan código, pieza y caras: lo que el evento publica (B14).
    const obturacion = detalle.items.find((item) => item.code === 'obturacion_resina');
    expect(obturacion).toMatchObject({
      toothNumber: 26,
      surfaces: ['occlusal', 'mesial'],
      taxCategory: 'exento',
    });
    // El catálogo nace sin precios de servicio: la caja lo resuelve (M3) y no se bloquea.
    expect(obturacion?.needsPricing).toBe(true);
    expect(detalle.needsPricing).toBe(true);
    expect(detalle.totalCentsUsd).toBe(0);

    // Y el borrador aparece en la cola de la caja.
    const pendientes = await listDrafts(handle.db);
    expect(pendientes.some((draft) => draft.id === draftId)).toBe(true);
  });

  it('el mismo evento dos veces no crea dos facturas (idempotencia por eventId)', async () => {
    const resultado = await handleDomainEvents(deps(), [eventoDeCierre(eventId)]);
    expect(resultado).toMatchObject({ creados: 0, duplicados: 1 });
    expect(await borradorDeLaPrueba()).toHaveLength(1);
  });

  it('un evento nuevo de la misma sesión tampoco duplica (la segunda red)', async () => {
    const resultado = await handleDomainEvents(deps(), [eventoDeCierre(eventIdNuevo)]);
    expect(resultado).toMatchObject({ creados: 0, yaCobradas: 1 });
    expect(await borradorDeLaPrueba()).toHaveLength(1);
  });

  it('editar las líneas recalcula los totales sumando las partidas', async () => {
    const totales = await replaceDraftItems(handle.db, draftId, [
      {
        code: 'obturacion_resina',
        quantity: 1,
        unitPriceCentsUsd: 5000,
        description: null,
        toothNumber: 26,
        surfaces: ['occlusal', 'mesial'],
      },
      {
        code: 'gel_fluorado',
        quantity: 2,
        description: null,
        toothNumber: null,
        surfaces: [],
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

    // 50,00 exento + 30,00 exento = 80,00; el gel: 2 × 12,00 = 24,00 gravado al 16 % = 3,84 de IVA.
    expect(totales).toEqual({
      exemptAmountCentsUsd: 8000,
      taxableAmountCentsUsd: 2400,
      ivaAmountCentsUsd: 384,
      totalCentsUsd: 10784,
    });

    const detalle = await getDraft(handle.db, draftId);
    expect(detalle.itemCount).toBe(3);
    expect(detalle.needsPricing).toBe(false);
    expect(detalle.balanceCentsUsd).toBe(10784);
    const gel = detalle.items.find((item) => item.code === 'gel_fluorado');
    expect(gel).toMatchObject({ taxCategory: 'general', taxRateBasisPoints: 1600, quantity: 2 });
  });

  it('solo los borradores se pueden editar (una factura emitida no)', async () => {
    // Se convierte el borrador en documento (con lo que exige `chk_invoices_issued`) y se comprueba
    // que el servicio lo rechaza **sin tocarlo**: una factura emitida se anula con nota de crédito.
    await handle.db
      .update(invoices)
      .set({
        status: 'emitida',
        invoiceNumber: 999_999,
        exchangeRateMicros: 36_542_000,
        issuedAt: new Date(),
        pdfPath: 'storage/billing/prueba.pdf',
      })
      .where(eq(invoices.id, draftId));

    await expect(
      replaceDraftItems(handle.db, draftId, [
        { code: 'profilaxis', quantity: 1, description: null, toothNumber: null, surfaces: [] },
      ]),
    ).rejects.toThrow(/no se edita/);
    await expect(getDraft(handle.db, draftId)).rejects.toThrow(/no existe/);

    const filas = await handle.db
      .select({ status: invoices.status, total: invoices.totalCentsUsd })
      .from(invoices)
      .where(eq(invoices.id, draftId));
    expect(filas[0]?.status).toBe('emitida');
    expect(filas[0]?.total).toBe(10784);
  });

  it('el catálogo conserva los dos bienes gravados para que el camino del 16 % no se muera', async () => {
    const catalogo = await listCatalog(handle.db);
    const gel = catalogo.find((item) => item.code === 'gel_fluorado');
    expect(gel).toMatchObject({ kind: 'bien', taxCategory: 'general' });
  });
});
