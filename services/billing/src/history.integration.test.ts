import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { rateDateInCaracas } from '@odontocrm/contracts';
import { outboxEvents } from '@odontocrm/db';
import { createDiskBlobStore } from '@odontocrm/storage';
import { eq, inArray, sql } from 'drizzle-orm';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { voidInvoice } from './billing/credit-note-service.js';
import {
  createDraftFromSession,
  listInvoices,
  replaceDraftItems,
} from './billing/invoice-service.js';
import { issueInvoice } from './billing/issue-service.js';
import { collectPayment } from './billing/payment-service.js';
import { registerInvoicePrint, registerPaymentPrint } from './billing/print-service.js';
import { loadBillingConfig } from './config.js';
import { createBillingDatabase } from './db/client.js';
import {
  creditNotes,
  exchangeRates,
  invoiceItems,
  invoiceSessions,
  invoices,
  payments,
  processedEvents,
} from './db/schema.js';
import { setRate } from './rates/rate-service.js';

/**
 * Pruebas de integración del **historial de la caja** y de la **reimpresión** (Fase 11) contra
 * PostgreSQL real:
 *
 *  1. el historial lista los documentos del período —borradores incluidos—, del más reciente al más
 *     viejo, con el estado, el saldo, los cobros, la nota de crédito y las reimpresiones;
 *  2. filtra por estado, por día del documento (Caracas) y por nombre o documento del paciente, y
 *     pagina con el contrato;
 *  3. reimprimir cuenta y deja su evento en el outbox; un borrador **no** tiene PDF que reimprimir;
 *  4. el recibo del cobro se cuenta igual.
 *
 * Como las otras suites de facturación comparten la base temporal, todo se aísla **por documento del
 * paciente** (una cédula propia de esta suite) y por el cerrojo de la tasa de hoy, que es lo único que
 * se contradice entre suites. Lo que se crea se borra al final, con el outbox y el almacén.
 */
const billingUrl = process.env['TEST_BILLING_DATABASE_URL'];
const ready = billingUrl !== undefined;
const describeWithDatabase = ready ? describe : describe.skip;

const MARKER = `prueba-historial-${String(Date.now()).slice(-7)}`;
/** Cédulas propias: el historial se filtra por ellas y nadie más las usa. */
const CEDULA = `19${String(Date.now()).slice(-7)}`;
const NOMBRE = `Historial ${MARKER}`;
const HOY = rateDateInCaracas();

const actor = {
  actorId: null,
  actorUsername: MARKER,
  ip: '127.0.0.1',
  userAgent: 'vitest',
  requestId: `req-${MARKER}`,
};

const paciente = {
  patientId: globalThis.crypto.randomUUID(),
  fullName: NOMBRE,
  docType: 'V',
  docNumber: CEDULA,
  taxId: null,
  fiscalAddress: null,
};

const cierreDeSesion = (sessionId: string) => ({
  eventId: globalThis.crypto.randomUUID(),
  topic: 'clinical.session.closed',
  sessionId,
  patientId: paciente.patientId,
  procedures: [{ code: 'profilaxis', detail: null, toothNumber: null, surfaces: [] }],
});

const tomarCerrojoDeLaTasaDeHoy = async (url: string | undefined): Promise<Client> => {
  const cerrojo = new Client({ connectionString: url });
  await cerrojo.connect();
  await cerrojo.query(`select pg_advisory_lock(hashtext('billing: la tasa de hoy'))`);
  return cerrojo;
};

describeWithDatabase('el historial de la caja y la reimpresión', () => {
  let handle: Awaited<ReturnType<typeof createBillingDatabase>>;
  let cerrojo: Client | undefined;
  const dirAlmacen = mkdtempSync(join(tmpdir(), 'odontocrm-historial-'));
  const blobStore = createDiskBlobStore({ rootDir: dirAlmacen });
  const pdf = { render: async (): Promise<Buffer> => Buffer.from('%PDF-1.4 historial de prueba') };
  const deps = () => ({ db: handle.db, blobStore, pdf });

  const idsFacturas: string[] = [];
  const idsTasas: string[] = [];
  const idsEventos: string[] = [];
  let idPago = '';
  let idFacturaAnulada = '';

  /** Crea el borrador de una sesión cerrada con una partida ya preciada. */
  const borradorDe = async (): Promise<string> => {
    const sessionId = globalThis.crypto.randomUUID();
    const evento = cierreDeSesion(sessionId);
    idsEventos.push(evento.eventId);
    const salida = await createDraftFromSession(
      { db: handle.db, patientLookup: async () => paciente },
      evento,
    );
    expect(salida).toBe('creado');

    const [fila] = await handle.db
      .select({ id: invoices.id })
      .from(invoices)
      .where(eq(invoices.patientId, paciente.patientId))
      .orderBy(sql`${invoices.createdAt} desc`)
      .limit(1);
    const id = fila?.id ?? '';
    expect(id).not.toBe('');
    idsFacturas.push(id);

    await replaceDraftItems(handle.db, id, [
      {
        code: 'profilaxis',
        quantity: 1,
        unitPriceCentsUsd: 2_000,
        description: null,
        toothNumber: null,
        surfaces: [],
      },
    ]);
    return id;
  };

  beforeAll(async () => {
    if (!ready) throw new Error('falta TEST_BILLING_DATABASE_URL');
    handle = createBillingDatabase(
      loadBillingConfig({ DATABASE_URL: billingUrl, LOG_LEVEL: 'silent', STORAGE_DIR: dirAlmacen }),
    );
    cerrojo = await tomarCerrojoDeLaTasaDeHoy(billingUrl);

    // La tasa de hoy, mientras el cerrojo es nuestro: sin ella no se emite ni se cobra. Con motivo
    // porque puede haber quedado una de otra suite y corregirla lo exige.
    const tasa = await setRate(
      handle.db,
      { rateDate: HOY, rate: '36,5420', note: 'Pruebas del historial de la caja' },
      actor,
    );
    idsTasas.push(tasa.id);

    // Un borrador (nace sin número), una factura emitida y cobrada, y una emitida y anulada.
    await borradorDe();

    const emitida = await borradorDe();
    await issueInvoice(deps(), emitida, actor);
    const cobro = await collectPayment(
      deps(),
      emitida,
      { method: 'cash_ves', tenderedAmount: 73_084, reference: null, confirmRate: false },
      actor,
    );
    idPago = cobro.payment.id;

    const anulada = await borradorDe();
    await issueInvoice(deps(), anulada, actor);
    await voidInvoice(deps(), anulada, { reason: 'La paciente cambió de tratamiento' }, actor);
    idFacturaAnulada = anulada;
  });

  afterAll(async () => {
    if (!ready) return;
    for (const id of idsFacturas) {
      await handle.db.delete(payments).where(eq(payments.invoiceId, id));
      await handle.db.delete(creditNotes).where(eq(creditNotes.invoiceId, id));
      await handle.db.delete(invoiceItems).where(eq(invoiceItems.invoiceId, id));
      await handle.db.delete(invoiceSessions).where(eq(invoiceSessions.invoiceId, id));
      await handle.db.delete(invoices).where(eq(invoices.id, id));
    }
    // El outbox de TODO lo que deja esta suite, por el actor.
    await handle.db
      .delete(outboxEvents)
      .where(sql`${outboxEvents.envelope}->'payload'->>'actorUsername' = ${MARKER}`);
    // Y los cierres de sesión que reclamó el consumidor al crear cada borrador.
    if (idsEventos.length > 0) {
      await handle.db.delete(processedEvents).where(inArray(processedEvents.eventId, idsEventos));
    }
    if (idsTasas.length > 0) {
      await handle.db.delete(exchangeRates).where(inArray(exchangeRates.id, idsTasas));
    }
    await handle.close();
    // Se suelta el último: las otras suites de dinero pueden entrar.
    await cerrojo?.end().catch(() => undefined);
    rmSync(dirAlmacen, { recursive: true, force: true });
  });

  it('lista los documentos del paciente: borrador, cobrada y anulada, del más reciente al más viejo', async () => {
    const pagina = await listInvoices(handle.db, {
      page: 1,
      pageSize: 25,
      search: CEDULA,
    });

    expect(pagina.total).toBe(3);
    expect(pagina.items).toHaveLength(3);
    expect(pagina.totalPages).toBe(1);

    // Del más reciente al más viejo: la última que se creó (la anulada) va primero.
    const anulada = pagina.items[0];
    expect(anulada?.id).toBe(idFacturaAnulada);
    expect(anulada?.status).toBe('anulada');
    expect(anulada?.numberLabel).toMatch(/^[A-Z]-\d{6}$/);
    expect(anulada?.creditNote?.creditNoteLabel).toMatch(/^NC-\d{6}$/);
    expect(anulada?.creditNote?.totalCentsUsd).toBe(2_000);
    expect(anulada?.paymentCount).toBe(0);
    // El borrador sigue en la lista: nació y todavía no se emitió.
    const borrador = pagina.items.find((item) => item.status === 'borrador');
    expect(borrador?.numberLabel).toBeNull();
    expect(borrador?.issuedAt).toBeNull();
    expect(borrador?.pdfSha256).toBeNull();

    const cobrada = pagina.items.find((item) => item.status === 'pagada');
    expect(cobrada?.paymentCount).toBe(1);
    expect(cobrada?.balanceCentsUsd).toBe(0);
    expect(cobrada?.pdfSha256).not.toBeNull();
    expect(cobrada?.printCount).toBe(0);
    expect(cobrada?.numberLabel).not.toBeNull();
    expect(cobrada?.patientName).toBe(NOMBRE);
  });

  it('filtra por estado, por día del documento y por nombre', async () => {
    const soloAnuladas = await listInvoices(handle.db, {
      page: 1,
      pageSize: 25,
      search: CEDULA,
      status: 'anulada',
    });
    expect(soloAnuladas.total).toBe(1);
    expect(soloAnuladas.items[0]?.id).toBe(idFacturaAnulada);

    // El día del documento es el de Caracas: hoy entran las tres, ayer ninguna.
    const hoy = await listInvoices(handle.db, {
      page: 1,
      pageSize: 25,
      search: CEDULA,
      from: HOY,
      to: HOY,
    });
    expect(hoy.total).toBe(3);

    const ayer = await listInvoices(handle.db, {
      page: 1,
      pageSize: 25,
      search: CEDULA,
      from: '2020-01-01',
      to: '2020-01-02',
    });
    expect(ayer.total).toBe(0);

    // Por nombre también: es lo que teclea la secretaría cuando no tiene la cédula delante.
    const porNombre = await listInvoices(handle.db, { page: 1, pageSize: 25, search: MARKER });
    expect(porNombre.total).toBe(3);

    const sinResultados = await listInvoices(handle.db, {
      page: 1,
      pageSize: 25,
      search: 'No-existe-999',
    });
    expect(sinResultados.total).toBe(0);
    expect(sinResultados.items).toHaveLength(0);
  });

  it('pagina con el contrato: dos por página y las tres en total', async () => {
    const primera = await listInvoices(handle.db, { page: 1, pageSize: 2, search: CEDULA });
    const segunda = await listInvoices(handle.db, { page: 2, pageSize: 2, search: CEDULA });

    expect(primera.items).toHaveLength(2);
    expect(segunda.items).toHaveLength(1);
    expect(primera.total).toBe(3);
    expect(primera.totalPages).toBe(2);
    expect(primera.pageSize).toBe(2);
    // Sin repetir: la segunda página trae el que falta.
    const ids = [...primera.items, ...segunda.items].map((item) => item.id);
    expect(new Set(ids).size).toBe(3);
  });

  it('reimprimir la factura cuenta, deja su evento y un borrador no se reimprime', async () => {
    const cobrada = (
      await listInvoices(handle.db, { page: 1, pageSize: 25, search: CEDULA })
    ).items.find((item) => item.status === 'pagada');
    expect(cobrada).toBeDefined();
    const id = cobrada?.id ?? '';

    const primera = await registerInvoicePrint(handle.db, id, actor);
    expect(primera.printCount).toBe(1);
    expect(primera.id).toBe(id);

    const segunda = await registerInvoicePrint(handle.db, id, actor);
    expect(segunda.printCount).toBe(2);
    expect(segunda.lastPrintedAt >= primera.lastPrintedAt).toBe(true);

    const eventos = await handle.db
      .select({ tipo: outboxEvents.eventType, carga: outboxEvents.envelope })
      .from(outboxEvents)
      .where(eq(outboxEvents.aggregateId, id));
    const reimpresiones = eventos.filter((evento) => evento.tipo === 'billing.invoice.printed');
    expect(reimpresiones).toHaveLength(2);
    const carga = reimpresiones[1]?.carga as { payload?: Record<string, unknown> } | undefined;
    expect(carga?.payload?.['action']).toBe('invoice_printed');
    expect(carga?.payload?.['after']).toEqual({ printCount: 2 });

    // Y el historial lo dice: el contador se ve en la lista.
    const conImpresiones = (
      await listInvoices(handle.db, { page: 1, pageSize: 25, search: CEDULA })
    ).items.find((item) => item.id === id);
    expect(conImpresiones?.printCount).toBe(2);
    expect(conImpresiones?.lastPrintedAt).not.toBeNull();

    // Un borrador no tiene papel archivado que reimprimir.
    const borrador = (
      await listInvoices(handle.db, { page: 1, pageSize: 25, search: CEDULA })
    ).items.find((item) => item.status === 'borrador');
    await expect(registerInvoicePrint(handle.db, borrador?.id ?? '', actor)).rejects.toThrow(
      /no tiene PDF/i,
    );
  });

  it('el recibo del cobro se cuenta igual que la factura', async () => {
    const primera = await registerPaymentPrint(handle.db, idPago, actor);
    expect(primera.printCount).toBe(1);

    const segunda = await registerPaymentPrint(handle.db, idPago, actor);
    expect(segunda.printCount).toBe(2);

    const eventos = await handle.db
      .select({ tipo: outboxEvents.eventType })
      .from(outboxEvents)
      .where(eq(outboxEvents.aggregateId, idPago));
    expect(eventos.filter((evento) => evento.tipo === 'billing.payment.printed')).toHaveLength(2);
  });
});
