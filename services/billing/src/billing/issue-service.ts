import {
  formatInvoiceNumber,
  invoiceVesTotals,
  rateDateInCaracas,
  type BillingInvoiceIssued,
} from '@odontocrm/contracts';
import { EVENT_TOPICS } from '@odontocrm/events';
import { ConflictError, NotFoundError } from '@odontocrm/kernel';
import type { BrandLookup, LetterheadLookup } from '@odontocrm/kernel';
import { buildStorageKey, type BlobStore } from '@odontocrm/storage';
import { and, eq, sql } from 'drizzle-orm';

import type { BillingDb } from '../db/client.js';
import { invoiceSeries, invoices } from '../db/schema.js';
import { IGTF_NO_PERCIBIDO, renderInvoiceHtml } from '../documents/invoice-pdf.js';
import { rateStatus } from '../rates/rate-service.js';
import type { ActorContext } from '../shared/context.js';
import { auditPayload, publish } from '../shared/events.js';
import { activeLot, consumeControl } from './fiscal-forms-service.js';
import { getInvoice } from './invoice-service.js';
import { renderBillingPdf } from './render-pdf.js';

/**
 * Emitir la factura (ADR 0048): **congelar** y archivar.
 *
 * El orden importa y está medido:
 *
 * 1. el **correlativo** se toma de la secuencia **antes** de renderizar (es atómico: dos emisiones
 *    simultáneas nunca comparten número, y el `update` que solo avanza desde `borrador` deja a la
 *    segunda con un 409);
 * 2. el **PDF** se compone **fuera** de la transacción —Chromium tarda— y se archiva con su `sha256`;
 * 3. la **transacción** consume el control de la forma, congela la tasa, escribe los totales en las
 *    dos monedas y publica el evento. Si falla, **el archivo se borra**: no queda un PDF huérfano.
 *
 * Una diferencia deliberada con el §5.2 del plan: allí un fallo del PDF dejaba la **forma dañada**.
 * Eso asume que la forma ya se alimentó a la impresora; aquí el papel se imprime **después** de
 * emitir, así que un fallo al componer el PDF no estropea ninguna forma y el control no se consume.
 * El control se gasta cuando el documento existe.
 */

export interface IssueDeps {
  db: BillingDb;
  /** Almacén de los documentos (ADR 0036): lo que se reimprime es este archivo. */
  blobStore: BlobStore;
  pdf: { render: (html: string) => Promise<Buffer> };
  /** La identidad del consultorio (ADR 0056); sin ella, el miembrete usa `CLINIC`. */
  letterheadLookup?: LetterheadLookup | undefined;
  /** La marca efectiva de los imprimibles (ADR 0060); sin ella, se usa `BRAND`. */
  brandLookup?: BrandLookup | undefined;
}

/** El correlativo de la secuencia: atómico y único, nunca «el último + 1». */
const nextInvoiceNumber = async (db: BillingDb): Promise<number> => {
  const resultado = await db.execute(sql`select nextval('invoice_number_seq') as numero`);
  const fila = (resultado.rows[0] ?? {}) as { numero?: string | number };
  const numero = Number(fila.numero);
  if (!Number.isSafeInteger(numero) || numero <= 0) {
    throw new Error('la secuencia del número de factura no devolvió un número');
  }
  return numero;
};

export const issueInvoice = async (
  deps: IssueDeps,
  invoiceId: string,
  actor: ActorContext,
): Promise<BillingInvoiceIssued> => {
  const detalle = await getInvoice(deps.db, invoiceId);

  if (detalle.status !== 'borrador') {
    throw new ConflictError(
      'Una factura emitida no se emite dos veces: se anula con nota de crédito',
      {
        extensions: { status: detalle.status },
      },
    );
  }
  if (detalle.items.length === 0) {
    throw new ConflictError('Una factura sin partidas no se emite', { extensions: { invoiceId } });
  }
  const sinPrecio = detalle.items.filter((item) => item.needsPricing);
  if (sinPrecio.length > 0) {
    throw new ConflictError('Hay partidas sin precio: resuélvelas antes de emitir', {
      extensions: { codes: sinPrecio.map((item) => item.code) },
    });
  }

  /**
   * La tasa del día del hecho imponible (Art. 25) se congela aquí. Si el hueco pasa el umbral, la
   * caja tiene que **confirmar** (M8): la caja no inventa una tasa ni cobra con una vieja en silencio.
   */
  const tasa = await rateStatus(deps.db, rateDateInCaracas());
  if (tasa.current === null) {
    throw new ConflictError('No hay ninguna tasa publicada: fíjala antes de emitir', {
      extensions: { invoiceId },
    });
  }
  if (tasa.needsConfirmation) {
    throw new ConflictError(
      `La tasa vigente es del ${tasa.current.rateDate} (${String(tasa.gapDays)} días): confírmala antes de emitir`,
      { extensions: { rateDate: tasa.current.rateDate, gapDays: tasa.gapDays } },
    );
  }
  const rateMicros = tasa.current.rateMicros;

  const [serie] = await deps.db
    .select()
    .from(invoiceSeries)
    .where(eq(invoiceSeries.series, detalle.series))
    .limit(1);
  if (serie === undefined) throw new NotFoundError(`La serie ${detalle.series} no existe`);

  const lote = await activeLot(deps.db, serie.series);
  if (serie.numberingMode === 'formas_libres' && lote === null) {
    throw new ConflictError(
      'No queda ninguna forma libre: da de alta el lote siguiente (sin formas no se puede facturar)',
      { extensions: { series: serie.series } },
    );
  }

  // 1) El número, antes de renderizar.
  const invoiceNumber = await nextInvoiceNumber(deps.db);
  const numberLabel = formatInvoiceNumber(serie.series, invoiceNumber);
  const controlNumber = lote?.nextControl ?? null;

  // 2) Los totales en Bs. con la tasa congelada, **sumando las partes ya convertidas**.
  const totales = {
    exemptAmountCentsUsd: detalle.exemptAmountCentsUsd,
    taxableAmountCentsUsd: detalle.taxableAmountCentsUsd,
    ivaAmountCentsUsd: detalle.ivaAmountCentsUsd,
    totalCentsUsd: detalle.totalCentsUsd,
  };
  const enBs = invoiceVesTotals(totales, rateMicros);

  // 3) El PDF, fuera de la transacción.
  const issuedAt = new Date();
  const identidad = deps.letterheadLookup === undefined ? null : await deps.letterheadLookup();
  const marca = deps.brandLookup === undefined ? null : await deps.brandLookup();
  const html = await renderInvoiceHtml({
    clinic: identidad?.clinic,
    logoDataUri: identidad?.logoDataUri ?? null,
    brand: marca?.theme ?? null,
    fontFaceCss: marca?.fontFaceCss ?? null,
    series: serie.series,
    numberLabel,
    controlNumber,
    controlRange: lote === null ? null : { from: lote.controlFrom, to: lote.controlTo },
    issuedAt,
    patient: {
      name: detalle.patientName,
      docType: detalle.patientDocType,
      docNumber: detalle.patientDocNumber,
      taxId: detalle.patientTaxId,
      fiscalAddress: detalle.patientFiscalAddress,
    },
    items: detalle.items,
    totals: totales,
    rateMicros,
    printer:
      lote === null
        ? null
        : {
            name: lote.printerName,
            rif: lote.printerRif,
            authorizationRef: lote.authorizationRef,
            authorizationDate: lote.authorizationDate,
            printDate: lote.printDate,
          },
    igtfNote: IGTF_NO_PERCIBIDO,
  });
  const bytes = await renderBillingPdf(deps.pdf, html, 'la factura');
  const archivo = await deps.blobStore.save({
    key: buildStorageKey('billing', invoiceId, `factura-${numberLabel}`, 'pdf'),
    data: bytes,
  });

  // 4) La transacción: consumir el control, archivar y publicar.
  try {
    await deps.db.transaction(async (tx) => {
      if (lote !== null) {
        const consumido = await consumeControl(tx, lote);
        if (consumido !== controlNumber) {
          // Otra emisión gastó la forma entre la lectura y la transacción: se aborta y se reintenta.
          throw new ConflictError('La forma cambió mientras se emitía: vuelve a intentarlo', {
            extensions: { invoiceId },
          });
        }
      }

      const [actualizada] = await tx
        .update(invoices)
        .set({
          status: 'emitida',
          invoiceNumber,
          controlNumber,
          fiscalFormId: lote?.id ?? null,
          exchangeRateMicros: rateMicros,
          exemptAmountVesCentimos: enBs.exemptAmountVesCentimos,
          taxableAmountVesCentimos: enBs.taxableAmountVesCentimos,
          ivaAmountVesCentimos: enBs.ivaAmountVesCentimos,
          totalVesCentimos: enBs.totalVesCentimos,
          pdfPath: archivo.path,
          pdfSha256: archivo.sha256,
          generatedAt: issuedAt,
          issuedAt,
          issuedByUserId: actor.actorId,
          balanceCentsUsd: totales.totalCentsUsd,
        })
        // Solo avanza desde `borrador`: la segunda emisión simultánea no encuentra fila.
        .where(and(eq(invoices.id, invoiceId), eq(invoices.status, 'borrador')))
        .returning({ id: invoices.id });
      if (actualizada === undefined) {
        throw new ConflictError('La factura ya no es un borrador: otra emisión se adelantó', {
          extensions: { invoiceId },
        });
      }

      await publish(tx, {
        topic: EVENT_TOPICS.invoiceIssued,
        aggregateId: invoiceId,
        actor,
        payload: {
          ...auditPayload({
            entityId: invoiceId,
            action: 'invoice_issued',
            entityType: 'invoice',
            summary: `Factura ${numberLabel} emitida por ${detalle.patientName}: US$ ${(totales.totalCentsUsd / 100).toFixed(2)}`,
            changedFields: ['status', 'invoice_number', 'control_number'],
            before: { status: 'borrador' },
            after: {
              status: 'emitida',
              invoiceNumber,
              controlNumber,
              rateMicros,
              totalCentsUsd: totales.totalCentsUsd,
              totalVesCentimos: enBs.totalVesCentimos,
            },
            actor,
          }),
          // Lo que necesita el consumidor (ADR 0041).
          invoice: {
            invoiceId,
            number: numberLabel,
            patientId: detalle.patientId,
            totalCentsUsd: totales.totalCentsUsd,
            totalVes: enBs.totalVesCentimos,
            rateMicros,
            status: 'emitida',
          },
        },
      });
    });
  } catch (error) {
    // ADR 0048: si la transacción falla, el archivo no queda huérfano.
    await deps.blobStore.remove(archivo.path).catch(() => undefined);
    throw error;
  }

  return {
    ...(await getInvoice(deps.db, invoiceId)),
    invoiceNumber,
    controlNumber,
    numberLabel,
    issuedAt: issuedAt.toISOString(),
    exchangeRateMicros: rateMicros,
    ...enBs,
    pdfSha256: archivo.sha256,
  };
};
