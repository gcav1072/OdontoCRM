import {
  formatCreditNoteNumber,
  formatInvoiceNumber,
  type BillingInvoiceVoided,
  type VoidInvoiceInput,
} from '@odontocrm/contracts';
import { EVENT_TOPICS } from '@odontocrm/events';
import { ConflictError, NotFoundError } from '@odontocrm/kernel';
import type { BrandLookup, LetterheadLookup } from '@odontocrm/kernel';
import { buildStorageKey, type BlobStore } from '@odontocrm/storage';
import { eq, sql } from 'drizzle-orm';

import type { BillingDb } from '../db/client.js';
import { creditNotes, invoices } from '../db/schema.js';
import { renderCreditNoteHtml } from '../documents/credit-note-pdf.js';
import type { ActorContext } from '../shared/context.js';
import { auditPayload, publish } from '../shared/events.js';
import { renderBillingPdf } from './render-pdf.js';

/**
 * Anular una factura (Art. 22 y 23; ADR 0048).
 *
 * Dos actos distintos, a propósito:
 *
 * - **descartar un borrador**: nunca fue un documento (no consumió número fiscal), así que se anula
 *   con su motivo y **sin** nota de crédito;
 * - **anular una factura emitida**: la ley exige la **nota de crédito** —un documento nuevo, con su
 *   numeración, su PDF archivado y la referencia copiada a la factura—. La factura **se conserva**:
 *   no se borra ni se edita.
 *
 * Una diferencia deliberada con el §3.1 del plan: **una factura pagada no se anula** hasta devolver
 * sus cobros. El plan permitía `pagada → anulada`, pero eso dejaría dinero cobrado sin contrapartida
 * en el sistema; anulando antes los cobros, el saldo vuelve a su sitio y el estado retrocede solo.
 */

export interface VoidDeps {
  db: BillingDb;
  blobStore: BlobStore;
  pdf: { render: (html: string) => Promise<Buffer> };
  /** La identidad del consultorio (ADR 0056); sin ella, el miembrete usa `CLINIC`. */
  letterheadLookup?: LetterheadLookup | undefined;
  /** La marca efectiva de los imprimibles (ADR 0060); sin ella, se usa `BRAND`. */
  brandLookup?: BrandLookup | undefined;
}

const SISTEMA = '00000000-0000-0000-0000-000000000000';

const nextCreditNoteNumber = async (db: BillingDb): Promise<number> => {
  const resultado = await db.execute(sql`select nextval('credit_note_number_seq') as numero`);
  const fila = (resultado.rows[0] ?? {}) as { numero?: string | number };
  const numero = Number(fila.numero);
  if (!Number.isSafeInteger(numero) || numero <= 0) {
    throw new Error('la secuencia del número de nota de crédito no devolvió un número');
  }
  return numero;
};

/** Fila mínima de la factura que hace falta para anular. */
interface FilaFactura {
  id: string;
  status: string;
  series: string;
  invoiceNumber: number | null;
  totalCentsUsd: number;
  totalVesCentimos: number;
  exchangeRateMicros: number | null;
  issuedAt: Date | null;
  patientName: string;
  patientDocType: string;
  patientDocNumber: string;
}

const columnasFactura = {
  id: invoices.id,
  status: invoices.status,
  series: invoices.series,
  invoiceNumber: invoices.invoiceNumber,
  totalCentsUsd: invoices.totalCentsUsd,
  totalVesCentimos: invoices.totalVesCentimos,
  exchangeRateMicros: invoices.exchangeRateMicros,
  issuedAt: invoices.issuedAt,
  patientName: invoices.patientName,
  patientDocType: invoices.patientDocType,
  patientDocNumber: invoices.patientDocNumber,
};

const cargarFactura = async (db: BillingDb, invoiceId: string): Promise<FilaFactura> => {
  const [fila] = await db
    .select(columnasFactura)
    .from(invoices)
    .where(eq(invoices.id, invoiceId))
    .limit(1);
  if (fila === undefined) throw new NotFoundError('Esa factura no existe');
  return fila;
};

/** Descarta un **borrador**: se anula con su motivo y sin nota de crédito (nunca fue documento). */
export const discardDraft = async (
  db: BillingDb,
  invoiceId: string,
  input: VoidInvoiceInput,
  actor: ActorContext,
): Promise<BillingInvoiceVoided> => {
  const factura = await cargarFactura(db, invoiceId);
  if (factura.status !== 'borrador') {
    throw new ConflictError('Esa factura ya está emitida: se anula con nota de crédito', {
      extensions: { status: factura.status },
    });
  }

  const anuladaEn = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(invoices)
      .set({
        status: 'anulada',
        voidedAt: anuladaEn,
        voidReason: input.reason,
        voidedByUserId: actor.actorId ?? SISTEMA,
        voidedByUsername: actor.actorUsername ?? 'sistema',
      })
      .where(eq(invoices.id, invoiceId));

    await publish(tx, {
      topic: EVENT_TOPICS.invoiceVoided,
      aggregateId: invoiceId,
      actor,
      payload: {
        ...auditPayload({
          entityId: invoiceId,
          action: 'invoice_voided',
          entityType: 'invoice',
          summary: `Borrador de factura descartado para ${factura.patientName}`,
          changedFields: ['status'],
          before: { status: 'borrador' },
          after: { status: 'anulada' },
          reason: input.reason,
          actor,
        }),
        invoice: {
          invoiceId,
          status: 'anulada',
          patientId: null,
          totalCentsUsd: factura.totalCentsUsd,
        },
      },
    });
  });

  return {
    invoice: {
      id: invoiceId,
      status: 'anulada',
      voidReason: input.reason,
      voidedAt: anuladaEn.toISOString(),
    },
    creditNote: null,
  };
};

/**
 * Anula una factura **emitida** con su nota de crédito. El PDF se compone fuera de la transacción y,
 * si la transacción falla, el archivo se borra (igual que en la emisión y en el cobro).
 */
export const voidInvoice = async (
  deps: VoidDeps,
  invoiceId: string,
  input: VoidInvoiceInput,
  actor: ActorContext,
): Promise<BillingInvoiceVoided> => {
  const factura = await cargarFactura(deps.db, invoiceId);

  if (factura.status === 'borrador') {
    throw new ConflictError(
      'Ese documento todavía es un borrador: descártalo, no lleva nota de crédito',
      {
        extensions: { status: factura.status },
      },
    );
  }
  if (factura.status === 'anulada') {
    throw new ConflictError('Esa factura ya está anulada', {
      extensions: { status: factura.status },
    });
  }
  if (factura.status === 'pagada') {
    throw new ConflictError(
      'La factura está pagada: anula antes sus cobros y vuelve a intentarlo',
      {
        extensions: { status: factura.status },
      },
    );
  }
  if (factura.invoiceNumber === null || factura.issuedAt === null) {
    throw new ConflictError('La factura no tiene número de emisión: no se puede referenciar', {
      extensions: { invoiceId },
    });
  }

  const numero = factura.invoiceNumber;
  const numberLabel = formatInvoiceNumber(factura.series, numero);
  const rateMicros = factura.exchangeRateMicros ?? 0;
  const creditNoteNumber = await nextCreditNoteNumber(deps.db);
  const creditNoteLabel = formatCreditNoteNumber(creditNoteNumber);
  const issuedAt = new Date();
  const identidad = deps.letterheadLookup === undefined ? null : await deps.letterheadLookup();
  const marca = deps.brandLookup === undefined ? null : await deps.brandLookup();

  const html = await renderCreditNoteHtml({
    clinic: identidad?.clinic,
    logoDataUri: identidad?.logoDataUri ?? null,
    dentist: identidad?.dentist ?? null,
    brand: marca?.theme ?? null,
    fontFaceCss: marca?.fontFaceCss ?? null,
    creditNoteLabel,
    issuedAt,
    invoice: { numberLabel, issuedAt: factura.issuedAt, totalCentsUsd: factura.totalCentsUsd },
    patient: {
      name: factura.patientName,
      docType: factura.patientDocType,
      docNumber: factura.patientDocNumber,
    },
    reason: input.reason,
    totalCentsUsd: factura.totalCentsUsd,
    totalVesCentimos: factura.totalVesCentimos,
    rateMicros,
    issuedByUsername: actor.actorUsername ?? 'sistema',
  });
  const bytes = await renderBillingPdf(deps.pdf, html, 'la nota de crédito');
  const archivo = await deps.blobStore.save({
    key: buildStorageKey('billing', invoiceId, `nota-credito-${creditNoteLabel}`, 'pdf'),
    data: bytes,
  });

  let idNota = '';
  try {
    await deps.db.transaction(async (tx) => {
      const [nota] = await tx
        .insert(creditNotes)
        .values({
          creditNoteNumber,
          invoiceId,
          // La referencia **copiada** (Art. 23), no un enlace vivo.
          invoiceNumber: numero,
          invoiceIssuedAt: factura.issuedAt ?? issuedAt,
          invoiceTotalCentsUsd: factura.totalCentsUsd,
          kind: 'total',
          reason: input.reason,
          totalCentsUsd: factura.totalCentsUsd,
          exchangeRateMicros: rateMicros,
          totalVesCentimos: factura.totalVesCentimos,
          pdfPath: archivo.path,
          pdfSha256: archivo.sha256,
          issuedByUserId: actor.actorId ?? SISTEMA,
          issuedByUsername: actor.actorUsername ?? 'sistema',
          issuedAt,
        })
        .returning({ id: creditNotes.id });
      if (nota === undefined) throw new Error('no se pudo emitir la nota de crédito');
      idNota = nota.id;

      await tx
        .update(invoices)
        .set({
          status: 'anulada',
          voidedAt: issuedAt,
          voidReason: input.reason,
          voidedByUserId: actor.actorId ?? SISTEMA,
          voidedByUsername: actor.actorUsername ?? 'sistema',
        })
        .where(eq(invoices.id, invoiceId));

      await publish(tx, {
        topic: EVENT_TOPICS.creditNoteIssued,
        aggregateId: nota.id,
        actor,
        payload: {
          ...auditPayload({
            entityId: nota.id,
            action: 'credit_note_issued',
            entityType: 'credit_note',
            summary: `Nota de crédito ${creditNoteLabel} sobre la factura ${numberLabel}`,
            changedFields: ['status'],
            before: { status: factura.status },
            after: { status: 'anulada' },
            reason: input.reason,
            actor,
          }),
          creditNote: {
            creditNoteId: nota.id,
            number: creditNoteLabel,
            invoiceId,
            invoiceNumber: numberLabel,
            totalCentsUsd: factura.totalCentsUsd,
            totalVesCentimos: factura.totalVesCentimos,
          },
          invoice: { invoiceId, status: 'anulada' },
        },
      });
    });
  } catch (error) {
    await deps.blobStore.remove(archivo.path).catch(() => undefined);
    throw error;
  }

  return {
    invoice: {
      id: invoiceId,
      status: 'anulada',
      voidReason: input.reason,
      voidedAt: issuedAt.toISOString(),
    },
    creditNote: {
      id: idNota,
      creditNoteNumber,
      creditNoteLabel,
      invoiceId,
      invoiceNumber: numero,
      invoiceNumberLabel: numberLabel,
      invoiceIssuedAt: (factura.issuedAt ?? issuedAt).toISOString(),
      invoiceTotalCentsUsd: factura.totalCentsUsd,
      kind: 'total',
      reason: input.reason,
      totalCentsUsd: factura.totalCentsUsd,
      exchangeRateMicros: rateMicros,
      totalVesCentimos: factura.totalVesCentimos,
      pdfSha256: archivo.sha256,
      issuedAt: issuedAt.toISOString(),
    },
  };
};
