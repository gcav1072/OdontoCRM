import {
  formatCreditNoteNumber,
  formatInvoiceNumber,
  formatReceiptNumber,
  paymentMethodLabel,
  rangoDelMes,
  rateDateInCaracas,
  type BookQuery,
  type ExchangeDiffBookRow,
  type ExchangeDiffSummary,
  type IgtfBookRow,
  type IgtfSummary,
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

/**
 * El rango efectivo: lo pedido o, por defecto, el **mes en curso** de Caracas.
 *
 * El cálculo del mes (y del fin de mes) vive en el contrato (`rangoDelMes`): la pantalla propone el
 * mismo período con esa función, así que el libro que se descarga y el que se ve en pantalla no
 * pueden caer en meses distintos por una cuenta repetida.
 */
export const rangoDelLibro = (
  query: BookQuery,
  hoy: string = rateDateInCaracas(),
): { from: string; to: string } => {
  const mes = rangoDelMes(hoy);
  return { from: query.from ?? mes.from, to: query.to ?? mes.to };
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

/* ── El diferencial cambiario y el destino del IGTF (ADR 0069, Escuela A) ──── */

/** El día del cobro en este libro es su **Fecha Valor** (el devengado), no el del tecleo. */
const diaDeCobro = sql`${payments.effectiveDate}`;

/**
 * El **Estado de Ganancias y Pérdidas por Diferencial Cambiario**: una fila por cobro vigente (un
 * cobro anulado no «realizó» nada) y una por **reversión por reembolso** (la Nota de Crédito que
 * deshizo el diferencial). La suma de `diferencialBs` es el neto del período.
 */
export const exchangeDiffBookRows = async (
  db: BillingDb,
  rango: { from: string; to: string },
): Promise<ExchangeDiffBookRow[]> => {
  const cobros = await db
    .select({
      effectiveDate: payments.effectiveDate,
      receiptNumber: payments.receiptNumber,
      exchangeRateMicros: payments.exchangeRateMicros,
      exchangeDiffVesCentimos: payments.exchangeDiffVesCentimos,
      series: invoices.series,
      invoiceNumber: invoices.invoiceNumber,
    })
    .from(payments)
    .innerJoin(invoices, sql`${invoices.id} = ${payments.invoiceId}`)
    .where(
      sql`${payments.voidedAt} is null
        and ${diaDeCobro} between ${rango.from}::date and ${rango.to}::date`,
    )
    .orderBy(payments.effectiveDate);

  const filas: ExchangeDiffBookRow[] = cobros.map((fila) => ({
    fecha: fila.effectiveDate,
    documento: `${formatReceiptNumber(fila.receiptNumber)} · ${
      fila.invoiceNumber === null
        ? '(sin número)'
        : formatInvoiceNumber(fila.series, fila.invoiceNumber)
    }`,
    concepto: 'Cobro',
    tasa: tasaEnUnidades(fila.exchangeRateMicros),
    diferencialBs: unidades(fila.exchangeDiffVesCentimos),
  }));

  const notas = await db
    .select({
      creditNoteNumber: creditNotes.creditNoteNumber,
      issuedAt: creditNotes.issuedAt,
      exchangeRateMicros: creditNotes.exchangeRateMicros,
      reversed: creditNotes.reversedExchangeDiffVesCentimos,
    })
    .from(creditNotes)
    .where(
      sql`${creditNotes.cancellationType} = 'REFUND'
        and (${creditNotes.issuedAt} at time zone 'America/Caracas')::date
          between ${rango.from}::date and ${rango.to}::date`,
    )
    .orderBy(creditNotes.issuedAt);

  for (const nota of notas) {
    filas.push({
      fecha: diaEnCaracas(nota.issuedAt),
      documento: formatCreditNoteNumber(nota.creditNoteNumber),
      concepto: 'Reversión por reembolso',
      tasa: tasaEnUnidades(nota.exchangeRateMicros),
      diferencialBs: unidades(nota.reversed),
    });
  }

  return filas.sort((a, b) => a.fecha.localeCompare(b.fecha));
};

/**
 * El resumen del período, en céntimos enteros (nunca sobre los números impresos):
 * `Neto = Σ Ganancias − Σ Pérdidas + Σ Reversiones por reembolso` (ADR 0069).
 */
export const exchangeDiffSummary = async (
  db: BillingDb,
  rango: { from: string; to: string },
): Promise<ExchangeDiffSummary> => {
  const [pagos] = await db
    .select({
      ganancias: sql<number>`coalesce(sum(case when ${payments.exchangeDiffVesCentimos} > 0
        then ${payments.exchangeDiffVesCentimos} else 0 end), 0)::bigint`,
      perdidas: sql<number>`coalesce(sum(case when ${payments.exchangeDiffVesCentimos} < 0
        then -${payments.exchangeDiffVesCentimos} else 0 end), 0)::bigint`,
    })
    .from(payments)
    .where(
      sql`${payments.voidedAt} is null
        and ${diaDeCobro} between ${rango.from}::date and ${rango.to}::date`,
    );
  const [notas] = await db
    .select({
      reversiones: sql<number>`coalesce(sum(${creditNotes.reversedExchangeDiffVesCentimos}), 0)::bigint`,
    })
    .from(creditNotes)
    .where(
      sql`${creditNotes.cancellationType} = 'REFUND'
        and (${creditNotes.issuedAt} at time zone 'America/Caracas')::date
          between ${rango.from}::date and ${rango.to}::date`,
    );

  const ganancias = Number(pagos?.ganancias ?? 0);
  const perdidas = Number(pagos?.perdidas ?? 0);
  const reversiones = Number(notas?.reversiones ?? 0);
  return {
    gananciasVesCentimos: ganancias,
    perdidasVesCentimos: perdidas,
    reversionesVesCentimos: reversiones,
    netoVesCentimos: ganancias - perdidas + reversiones,
  };
};

/**
 * El **Reporte de Percepción IGTF y Destino de Caja**: lo que la clínica percibió (la base y el
 * tributo, para la declaración SENIAT) y el **arqueo físico** separado —Caja Divisas contra
 * Banco/Caja Bs.— de la misma percepción. Lo que debita el banco no entra: no pasó por la caja.
 */
export const igtfSummary = async (
  db: BillingDb,
  rango: { from: string; to: string },
): Promise<IgtfSummary> => {
  const [fila] = await db
    .select({
      baseDivisasCentsUsd: sql<number>`coalesce(sum(case when ${payments.igtfCollectedCurrency} is not null
        then ${payments.amountCentsUsd} else 0 end), 0)::bigint`,
      igtfCentsUsd: sql<number>`coalesce(sum(${payments.igtfAmountCentsUsd}), 0)::bigint`,
      igtfVesCentimos: sql<number>`coalesce(sum(${payments.igtfAmountVesCentimos}), 0)::bigint`,
      igtfCajaDivisasCentsUsd: sql<number>`coalesce(sum(case when ${payments.igtfCollectedCurrency} = 'USD'
        then ${payments.igtfAmountCentsUsd} else 0 end), 0)::bigint`,
      igtfCajaBsVesCentimos: sql<number>`coalesce(sum(case when ${payments.igtfCollectedCurrency} = 'VES'
        then ${payments.igtfAmountVesCentimos} else 0 end), 0)::bigint`,
    })
    .from(payments)
    .where(
      sql`${payments.appliesIgtf} = true and ${payments.voidedAt} is null
        and (${payments.createdAt} at time zone 'America/Caracas')::date
          between ${rango.from}::date and ${rango.to}::date`,
    );

  return {
    baseDivisasCentsUsd: Number(fila?.baseDivisasCentsUsd ?? 0),
    igtfCentsUsd: Number(fila?.igtfCentsUsd ?? 0),
    igtfVesCentimos: Number(fila?.igtfVesCentimos ?? 0),
    igtfCajaDivisasCentsUsd: Number(fila?.igtfCajaDivisasCentsUsd ?? 0),
    igtfCajaBsVesCentimos: Number(fila?.igtfCajaBsVesCentimos ?? 0),
  };
};
