import {
  formatInvoiceNumber,
  formatReceiptNumber,
  type BillingPrintResult,
} from '@odontocrm/contracts';
import { EVENT_TOPICS } from '@odontocrm/events';
import { ConflictError, NotFoundError } from '@odontocrm/kernel';
import { eq } from 'drizzle-orm';

import type { BillingDb } from '../db/client.js';
import { invoices, payments } from '../db/schema.js';
import type { ActorContext } from '../shared/context.js';
import { auditPayload, publish } from '../shared/events.js';

/**
 * La **constancia de impresión** de los documentos de cobro (ADR 0048).
 *
 * Lo que se reimprime es el archivo que se archivó al emitir —no una composición nueva—, y cada vez
 * que sale por la impresora queda dicho: cuántas veces y cuándo. Es el mismo camino que el récipe
 * emitido ([ADR 0036](../../../../docs/adr/0036-recipe-emitido-documento-archivado.md)): imprimir un
 * documento de dinero es un acto, no un detalle, y por eso se cuenta y se publica.
 *
 * **Emitir no cuenta como impresión**: la factura nace con `printCount = 0`, así que un 3 significa
 * «se ha reimpreso tres veces». La descarga cuenta igual que la impresión: el papel que se lleva el
 * paciente sale por el mismo sitio.
 *
 * El PDF lo sirve `document-routes`; esto es el paso de al lado (`POST …/printed`), que la pantalla
 * llama al abrir el documento.
 */

/** Una impresión: lo que devuelve el paso de la constancia. */
const resultado = (
  id: string,
  printCount: number,
  lastPrintedAt: Date | null,
): BillingPrintResult => ({
  id,
  printCount,
  // El `update` escribe las dos columnas a la vez, así que la fecha siempre está.
  lastPrintedAt: (lastPrintedAt ?? new Date()).toISOString(),
});

/** Deja constancia de que se imprimió (o se descargó) una **factura** emitida. */
export const registerInvoicePrint = async (
  db: BillingDb,
  invoiceId: string,
  actor: ActorContext,
): Promise<BillingPrintResult> => {
  const [fila] = await db
    .select({
      id: invoices.id,
      series: invoices.series,
      invoiceNumber: invoices.invoiceNumber,
      pdfPath: invoices.pdfPath,
      printCount: invoices.printCount,
    })
    .from(invoices)
    .where(eq(invoices.id, invoiceId))
    .limit(1);
  if (fila === undefined) throw new NotFoundError('Esa factura no existe');
  if (fila.pdfPath === null) {
    throw new ConflictError('El borrador todavía no tiene PDF: primero se emite', {
      extensions: { invoiceId, status: 'borrador' },
    });
  }

  const ahora = new Date();
  const actualizada = await db.transaction(async (tx) => {
    const [guardada] = await tx
      .update(invoices)
      .set({ printCount: fila.printCount + 1, lastPrintedAt: ahora })
      .where(eq(invoices.id, invoiceId))
      .returning({
        id: invoices.id,
        printCount: invoices.printCount,
        lastPrintedAt: invoices.lastPrintedAt,
      });
    if (guardada === undefined) throw new NotFoundError('Esa factura no existe');

    await publish(tx, {
      topic: EVENT_TOPICS.invoicePrinted,
      aggregateId: invoiceId,
      actor,
      payload: auditPayload({
        entityId: invoiceId,
        action: 'invoice_printed',
        entityType: 'invoice',
        summary: `Factura ${formatInvoiceNumber(fila.series, fila.invoiceNumber ?? 0)} impresa (${String(guardada.printCount)}.ª vez)`,
        changedFields: ['printCount'],
        before: { printCount: fila.printCount },
        after: { printCount: guardada.printCount },
        actor,
      }),
    });

    return guardada;
  });

  return resultado(actualizada.id, actualizada.printCount, actualizada.lastPrintedAt);
};

/** Deja constancia de que se imprimió (o se descargó) el **recibo** de un cobro. */
export const registerPaymentPrint = async (
  db: BillingDb,
  paymentId: string,
  actor: ActorContext,
): Promise<BillingPrintResult> => {
  const [fila] = await db
    .select({
      id: payments.id,
      receiptNumber: payments.receiptNumber,
      pdfPath: payments.pdfPath,
      printCount: payments.printCount,
    })
    .from(payments)
    .where(eq(payments.id, paymentId))
    .limit(1);
  if (fila === undefined) throw new NotFoundError('Ese cobro no existe');
  if (fila.pdfPath === null) {
    throw new ConflictError('Ese recibo no tiene PDF archivado', { extensions: { paymentId } });
  }

  const ahora = new Date();
  const actualizado = await db.transaction(async (tx) => {
    const [guardado] = await tx
      .update(payments)
      .set({ printCount: fila.printCount + 1, lastPrintedAt: ahora })
      .where(eq(payments.id, paymentId))
      .returning({
        id: payments.id,
        printCount: payments.printCount,
        lastPrintedAt: payments.lastPrintedAt,
      });
    if (guardado === undefined) throw new NotFoundError('Ese cobro no existe');

    await publish(tx, {
      topic: EVENT_TOPICS.paymentPrinted,
      aggregateId: paymentId,
      actor,
      payload: auditPayload({
        entityId: paymentId,
        action: 'payment_printed',
        entityType: 'payment',
        summary: `Recibo ${formatReceiptNumber(fila.receiptNumber)} impreso (${String(guardado.printCount)}.ª vez)`,
        changedFields: ['printCount'],
        before: { printCount: fila.printCount },
        after: { printCount: guardado.printCount },
        actor,
      }),
    });

    return guardado;
  });

  return resultado(actualizado.id, actualizado.printCount, actualizado.lastPrintedAt);
};
