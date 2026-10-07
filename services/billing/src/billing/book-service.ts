import {
  formatCreditNoteNumber,
  formatInvoiceNumber,
  formatReceiptNumber,
  paymentMethodLabel,
  rateDateInCaracas,
  type BookQuery,
  type IgtfBookRow,
  type SalesBookRow,
} from '@odontocrm/contracts';
import { sql } from 'drizzle-orm';

import type { BillingDb } from '../db/client.js';
import { creditNotes, invoices, payments } from '../db/schema.js';

/**
 * Los **libros fiscales** (Art. 75 de la Providencia 0071): el de ventas y el de IGTF.
 *
 * Dos decisiones que hacen que el libro sirva para lo que sirve:
 *
 * - el día de la operación es el de **Caracas**, no el del reloj del servidor ni el de UTC: se filtra
 *   por `(fecha at time zone 'America/Caracas')::date`, que es lo que el contador cuadra contra el
 *   papel;
 * - la **nota de crédito** entra como una fila propia, con el monto en **negativo** y el desglose de
 *   la factura que deja sin efecto. Así el período cuenta lo que pasó (la factura y su nota) en vez de
 *   esconder la operación anulada, y el total del libro cuadra con la realidad.
 */

/** El último día del mes de `aaaa-mm` (el mes en curso del libro, si no se pide rango). */
const ultimoDiaDelMes = (mes: string): string => {
  const [anio = '1970', numeroMes = '1'] = mes.split('-');
  const dias = new Date(Date.UTC(Number(anio), Number(numeroMes), 0)).getUTCDate();
  return `${mes}-${String(dias).padStart(2, '0')}`;
};

/** El rango efectivo: lo pedido o, por defecto, el **mes en curso** de Caracas. */
export const rangoDelLibro = (
  query: BookQuery,
  hoy: string = rateDateInCaracas(),
): { from: string; to: string } => {
  const mes = hoy.slice(0, 7);
  return {
    from: query.from ?? `${mes}-01`,
    to: query.to ?? ultimoDiaDelMes(mes),
  };
};

/** El día de Caracas de un instante, en `aaaa-mm-dd`. */
export const diaEnCaracas = (fecha: Date): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Caracas',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(fecha);

/** Céntimos → unidades, que es como se imprime el dinero en el libro. */
const unidades = (cents: number): number => Number((cents / 100).toFixed(2));
/** Micros → Bs./US$, con los cuatro decimales de una tasa. */
const tasaEnUnidades = (micros: number): number => Number((micros / 1_000_000).toFixed(4));

export const salesBookRows = async (
  db: BillingDb,
  rango: { from: string; to: string },
): Promise<SalesBookRow[]> => {
  const facturas = await db
    .select({
      series: invoices.series,
      invoiceNumber: invoices.invoiceNumber,
      controlNumber: invoices.controlNumber,
      issuedAt: invoices.issuedAt,
      patientName: invoices.patientName,
      patientDocType: invoices.patientDocType,
      patientDocNumber: invoices.patientDocNumber,
      patientTaxId: invoices.patientTaxId,
      exemptAmountCentsUsd: invoices.exemptAmountCentsUsd,
      taxableAmountCentsUsd: invoices.taxableAmountCentsUsd,
      ivaAmountCentsUsd: invoices.ivaAmountCentsUsd,
      totalCentsUsd: invoices.totalCentsUsd,
      totalVesCentimos: invoices.totalVesCentimos,
      exchangeRateMicros: invoices.exchangeRateMicros,
      status: invoices.status,
    })
    .from(invoices)
    .where(
      sql`(${invoices.issuedAt} at time zone 'America/Caracas')::date
        between ${rango.from}::date and ${rango.to}::date`,
    )
    .orderBy(invoices.issuedAt);

  const filas: SalesBookRow[] = facturas.map((fila) => ({
    fecha: fila.issuedAt === null ? '' : diaEnCaracas(fila.issuedAt),
    documento:
      fila.invoiceNumber === null
        ? '(sin número)'
        : formatInvoiceNumber(fila.series, fila.invoiceNumber),
    control: fila.controlNumber ?? '',
    cliente: fila.patientName,
    rif: fila.patientTaxId ?? `${fila.patientDocType}-${fila.patientDocNumber}`,
    exento: unidades(fila.exemptAmountCentsUsd),
    base16: unidades(fila.taxableAmountCentsUsd),
    iva: unidades(fila.ivaAmountCentsUsd),
    total: unidades(fila.totalCentsUsd),
    tasa: fila.exchangeRateMicros === null ? 0 : tasaEnUnidades(fila.exchangeRateMicros),
    totalBs: unidades(fila.totalVesCentimos),
    estado: fila.status,
  }));

  // Las notas de crédito del período, con el monto en negativo y el desglose de su factura.
  const notas = await db
    .select({
      creditNoteNumber: creditNotes.creditNoteNumber,
      issuedAt: creditNotes.issuedAt,
      reason: creditNotes.reason,
      totalCentsUsd: creditNotes.totalCentsUsd,
      totalVesCentimos: creditNotes.totalVesCentimos,
      exchangeRateMicros: creditNotes.exchangeRateMicros,
      invoiceNumber: creditNotes.invoiceNumber,
      series: invoices.series,
      controlNumber: invoices.controlNumber,
      patientName: invoices.patientName,
      patientDocType: invoices.patientDocType,
      patientDocNumber: invoices.patientDocNumber,
      patientTaxId: invoices.patientTaxId,
      exemptAmountCentsUsd: invoices.exemptAmountCentsUsd,
      taxableAmountCentsUsd: invoices.taxableAmountCentsUsd,
      ivaAmountCentsUsd: invoices.ivaAmountCentsUsd,
    })
    .from(creditNotes)
    .innerJoin(invoices, sql`${invoices.id} = ${creditNotes.invoiceId}`)
    .where(
      sql`(${creditNotes.issuedAt} at time zone 'America/Caracas')::date
        between ${rango.from}::date and ${rango.to}::date`,
    )
    .orderBy(creditNotes.issuedAt);

  for (const nota of notas) {
    filas.push({
      fecha: diaEnCaracas(nota.issuedAt),
      documento: formatCreditNoteNumber(nota.creditNoteNumber),
      control: nota.controlNumber ?? '',
      cliente: nota.patientName,
      rif: nota.patientTaxId ?? `${nota.patientDocType}-${nota.patientDocNumber}`,
      exento: -unidades(nota.exemptAmountCentsUsd),
      base16: -unidades(nota.taxableAmountCentsUsd),
      iva: -unidades(nota.ivaAmountCentsUsd),
      total: -unidades(nota.totalCentsUsd),
      tasa: tasaEnUnidades(nota.exchangeRateMicros),
      totalBs: -unidades(nota.totalVesCentimos),
      estado: `nota de crédito de ${formatInvoiceNumber(nota.series, nota.invoiceNumber)}`,
    });
  }

  return filas.sort((a, b) => a.fecha.localeCompare(b.fecha));
};

export const igtfBookRows = async (
  db: BillingDb,
  rango: { from: string; to: string },
): Promise<IgtfBookRow[]> => {
  const filas = await db
    .select({
      createdAt: payments.createdAt,
      receiptNumber: payments.receiptNumber,
      method: payments.method,
      tenderedAmount: payments.tenderedAmount,
      igtfBasisPoints: payments.igtfBasisPoints,
      igtfPerceivedBy: payments.igtfPerceivedBy,
      igtfAmountCentsUsd: payments.igtfAmountCentsUsd,
      igtfAmountVesCentimos: payments.igtfAmountVesCentimos,
      series: invoices.series,
      invoiceNumber: invoices.invoiceNumber,
    })
    .from(payments)
    .innerJoin(invoices, sql`${invoices.id} = ${payments.invoiceId}`)
    .where(
      sql`${payments.appliesIgtf} = true
        and (${payments.createdAt} at time zone 'America/Caracas')::date
          between ${rango.from}::date and ${rango.to}::date`,
    )
    .orderBy(payments.createdAt);

  return filas.map((fila) => ({
    fecha: diaEnCaracas(fila.createdAt),
    recibo: formatReceiptNumber(fila.receiptNumber),
    factura:
      fila.invoiceNumber === null
        ? '(sin número)'
        : formatInvoiceNumber(fila.series, fila.invoiceNumber),
    medio: paymentMethodLabel(fila.method),
    monto: unidades(fila.tenderedAmount),
    alicuota: Number((fila.igtfBasisPoints / 100).toFixed(2)),
    percibidoPor: fila.igtfPerceivedBy ?? '',
    igtf: unidades(fila.igtfAmountCentsUsd),
    igtfBs: unidades(fila.igtfAmountVesCentimos),
  }));
};
