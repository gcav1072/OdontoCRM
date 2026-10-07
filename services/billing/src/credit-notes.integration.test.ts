import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  formatCreditNoteNumber,
  formatInvoiceNumber,
  vesCentimosFromUsd,
  type BillingInvoiceVoided,
} from '@odontocrm/contracts';
import { outboxEvents } from '@odontocrm/db';
import { ConflictError } from '@odontocrm/kernel';
import { createDiskBlobStore } from '@odontocrm/storage';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { discardDraft, voidInvoice } from './billing/credit-note-service.js';
import { loadBillingConfig } from './config.js';
import { createBillingDatabase } from './db/client.js';
import { creditNotes, invoices } from './db/schema.js';

/**
 * Pruebas de integración de la **anulación con nota de crédito** (B8; Art. 22 y 23; ADR 0048) contra
 * PostgreSQL real:
 *  1. anular una factura **emitida** deja la factura `anulada` y emite la **nota de crédito** con su
 *     número, la **referencia copiada** (número, fecha y monto de la factura) y el PDF archivado con
 *     su `sha256`; la factura **se conserva** (no se borra ni se edita);
 *  2. el evento `billing.credit_note.issued` sale al outbox con su carga de auditoría;
 *  3. la numeración de las notas avanza de una en una;
 *  4. un **borrador** se descarta sin nota (nunca consumió número fiscal);
 *  5. una factura **pagada** se rechaza hasta devolver sus cobros;
 *  6. anular dos veces choca con 409.
 *
 * La factura emitida se inserta directamente —la **emisión** ya tiene sus propias pruebas— y el PDF se
 * compone con un **doble** del renderizador: aquí se prueba la nota, no Chromium. El número de la nota
 * sale de una **secuencia global** (`credit_note_number_seq`), así que se comprueba el formato y el
 * avance, no un literal: fijar `NC-000001` haría la prueba dependiente de cuántas veces se haya
 * corrido antes. Se usa una serie y un rango de correlativos propios, lejos de las otras suites, y se
 * limpia lo suyo (notas, facturas, outbox y almacén temporal).
 */
const billingUrl = process.env['TEST_BILLING_DATABASE_URL'];
const ready = billingUrl !== undefined;
const describeWithDatabase = ready ? describe : describe.skip;

const MARKER = `prueba-notas-${String(Date.now()).slice(-7)}`;
const SERIE = 'P';
/** Numeración propia: la emisión usa 100 000-899 999 y los cobros 900 001-900 005. */
const BASE = 1_000_000 + (Date.now() % 900_000);
const TASA = 36_542_000;
const TOTAL = 6392;
const MOTIVO = 'El servicio no se llegó a realizar';

const actor = {
  actorId: null,
  actorUsername: MARKER,
  ip: '127.0.0.1',
  userAgent: 'vitest',
  requestId: `req-${MARKER}`,
};

const paciente = {
  patientId: globalThis.crypto.randomUUID(),
  patientName: 'Ana Pérez',
  patientDocType: 'V',
  patientDocNumber: '15678901',
};

describeWithDatabase('anular con nota de crédito', () => {
  let handle: Awaited<ReturnType<typeof createBillingDatabase>>;
  const dirAlmacen = mkdtempSync(join(tmpdir(), 'odontocrm-notas-'));
  const blobStore = createDiskBlobStore({ rootDir: dirAlmacen });
  const PDF = Buffer.from('%PDF-1.4 nota de crédito de prueba');
  const huellaPdf = createHash('sha256').update(PDF).digest('hex');
  let htmlRecibido = '';
  const pdf = {
    render: async (html: string): Promise<Buffer> => {
      htmlRecibido = html;
      return PDF;
    },
  };
  const deps = () => ({ db: handle.db, blobStore, pdf });
  const idsFacturas: string[] = [];
  let siguienteFactura = BASE;
  let notaEmitida: BillingInvoiceVoided['creditNote'] = null;

  /** Una factura con el estado pedido, insertada directamente. */
  const factura = async (
    status: 'borrador' | 'emitida' | 'pagada',
  ): Promise<{ id: string; numero: number; emitidaEn: Date }> => {
    const numero = siguienteFactura++;
    const emitidaEn = new Date(Date.now() - 60_000);
    const esDocumento = status !== 'borrador';
    const [fila] = await handle.db
      .insert(invoices)
      .values({
        status,
        series: SERIE,
        invoiceNumber: esDocumento ? numero : null,
        controlNumber: esDocumento ? `C${String(numero)}` : null,
        ...paciente,
        exemptAmountCentsUsd: TOTAL,
        taxableAmountCentsUsd: 0,
        ivaAmountCentsUsd: 0,
        totalCentsUsd: TOTAL,
        // `pagada` exige saldo cero; el resto de los estados, la deuda completa.
        balanceCentsUsd: status === 'pagada' ? 0 : TOTAL,
        exchangeRateMicros: esDocumento ? TASA : null,
        exemptAmountVesCentimos: esDocumento ? vesCentimosFromUsd(TOTAL, TASA) : 0,
        totalVesCentimos: esDocumento ? vesCentimosFromUsd(TOTAL, TASA) : 0,
        issuedAt: esDocumento ? emitidaEn : null,
        generatedAt: esDocumento ? emitidaEn : null,
        pdfPath: esDocumento ? `${SERIE}/prueba/factura-${String(numero)}.pdf` : null,
        pdfSha256: esDocumento ? 'huella-de-prueba' : null,
        createdByUserId: '00000000-0000-0000-0000-000000000000',
        createdByUsername: MARKER,
      })
      .returning({ id: invoices.id });
    const id = fila?.id ?? '';
    idsFacturas.push(id);
    return { id, numero, emitidaEn };
  };

  const notasDe = async (invoiceId: string): Promise<string[]> => {
    const filas = await handle.db
      .select({ id: creditNotes.id })
      .from(creditNotes)
      .where(eq(creditNotes.invoiceId, invoiceId));
    return filas.map((fila) => fila.id);
  };

  beforeAll(async () => {
    if (!ready) throw new Error('falta TEST_BILLING_DATABASE_URL');
    handle = createBillingDatabase(
      loadBillingConfig({ DATABASE_URL: billingUrl, LOG_LEVEL: 'silent', STORAGE_DIR: dirAlmacen }),
    );
  });

  afterAll(async () => {
    if (!ready) return;
    // El outbox de TODO lo que deja esta suite, por el actor.
    await handle.db
      .delete(outboxEvents)
      .where(sql`${outboxEvents.envelope}->'payload'->>'actorUsername' = ${MARKER}`);
    if (idsFacturas.length > 0) {
      // Las notas van antes: la factura no se puede borrar mientras la referencie (`restrict`).
      await handle.db.delete(creditNotes).where(inArray(creditNotes.invoiceId, idsFacturas));
      await handle.db.delete(invoices).where(inArray(invoices.id, idsFacturas));
    }
    await handle.close();
    rmSync(dirAlmacen, { recursive: true, force: true });
  });

  it('anular una factura emitida emite la nota y conserva la factura', async () => {
    const { id, numero, emitidaEn } = await factura('emitida');

    const resultado = await voidInvoice(deps(), id, { reason: MOTIVO }, actor);
    const nota = resultado.creditNote;
    expect(nota).not.toBeNull();
    if (nota === null)
      throw new Error('anular una factura emitida tiene que dejar nota de crédito');
    notaEmitida = nota;

    // La factura queda anulada con su motivo, y sigue ahí.
    expect(resultado.invoice).toMatchObject({ id, status: 'anulada', voidReason: MOTIVO });
    const [facturaEnBd] = await handle.db.select().from(invoices).where(eq(invoices.id, id));
    expect(facturaEnBd).toMatchObject({
      status: 'anulada',
      voidReason: MOTIVO,
      voidedByUsername: MARKER,
      // El documento no se toca: su número y su total siguen siendo los de la emisión.
      invoiceNumber: numero,
      totalCentsUsd: TOTAL,
    });
    expect(facturaEnBd?.voidedAt).not.toBeNull();

    // La nota: número propio y la referencia **copiada** de la factura.
    expect(nota.creditNoteLabel).toMatch(/^NC-\d{6}$/);
    expect(nota.creditNoteLabel).toBe(formatCreditNoteNumber(nota.creditNoteNumber));
    expect(nota.creditNoteNumber).toBeGreaterThan(0);
    expect(nota.invoiceId).toBe(id);
    expect(nota.invoiceNumber).toBe(numero);
    expect(nota.invoiceNumberLabel).toBe(formatInvoiceNumber(SERIE, numero));
    // La fecha copiada es la de **emisión de la factura**, no la de la anulación.
    expect(new Date(nota.invoiceIssuedAt).getTime()).toBe(emitidaEn.getTime());
    expect(nota).toMatchObject({
      kind: 'total',
      reason: MOTIVO,
      invoiceTotalCentsUsd: TOTAL,
      totalCentsUsd: TOTAL,
      exchangeRateMicros: TASA,
      totalVesCentimos: vesCentimosFromUsd(TOTAL, TASA),
      pdfSha256: huellaPdf,
    });

    // La fila en la base guarda lo mismo, con su huella y su archivo.
    const [notaEnBd] = await handle.db
      .select()
      .from(creditNotes)
      .where(eq(creditNotes.id, nota.id));
    expect(notaEnBd).toMatchObject({
      invoiceId: id,
      invoiceNumber: numero,
      invoiceTotalCentsUsd: TOTAL,
      kind: 'total',
      reason: MOTIVO,
      pdfSha256: huellaPdf,
      issuedByUsername: MARKER,
    });
    expect(notaEnBd?.invoiceIssuedAt.getTime()).toBe(emitidaEn.getTime());
    expect(notaEnBd?.pdfPath).not.toBeNull();
    expect(await blobStore.exists(notaEnBd?.pdfPath ?? '')).toBe(true);

    // El renderizador recibió la nota compuesta, con su referencia y su motivo.
    expect(htmlRecibido).toContain('NOTA DE CRÉDITO');
    expect(htmlRecibido).toContain(nota.creditNoteLabel);
    expect(htmlRecibido).toContain(formatInvoiceNumber(SERIE, numero));
    expect(htmlRecibido).toContain(MOTIVO);
  });

  it('el evento de la nota sale al outbox con su carga de auditoría', async () => {
    const nota = notaEmitida;
    if (nota === null) throw new Error('la prueba anterior no dejó nota de crédito');

    const eventos = await handle.db
      .select({ envelope: outboxEvents.envelope, eventType: outboxEvents.eventType })
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.aggregateId, nota.id),
          eq(outboxEvents.eventType, 'billing.credit_note.issued'),
        ),
      );

    expect(eventos).toHaveLength(1);
    const carga = (eventos[0]?.envelope as { payload?: Record<string, unknown> } | undefined)
      ?.payload;
    expect(carga?.['action']).toBe('credit_note_issued');
    expect(carga?.['entityType']).toBe('credit_note');
    expect(carga?.['actorUsername']).toBe(MARKER);
    expect(carga?.['reason']).toBe(MOTIVO);
    expect(carga?.['creditNote']).toMatchObject({
      creditNoteId: nota.id,
      number: nota.creditNoteLabel,
      invoiceId: nota.invoiceId,
      invoiceNumber: nota.invoiceNumberLabel,
      totalCentsUsd: TOTAL,
      totalVesCentimos: vesCentimosFromUsd(TOTAL, TASA),
    });
    expect(carga?.['invoice']).toMatchObject({ invoiceId: nota.invoiceId, status: 'anulada' });
  });

  it('la numeración de las notas avanza de una en una', async () => {
    const primera = notaEmitida;
    if (primera === null) throw new Error('la primera prueba no dejó nota de crédito');

    const { id } = await factura('emitida');
    const resultado = await voidInvoice(deps(), id, { reason: 'Otra anulación' }, actor);

    expect(resultado.creditNote?.creditNoteNumber).toBe(primera.creditNoteNumber + 1);
    expect(resultado.creditNote?.creditNoteLabel).toBe(
      formatCreditNoteNumber(primera.creditNoteNumber + 1),
    );
  });

  it('un borrador se descarta sin nota de crédito', async () => {
    const { id } = await factura('borrador');

    const resultado = await discardDraft(handle.db, id, { reason: MOTIVO }, actor);
    expect(resultado.invoice).toMatchObject({ id, status: 'anulada', voidReason: MOTIVO });
    // Nunca fue un documento: no consumió número fiscal y no lleva nota.
    expect(resultado.creditNote).toBeNull();
    expect(await notasDe(id)).toHaveLength(0);

    const eventos = await handle.db
      .select({ envelope: outboxEvents.envelope })
      .from(outboxEvents)
      .where(
        and(eq(outboxEvents.aggregateId, id), eq(outboxEvents.eventType, 'billing.invoice.voided')),
      );
    expect(eventos).toHaveLength(1);
    expect((eventos[0]?.envelope as { payload?: { action?: string } }).payload?.action).toBe(
      'invoice_voided',
    );

    // Descartar lo ya anulado choca, y a un borrador no se le da nota de crédito.
    await expect(discardDraft(handle.db, id, { reason: MOTIVO }, actor)).rejects.toThrow(
      /ya está emitida/,
    );
    const otro = await factura('borrador');
    await expect(voidInvoice(deps(), otro.id, { reason: MOTIVO }, actor)).rejects.toThrow(
      /borrador/,
    );
  });

  it('una factura pagada se rechaza hasta devolver sus cobros', async () => {
    const { id } = await factura('pagada');

    const error = await voidInvoice(deps(), id, { reason: MOTIVO }, actor).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).status).toBe(409);
    expect((error as Error).message).toMatch(/pagada/);

    // No se emitió nada ni se tocó el estado.
    expect(await notasDe(id)).toHaveLength(0);
    const [fila] = await handle.db
      .select({ status: invoices.status })
      .from(invoices)
      .where(eq(invoices.id, id));
    expect(fila?.status).toBe('pagada');
  });

  it('anular dos veces choca con 409', async () => {
    const { id } = await factura('emitida');
    await voidInvoice(deps(), id, { reason: MOTIVO }, actor);

    const error = await voidInvoice(deps(), id, { reason: 'otra vez' }, actor).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).status).toBe(409);
    expect((error as Error).message).toMatch(/ya está anulada/);

    // Una sola nota por factura: la segunda anulación no llegó a emitir.
    expect(await notasDe(id)).toHaveLength(1);
  });
});
