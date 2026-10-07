import {
  findPaymentMethod,
  formatInvoiceNumber,
  formatReceiptNumber,
  igtfDecision,
  igtfToCollectCents,
  invoiceStatusForBalance,
  rateDateInCaracas,
  usdCentsFromVes,
  vesCentimosFromUsd,
  type BillingPayment,
  type BillingPaymentResult,
  type CollectPaymentInput,
  type ImputationPolicy,
  type VoidPaymentInput,
} from '@odontocrm/contracts';
import { EVENT_TOPICS } from '@odontocrm/events';
import { ConflictError, NotFoundError } from '@odontocrm/kernel';
import { buildStorageKey, type BlobStore } from '@odontocrm/storage';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';

import type { BillingDb } from '../db/client.js';
import { billingSettings, invoices, payments } from '../db/schema.js';
import { renderReceiptHtml } from '../documents/receipt-pdf.js';
import { rateStatus } from '../rates/rate-service.js';
import type { ActorContext } from '../shared/context.js';
import { auditPayload, publish } from '../shared/events.js';
import { getInvoice } from './invoice-service.js';
import { renderBillingPdf } from './render-pdf.js';

/**
 * Los **cobros** (ADR 0046 y 0048).
 *
 * Tres cosas se guardan siempre, y son las que hacen que el dinero cuadre:
 *
 * 1. **lo que el paciente entregó**, en la moneda del medio de pago (`tendered_amount`);
 * 2. la **tasa de este pago**, congelada, y la **política** con la que se imputó (B6): con
 *    `tasa_del_pago` el paciente paga en Bs al valor de hoy; con `tasa_de_la_factura` paga los Bs
 *    impresos y la clínica asume el diferencial;
 * 3. el **saldo**, que sale de restar y **nunca** se escribe a mano: el estado lo pone
 *    `invoiceStatusForBalance` (una sola verdad para el saldo y el estado).
 *
 * El recibo —el papel que se lleva el paciente— se archiva con su `sha256`, igual que la factura.
 */

export interface PaymentDeps {
  db: BillingDb;
  blobStore: BlobStore;
  pdf: { render: (html: string) => Promise<Buffer> };
}

/** El correlativo del recibo: la misma secuencia atómica que el resto. */
const nextReceiptNumber = async (db: BillingDb): Promise<number> => {
  const resultado = await db.execute(sql`select nextval('receipt_number_seq') as numero`);
  const fila = (resultado.rows[0] ?? {}) as { numero?: string | number };
  const numero = Number(fila.numero);
  if (!Number.isSafeInteger(numero) || numero <= 0) {
    throw new Error('la secuencia del número de recibo no devolvió un número');
  }
  return numero;
};

interface FilaPago {
  id: string;
  invoiceId: string;
  receiptNumber: number;
  method: string;
  tenderedAmount: number;
  tenderedCurrency: string;
  amountCentsUsd: number;
  exchangeRateMicros: number;
  imputationPolicy: string;
  fxDifferenceCentsUsd: number;
  appliesIgtf: boolean;
  igtfBasisPoints: number;
  igtfPerceivedBy: string | null;
  igtfAmountCentsUsd: number;
  igtfAmountVesCentimos: number;
  pdfSha256: string | null;
  receivedByUsername: string;
  createdAt: Date;
  voidedAt: Date | null;
  voidReason: string | null;
}

const aPago = (fila: FilaPago): BillingPayment => ({
  id: fila.id,
  receiptNumber: fila.receiptNumber,
  receiptLabel: formatReceiptNumber(fila.receiptNumber),
  // El `CHECK` de la tabla garantiza que son valores del contrato.
  method: fila.method as BillingPayment['method'],
  tenderedAmount: fila.tenderedAmount,
  tenderedCurrency: fila.tenderedCurrency as BillingPayment['tenderedCurrency'],
  amountCentsUsd: fila.amountCentsUsd,
  exchangeRateMicros: fila.exchangeRateMicros,
  imputationPolicy: fila.imputationPolicy as ImputationPolicy,
  fxDifferenceCentsUsd: fila.fxDifferenceCentsUsd,
  appliesIgtf: fila.appliesIgtf,
  igtfBasisPoints: fila.igtfBasisPoints,
  igtfPerceivedBy: fila.igtfPerceivedBy as BillingPayment['igtfPerceivedBy'],
  igtfAmountCentsUsd: fila.igtfAmountCentsUsd,
  igtfAmountVesCentimos: fila.igtfAmountVesCentimos,
  pdfSha256: fila.pdfSha256,
  receivedByUsername: fila.receivedByUsername,
  createdAt: fila.createdAt.toISOString(),
  voidedAt: fila.voidedAt?.toISOString() ?? null,
  voidReason: fila.voidReason,
});

const columnasPago = {
  id: payments.id,
  invoiceId: payments.invoiceId,
  receiptNumber: payments.receiptNumber,
  method: payments.method,
  tenderedAmount: payments.tenderedAmount,
  tenderedCurrency: payments.tenderedCurrency,
  amountCentsUsd: payments.amountCentsUsd,
  exchangeRateMicros: payments.exchangeRateMicros,
  imputationPolicy: payments.imputationPolicy,
  fxDifferenceCentsUsd: payments.fxDifferenceCentsUsd,
  appliesIgtf: payments.appliesIgtf,
  igtfBasisPoints: payments.igtfBasisPoints,
  igtfPerceivedBy: payments.igtfPerceivedBy,
  igtfAmountCentsUsd: payments.igtfAmountCentsUsd,
  igtfAmountVesCentimos: payments.igtfAmountVesCentimos,
  pdfSha256: payments.pdfSha256,
  receivedByUsername: payments.receivedByUsername,
  createdAt: payments.createdAt,
  voidedAt: payments.voidedAt,
  voidReason: payments.voidReason,
};

/** Los cobros de una factura, del más reciente al más viejo (los anulados se conservan). */
export const listInvoicePayments = async (
  db: BillingDb,
  invoiceId: string,
): Promise<BillingPayment[]> => {
  const filas = await db
    .select(columnasPago)
    .from(payments)
    .where(eq(payments.invoiceId, invoiceId))
    .orderBy(desc(payments.createdAt));
  return filas.map(aPago);
};

/** El saldo que sale de los cobros **vigentes**: la cuenta se rehace, no se arrastra. */
export const balanceFromPayments = async (db: BillingDb, invoiceId: string): Promise<number> => {
  const [fila] = await db
    .select({ cobrado: sql<number>`coalesce(sum(${payments.amountCentsUsd}), 0)::int` })
    .from(payments)
    .where(and(eq(payments.invoiceId, invoiceId), isNull(payments.voidedAt)));
  return Number(fila?.cobrado ?? 0);
};

export const collectPayment = async (
  deps: PaymentDeps,
  invoiceId: string,
  input: CollectPaymentInput,
  actor: ActorContext,
): Promise<BillingPaymentResult> => {
  const factura = await getInvoice(deps.db, invoiceId);
  if (factura.status === 'borrador') {
    throw new ConflictError('La factura todavía es un borrador: primero se emite', {
      extensions: { invoiceId },
    });
  }
  if (factura.status === 'anulada') {
    throw new ConflictError('La factura está anulada: no se le pueden registrar cobros', {
      extensions: { invoiceId },
    });
  }
  if (factura.balanceCentsUsd === 0) {
    throw new ConflictError('La factura ya está pagada', { extensions: { invoiceId } });
  }

  const [ajustes] = await deps.db.select().from(billingSettings).limit(1);
  const politica = (ajustes?.imputationPolicy ?? 'tasa_del_pago') as ImputationPolicy;
  const esSpe = ajustes?.isSpecialTaxpayer ?? false;

  // La tasa **del pago**: es la que manda para imputar (Convenio Cambiario Art. 8.a).
  const tasaDelDia = await rateStatus(deps.db, rateDateInCaracas());
  if (tasaDelDia.current === null) {
    throw new ConflictError('No hay ninguna tasa publicada: fíjala antes de cobrar', {
      extensions: { invoiceId },
    });
  }
  if (tasaDelDia.needsConfirmation && !input.confirmRate) {
    throw new ConflictError(
      `La tasa vigente es del ${tasaDelDia.current.rateDate} (${String(tasaDelDia.gapDays)} días): confírmala para cobrar`,
      { extensions: { rateDate: tasaDelDia.current.rateDate, gapDays: tasaDelDia.gapDays } },
    );
  }

  // La moneda la declara el **medio de pago** (el contrato), no un if suelto.
  const moneda: 'USD' | 'VES' = findPaymentMethod(input.method)?.currency ?? 'VES';
  const pendiente = factura.balanceCentsUsd;
  const tasaFactura = factura.exchangeRateMicros ?? tasaDelDia.current.rateMicros;

  /**
   * Lo que se imputa a la deuda, en céntimos de USD:
   *  - en divisas, lo entregado es lo imputado;
   *  - en bolívares, depende de la política: a la tasa del pago (lo que describe el Art. 8.a) o a la
   *    tasa impresa en la factura (el paciente paga exactamente los Bs del papel).
   */
  const amountCentsUsd =
    moneda === 'USD'
      ? input.tenderedAmount
      : usdCentsFromVes(
          input.tenderedAmount,
          politica === 'tasa_del_pago' ? tasaDelDia.current.rateMicros : tasaFactura,
        );

  if (amountCentsUsd > pendiente) {
    throw new ConflictError('El monto supera el saldo de la factura', {
      extensions: { balanceCentsUsd: pendiente, amountCentsUsd },
    });
  }

  // El diferencial es informativo: lo que el paciente pagó frente a lo que decía el papel.
  const enBsImpresos = vesCentimosFromUsd(amountCentsUsd, tasaFactura);
  const diferenciaBs = input.tenderedAmount - enBsImpresos;
  const fxDifferenceCentsUsd =
    moneda === 'USD' || diferenciaBs === 0
      ? 0
      : Math.sign(diferenciaBs) * usdCentsFromVes(Math.abs(diferenciaBs), tasaFactura);

  // El IGTF lo decide el medio y la calificación de la clínica (hoy: no SPE ⇒ no se percibe nada).
  const decision = igtfDecision({ method: input.method, isSpecialTaxpayer: esSpe, rule: null });
  const igtfAmountCentsUsd = igtfToCollectCents(decision, amountCentsUsd);

  const receiptNumber = await nextReceiptNumber(deps.db);
  const receiptLabel = formatReceiptNumber(receiptNumber);
  const paidAt = new Date();
  const nuevoSaldo = pendiente - amountCentsUsd;

  const html = renderReceiptHtml({
    receiptLabel,
    invoiceLabel:
      factura.invoiceNumber === null
        ? 'borrador'
        : formatInvoiceNumber(factura.series, factura.invoiceNumber),
    paidAt,
    patient: {
      name: factura.patientName,
      docType: factura.patientDocType,
      docNumber: factura.patientDocNumber,
    },
    method: input.method,
    tenderedAmount: input.tenderedAmount,
    tenderedCurrency: moneda,
    amountCentsUsd,
    rateMicros: tasaDelDia.current.rateMicros,
    imputationPolicy: politica,
    fxDifferenceCentsUsd,
    igtf: {
      applies: decision.applies,
      perceivedBy: decision.perceivedBy,
      basisPoints: decision.basisPoints,
      amountCentsUsd: igtfAmountCentsUsd,
      amountVesCentimos: vesCentimosFromUsd(igtfAmountCentsUsd, tasaDelDia.current.rateMicros),
    },
    totalCentsUsd: factura.totalCentsUsd,
    balanceCentsUsd: nuevoSaldo,
    receivedByUsername: actor.actorUsername ?? 'sistema',
  });
  const bytes = await renderBillingPdf(deps.pdf, html, 'el recibo');
  const archivo = await deps.blobStore.save({
    key: buildStorageKey('billing', invoiceId, `recibo-${receiptLabel}`, 'pdf'),
    data: bytes,
  });

  try {
    await deps.db.transaction(async (tx) => {
      const [pago] = await tx
        .insert(payments)
        .values({
          invoiceId,
          receiptNumber,
          method: input.method,
          reference: input.reference,
          tenderedAmount: input.tenderedAmount,
          tenderedCurrency: moneda,
          amountCentsUsd,
          exchangeRateMicros: tasaDelDia.current?.rateMicros ?? tasaFactura,
          imputationPolicy: politica,
          fxDifferenceCentsUsd,
          appliesIgtf: decision.applies,
          igtfBasisPoints: decision.applies ? decision.basisPoints : 0,
          igtfPerceivedBy: decision.perceivedBy,
          igtfAmountCentsUsd,
          igtfAmountVesCentimos: vesCentimosFromUsd(
            igtfAmountCentsUsd,
            tasaDelDia.current?.rateMicros ?? tasaFactura,
          ),
          pdfPath: archivo.path,
          pdfSha256: archivo.sha256,
          receivedByUserId: actor.actorId ?? '00000000-0000-0000-0000-000000000000',
          receivedByUsername: actor.actorUsername ?? 'sistema',
        })
        .returning();
      if (pago === undefined) throw new Error('no se pudo registrar el cobro');

      // El saldo y el estado salen de la resta y de la regla del contrato: una sola verdad.
      const estado = invoiceStatusForBalance(factura.totalCentsUsd, nuevoSaldo);
      await tx
        .update(invoices)
        .set({ balanceCentsUsd: nuevoSaldo, status: estado })
        .where(eq(invoices.id, invoiceId));

      await publish(tx, {
        topic: EVENT_TOPICS.paymentReceived,
        aggregateId: pago.id,
        actor,
        payload: {
          ...auditPayload({
            entityId: pago.id,
            action: 'payment_received',
            entityType: 'payment',
            summary: `Recibo ${receiptLabel}: ${moneda === 'USD' ? 'US$' : 'Bs.'} ${(input.tenderedAmount / 100).toFixed(2)} a ${factura.patientName}`,
            changedFields: ['balance_cents_usd', 'status'],
            before: { balanceCentsUsd: pendiente, status: factura.status },
            after: { balanceCentsUsd: nuevoSaldo, status: estado },
            reason: input.reference,
            actor,
          }),
          payment: {
            paymentId: pago.id,
            receiptNumber: receiptLabel,
            invoiceId,
            amountCentsUsd,
            tenderedAmount: input.tenderedAmount,
            tenderedCurrency: moneda,
            rateMicros: tasaDelDia.current?.rateMicros ?? tasaFactura,
            igtf: decision.applies ? decision.basisPoints : 0,
            balanceCentsUsd: nuevoSaldo,
          },
        },
      });
    });
  } catch (error) {
    await deps.blobStore.remove(archivo.path).catch(() => undefined);
    throw error;
  }

  const [guardado] = await deps.db
    .select(columnasPago)
    .from(payments)
    .where(eq(payments.receiptNumber, receiptNumber))
    .limit(1);
  if (guardado === undefined) throw new Error('no se pudo leer el cobro recién registrado');

  return {
    payment: aPago(guardado),
    invoice: {
      id: invoiceId,
      status: invoiceStatusForBalance(factura.totalCentsUsd, nuevoSaldo),
      totalCentsUsd: factura.totalCentsUsd,
      balanceCentsUsd: nuevoSaldo,
    },
  };
};

/**
 * Anula un cobro con motivo: se conserva, y el saldo de la factura **se rehace** desde los cobros que
 * siguen vigentes (no se suma de vuelta a mano). El estado retrocede solo (§9.10).
 */
export const voidPayment = async (
  deps: { db: BillingDb },
  paymentId: string,
  input: VoidPaymentInput,
  actor: ActorContext,
): Promise<BillingPaymentResult> => {
  const [fila] = await deps.db
    .select(columnasPago)
    .from(payments)
    .where(eq(payments.id, paymentId))
    .limit(1);
  if (fila === undefined) throw new NotFoundError('Ese cobro no existe');
  if (fila.voidedAt !== null) {
    throw new ConflictError('Ese cobro ya está anulado', { extensions: { paymentId } });
  }

  const [factura] = await deps.db
    .select({ id: invoices.id, total: invoices.totalCentsUsd, status: invoices.status })
    .from(invoices)
    .where(eq(invoices.id, fila.invoiceId))
    .limit(1);
  if (factura === undefined) throw new NotFoundError('La factura de ese cobro no existe');

  const nuevoSaldo = await deps.db.transaction(async (tx) => {
    await tx
      .update(payments)
      .set({
        voidedAt: new Date(),
        voidReason: input.reason,
        voidedByUserId: actor.actorId ?? '00000000-0000-0000-0000-000000000000',
      })
      .where(eq(payments.id, paymentId));

    // El saldo se rehace desde los cobros vigentes: si alguien anuló dos, el saldo sigue cuadrando.
    const [suma] = await tx
      .select({ cobrado: sql<number>`coalesce(sum(${payments.amountCentsUsd}), 0)::int` })
      .from(payments)
      .where(and(eq(payments.invoiceId, factura.id), isNull(payments.voidedAt)));
    const cobrado = Number(suma?.cobrado ?? 0);
    const saldo = factura.total - cobrado;
    const estado = invoiceStatusForBalance(factura.total, saldo);

    await tx
      .update(invoices)
      .set({ balanceCentsUsd: saldo, status: estado })
      .where(eq(invoices.id, factura.id));

    await publish(tx, {
      topic: EVENT_TOPICS.paymentVoided,
      aggregateId: paymentId,
      actor,
      payload: {
        ...auditPayload({
          entityId: paymentId,
          action: 'payment_voided',
          entityType: 'payment',
          summary: `Cobro ${formatReceiptNumber(fila.receiptNumber)} anulado`,
          changedFields: ['voided_at'],
          before: { voidedAt: null, amountCentsUsd: fila.amountCentsUsd },
          after: { voidedAt: new Date().toISOString(), balanceCentsUsd: saldo, status: estado },
          reason: input.reason,
          actor,
        }),
        payment: {
          paymentId,
          invoiceId: factura.id,
          amountCentsUsd: fila.amountCentsUsd,
          balanceCentsUsd: saldo,
        },
      },
    });

    return saldo;
  });

  const [actualizado] = await deps.db
    .select(columnasPago)
    .from(payments)
    .where(eq(payments.id, paymentId))
    .limit(1);
  if (actualizado === undefined) throw new Error('no se pudo leer el cobro anulado');

  return {
    payment: aPago(actualizado),
    invoice: {
      id: factura.id,
      status: invoiceStatusForBalance(factura.total, nuevoSaldo),
      totalCentsUsd: factura.total,
      balanceCentsUsd: nuevoSaldo,
    },
  };
};
