import {
  formatCreditNoteNumber,
  formatInvoiceNumber,
  formatReceiptNumber,
} from '@odontocrm/contracts';
import { NotFoundError } from '@odontocrm/kernel';
import type { BlobStore } from '@odontocrm/storage';
import { eq } from 'drizzle-orm';

import type { BillingDb } from '../db/client.js';
import { creditNotes, invoices, payments } from '../db/schema.js';

/**
 * Los **documentos archivados** (ADR 0048): la factura, el recibo y la nota de crédito.
 *
 * Se guardan como PDF en el almacén y **lo que se reimprime es ese archivo**, no una composición
 * nueva: si el membrete cambia, lo ya emitido sigue diciendo lo que decía. Aquí solo se leen.
 *
 * Un borrador no tiene PDF y un documento sin archivo no existe para el mostrador: los dos casos
 * responden «no hay nada que descargar» en vez de devolver un archivo vacío.
 */

export interface DocumentoArchivado {
  bytes: Buffer;
  /** Nombre del archivo, ya saneado para una cabecera HTTP. */
  filename: string;
}

/** Nada que no sea `[0-9A-Za-z._-]`: el valor viaja a `content-disposition`. */
const nombreSeguro = (base: string): string => {
  const limpio = base.replace(/[^0-9A-Za-z._-]/g, '-');
  return `${limpio.length > 0 ? limpio : 'documento'}.pdf`;
};

const leer = async (
  blobStore: BlobStore,
  ruta: string | null,
  filename: string,
): Promise<DocumentoArchivado> => {
  if (ruta === null) throw new NotFoundError('Ese documento todavía no tiene PDF archivado');
  return { bytes: await blobStore.read(ruta), filename };
};

/** La factura emitida, tal como se archivó. */
export const facturaArchivada = async (
  db: BillingDb,
  blobStore: BlobStore,
  invoiceId: string,
): Promise<DocumentoArchivado> => {
  const [fila] = await db
    .select({
      pdfPath: invoices.pdfPath,
      series: invoices.series,
      invoiceNumber: invoices.invoiceNumber,
    })
    .from(invoices)
    .where(eq(invoices.id, invoiceId))
    .limit(1);
  if (fila === undefined) throw new NotFoundError('Esa factura no existe');

  const etiqueta =
    fila.invoiceNumber === null ? 'borrador' : formatInvoiceNumber(fila.series, fila.invoiceNumber);
  return leer(blobStore, fila.pdfPath, nombreSeguro(`factura-${etiqueta}`));
};

/** El recibo de un cobro. */
export const reciboArchivado = async (
  db: BillingDb,
  blobStore: BlobStore,
  paymentId: string,
): Promise<DocumentoArchivado> => {
  const [fila] = await db
    .select({ pdfPath: payments.pdfPath, receiptNumber: payments.receiptNumber })
    .from(payments)
    .where(eq(payments.id, paymentId))
    .limit(1);
  if (fila === undefined) throw new NotFoundError('Ese cobro no existe');
  return leer(
    blobStore,
    fila.pdfPath,
    nombreSeguro(`recibo-${formatReceiptNumber(fila.receiptNumber)}`),
  );
};

/** La nota de crédito que deja sin efecto una factura. */
export const notaCreditoArchivada = async (
  db: BillingDb,
  blobStore: BlobStore,
  creditNoteId: string,
): Promise<DocumentoArchivado> => {
  const [fila] = await db
    .select({ pdfPath: creditNotes.pdfPath, creditNoteNumber: creditNotes.creditNoteNumber })
    .from(creditNotes)
    .where(eq(creditNotes.id, creditNoteId))
    .limit(1);
  if (fila === undefined) throw new NotFoundError('Esa nota de crédito no existe');
  return leer(
    blobStore,
    fila.pdfPath,
    nombreSeguro(`nota-credito-${formatCreditNoteNumber(fila.creditNoteNumber)}`),
  );
};
