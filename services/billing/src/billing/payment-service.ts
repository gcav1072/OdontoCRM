import {
  bsPaymentBreakdown,
  divisasPaymentBreakdown,
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
  type IgtfCollectedCurrency,
  type ImputationPolicy,
  type VoidPaymentInput,
} from '@odontocrm/contracts';
import { EVENT_TOPICS } from '@odontocrm/events';
import { ConflictError, NotFoundError } from '@odontocrm/kernel';
import type { BrandLookup, LetterheadLookup } from '@odontocrm/kernel';
import { buildStorageKey, type BlobStore } from '@odontocrm/storage';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';

import type { BillingDb } from '../db/client.js';
import { billingSettings, invoices, payments } from '../db/schema.js';
import { renderReceiptHtml } from '../documents/receipt-pdf.js';
import { rateForDate, rateStatus } from '../rates/rate-service.js';
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
  /** La identidad del consultorio (ADR 0056); sin ella, el miembrete usa `CLINIC`. */
  letterheadLookup?: LetterheadLookup | undefined;
  /** La marca efectiva de los imprimibles (ADR 0060); sin ella, se usa `BRAND`. */
  brandLookup?: BrandLookup | undefined;
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
  effectiveDate: string;
  historicalVesCentimos: number;
  exchangeDiffVesCentimos: number;
  fxDifferenceCentsUsd: number;
  appliesIgtf: boolean;
  igtfBasisPoints: number;
  igtfPerceivedBy: string | null;
  igtfAmountCentsUsd: number;
  igtfAmountVesCentimos: number;
  igtfCollectedCurrency: string | null;
  igtfPaymentMethod: string | null;
  igtfPaymentReference: string | null;
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
  effectiveDate: fila.effectiveDate,
  historicalVesCentimos: fila.historicalVesCentimos,
  exchangeDiffVesCentimos: fila.exchangeDiffVesCentimos,
  fxDifferenceCentsUsd: fila.fxDifferenceCentsUsd,
  appliesIgtf: fila.appliesIgtf,
  igtfBasisPoints: fila.igtfBasisPoints,
  igtfPerceivedBy: fila.igtfPerceivedBy as BillingPayment['igtfPerceivedBy'],
  igtfAmountCentsUsd: fila.igtfAmountCentsUsd,
  igtfAmountVesCentimos: fila.igtfAmountVesCentimos,
  igtfCollectedCurrency: fila.igtfCollectedCurrency as IgtfCollectedCurrency | null,
  igtfPaymentMethod: fila.igtfPaymentMethod,
  igtfPaymentReference: fila.igtfPaymentReference,
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
  effectiveDate: payments.effectiveDate,
  historicalVesCentimos: payments.historicalAmountVesCentimos,
  exchangeDiffVesCentimos: payments.exchangeDiffVesCentimos,
  fxDifferenceCentsUsd: payments.fxDifferenceCentsUsd,
  appliesIgtf: payments.appliesIgtf,
  igtfBasisPoints: payments.igtfBasisPoints,
  igtfPerceivedBy: payments.igtfPerceivedBy,
  igtfAmountCentsUsd: payments.igtfAmountCentsUsd,
  igtfAmountVesCentimos: payments.igtfAmountVesCentimos,
  igtfCollectedCurrency: payments.igtfCollectedCurrency,
  igtfPaymentMethod: payments.igtfPaymentMethod,
  igtfPaymentReference: payments.igtfPaymentReference,
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

/**
 * Los acumuladores de caja de una factura (ADR 0069), solo de cobros **vigentes**: `Σ histórico`
 * cuadra con `totalVesCentimos` del documento, `Σ diferencial` es la ganancia/pérdida cambiaria
 * realizada y `Σ real` (= histórico + diferencial) es lo que entró a caja o banco valorado en Bs.
 */
export const invoicePaymentTotals = async (
  db: BillingDb,
  invoiceId: string,
): Promise<{
  totalHistoricalPaidVesCentimos: number;
  totalActualPaidVesCentimos: number;
  totalExchangeDiffVesCentimos: number;
  totalIgtfCentsUsd: number;
  totalIgtfVesCentimos: number;
}> => {
  const [fila] = await db
    .select({
      historical: sql<number>`coalesce(sum(${payments.historicalAmountVesCentimos}), 0)::bigint`,
      diferencial: sql<number>`coalesce(sum(${payments.exchangeDiffVesCentimos}), 0)::bigint`,
      igtfCentsUsd: sql<number>`coalesce(sum(${payments.igtfAmountCentsUsd}), 0)::bigint`,
      igtfVes: sql<number>`coalesce(sum(${payments.igtfAmountVesCentimos}), 0)::bigint`,
    })
    .from(payments)
    .where(and(eq(payments.invoiceId, invoiceId), isNull(payments.voidedAt)));
  const historical = Number(fila?.historical ?? 0);
  const diferencial = Number(fila?.diferencial ?? 0);
  return {
    totalHistoricalPaidVesCentimos: historical,
    totalActualPaidVesCentimos: historical + diferencial,
    totalExchangeDiffVesCentimos: diferencial,
    totalIgtfCentsUsd: Number(fila?.igtfCentsUsd ?? 0),
    totalIgtfVesCentimos: Number(fila?.igtfVes ?? 0),
  };
};

/**
 * Cuántos bolívares debe el paciente **si paga hoy**: el saldo en USD a la tasa BCV vigente. Si hoy
 * no hay tasa publicada (o ninguna hasta hoy), se usa la **congelada de la factura**: peor es dejar
 * la caja sin un monto que transferir.
 */
export const currentDebtAtTodayRate = async (
  db: BillingDb,
  factura: { balanceCentsUsd: number; exchangeRateMicros: number | null },
): Promise<number> => {
  const vigente = await rateForDate(db, rateDateInCaracas());
  const tasa =
    (vigente?.rate.rateMicros ?? 0) > 0
      ? (vigente?.rate.rateMicros ?? 0)
      : (factura.exchangeRateMicros ?? 0);
  return tasa > 0 ? vesCentimosFromUsd(factura.balanceCentsUsd, tasa) : 0;
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

  /**
   * La **Fecha Valor** (ADR 0069): el día del comprobante bancario, por defecto el de Caracas al
   * registrar. Nunca futura y nunca anterior a la emisión de la factura: la tasa que se congela es la
   * vigente para **esta** fecha —la del viernes en un pago móvil del domingo, que es lo que dice el
   * comprobante—.
   */
  const hoy = rateDateInCaracas();
  const effectiveDate = input.effectiveDate ?? hoy;
  if (effectiveDate > hoy) {
    throw new ConflictError('La fecha valor no puede ser futura', {
      extensions: { effectiveDate, today: hoy },
    });
  }
  const [emision] = await deps.db
    .select({ issuedAt: invoices.issuedAt })
    .from(invoices)
    .where(eq(invoices.id, invoiceId))
    .limit(1);
  const diaEmision = emision?.issuedAt == null ? null : rateDateInCaracas(emision.issuedAt);
  if (diaEmision !== null && effectiveDate < diaEmision) {
    throw new ConflictError('La fecha valor no puede ser anterior a la emisión de la factura', {
      extensions: { effectiveDate, issueDate: diaEmision },
    });
  }

  // La tasa **del pago**: la vigente para la Fecha Valor (Convenio Cambiario Art. 8.a).
  const tasaDelDia = await rateStatus(deps.db, effectiveDate);
  if (tasaDelDia.current === null) {
    throw new ConflictError('No hay ninguna tasa publicada: fíjala antes de cobrar', {
      extensions: { invoiceId, effectiveDate },
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
   * La tasa que valoriza este cobro: la de la Fecha Valor, salvo con la política
   * `tasa_de_la_factura`, en la que el paciente paga exactamente los Bs impresos.
   */
  const tasaPago = politica === 'tasa_del_pago' ? tasaDelDia.current.rateMicros : tasaFactura;

  /**
   * La descomposición del cobro (ADR 0069), en un solo sitio del contrato: lo imputado, lo histórico
   * (a la tasa de emisión) y el diferencial cambiario. En bolívares manda la tolerancia de ±5 céntimos
   * de USD —un Pago Móvil en bolívares enteros deja residuos, y absorberlos cierra la deuda al 100 %
   * en vez de dejar un saldo zombi—; en divisas, sobrepago es sobrepago.
   */
  const desglose =
    moneda === 'USD'
      ? divisasPaymentBreakdown({
          tenderedCentsUsd: input.tenderedAmount,
          balanceCentsUsd: pendiente,
          rateEmissionMicros: tasaFactura,
        })
      : bsPaymentBreakdown({
          tenderedVesCentimos: input.tenderedAmount,
          balanceCentsUsd: pendiente,
          rateEmissionMicros: tasaFactura,
          ratePaymentMicros: tasaPago,
        });
  if (desglose === null) {
    throw new ConflictError('El monto supera el saldo de la factura', {
      extensions: { balanceCentsUsd: pendiente, tenderedAmount: input.tenderedAmount },
    });
  }
  const amountCentsUsd = desglose.amountCentsUsd;
  if (amountCentsUsd <= 0) {
    throw new ConflictError('El monto entregado no alcanza un céntimo de dólar', {
      extensions: { tenderedAmount: input.tenderedAmount },
    });
  }
  const historicalVesCentimos = desglose.historicalVesCentimos;
  const exchangeDiffVesCentimos = desglose.exchangeDiffVesCentimos;

  // El diferencial en USD es informativo (lo que el paciente pagó frente a lo impreso en el papel).
  const diferenciaBs = moneda === 'USD' ? 0 : input.tenderedAmount - historicalVesCentimos;
  const fxDifferenceCentsUsd =
    moneda === 'USD' || diferenciaBs === 0
      ? 0
      : Math.sign(diferenciaBs) * usdCentsFromVes(Math.abs(diferenciaBs), tasaFactura);

  /**
   * El IGTF lo decide el medio y la calificación de la clínica (ADR 0045), con la alícuota de la
   * configuración (ADR 0069). Cuando lo **percibe la clínica**, el cajero declara en qué moneda lo
   * entregó el paciente: en divisas entra con la base a Caja Divisas; en bolívares, convertido a la
   * tasa de la Fecha Valor, entra a Banco/Caja Bs. con su comprobante.
   */
  const decision = igtfDecision({
    method: input.method,
    isSpecialTaxpayer: esSpe,
    rule: null,
    basisPoints: ajustes?.igtfRateBp,
  });
  const loPercibeLaClinica = decision.applies && decision.perceivedBy === 'clinica';
  if (loPercibeLaClinica && input.igtfCollectedCurrency === undefined) {
    throw new ConflictError(
      'Declara en qué moneda entregó el paciente el IGTF: en divisas (Caja Divisas) o en bolívares (Banco/Caja Bs.)',
      { extensions: { invoiceId, igtfBasisPoints: decision.basisPoints } },
    );
  }
  if (!loPercibeLaClinica && input.igtfCollectedCurrency !== undefined) {
    throw new ConflictError(
      'Este cobro no tiene IGTF que percibir en caja: quita la moneda declarada',
      {
        extensions: { invoiceId, perceivedBy: decision.perceivedBy },
      },
    );
  }
  const igtfAmountCentsUsd = igtfToCollectCents(decision, amountCentsUsd);
  const igtfCollectedCurrency: IgtfCollectedCurrency | null = loPercibeLaClinica
    ? (input.igtfCollectedCurrency ?? null)
    : null;
  const igtfPaymentMethod =
    igtfCollectedCurrency === 'VES' ? (input.igtfPaymentMethod ?? null) : null;
  const igtfPaymentReference =
    igtfCollectedCurrency === 'VES' ? (input.igtfPaymentReference ?? null) : null;

  const receiptNumber = await nextReceiptNumber(deps.db);
  const receiptLabel = formatReceiptNumber(receiptNumber);
  const paidAt = new Date();
  const nuevoSaldo = pendiente - amountCentsUsd;
  const identidad = deps.letterheadLookup === undefined ? null : await deps.letterheadLookup();
  const marca = deps.brandLookup === undefined ? null : await deps.brandLookup();

  const html = await renderReceiptHtml({
    clinic: identidad?.clinic,
    logoDataUri: identidad?.logoDataUri ?? null,
    dentist: identidad?.dentist ?? null,
    brand: marca?.theme ?? null,
    fontFaceCss: marca?.fontFaceCss ?? null,
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
    rateEmissionMicros: tasaFactura,
    effectiveDate,
    historicalVesCentimos,
    exchangeDiffVesCentimos,
    imputationPolicy: politica,
    fxDifferenceCentsUsd,
    igtf: {
      applies: decision.applies,
      perceivedBy: decision.perceivedBy,
      basisPoints: decision.basisPoints,
      amountCentsUsd: igtfAmountCentsUsd,
      amountVesCentimos: vesCentimosFromUsd(igtfAmountCentsUsd, tasaDelDia.current.rateMicros),
      collectedCurrency: igtfCollectedCurrency,
      paymentMethod: igtfPaymentMethod,
      paymentReference: igtfPaymentReference,
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
          effectiveDate,
          historicalAmountVesCentimos: historicalVesCentimos,
          exchangeDiffVesCentimos,
          fxDifferenceCentsUsd,
          appliesIgtf: decision.applies,
          igtfBasisPoints: decision.applies ? decision.basisPoints : 0,
          igtfPerceivedBy: decision.perceivedBy,
          igtfAmountCentsUsd,
          igtfAmountVesCentimos: vesCentimosFromUsd(
            igtfAmountCentsUsd,
            tasaDelDia.current?.rateMicros ?? tasaFactura,
          ),
          igtfCollectedCurrency,
          igtfPaymentMethod,
          igtfPaymentReference,
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
            effectiveDate,
            historicalVesCentimos,
            exchangeDiffVesCentimos,
            igtf: decision.applies ? decision.basisPoints : 0,
            igtfAmountCentsUsd,
            igtfAmountVesCentimos: vesCentimosFromUsd(
              igtfAmountCentsUsd,
              tasaDelDia.current?.rateMicros ?? tasaFactura,
            ),
            igtfCollectedCurrency,
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
