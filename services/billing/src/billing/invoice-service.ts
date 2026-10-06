import {
  IVA_GENERAL_BASIS_POINTS,
  invoiceTotalsFromItems,
  ivaCentsForItem,
  rateDateInCaracas,
  type BillingDraftDetail,
  type BillingDraftItem,
  type BillingDraftSummary,
  type DraftItemInput,
  type InvoiceStatus,
  type InvoiceTotals,
  type TaxCategory,
} from '@odontocrm/contracts';
import { ConflictError, NotFoundError } from '@odontocrm/kernel';
import { asc, eq, inArray, sql } from 'drizzle-orm';

import type { BillingDb } from '../db/client.js';
import {
  invoiceItems,
  invoiceSessions,
  invoices,
  processedEvents,
  treatmentCatalog,
} from '../db/schema.js';
import { rateForDate } from '../rates/rate-service.js';
import type { BillingPatientLookup } from '../shared/patient-client.js';

/** El borrador lo crea el **sistema** al cerrarse la sesión clínica, no una persona. */
export const SISTEMA_USER_ID = '00000000-0000-0000-0000-000000000000';
export const SISTEMA_USERNAME = 'sistema';

/**
 * Alícuota que se **copia** en la partida (B13). Hoy el valor de siembra del contrato; el día que
 * existan `tax_rates` con vigencia (§3.3 del plan) se leerá de ahí y este ayudante será el único
 * sitio que cambie.
 */
export const taxRateForItem = (taxCategory: TaxCategory): number =>
  taxCategory === 'general' ? IVA_GENERAL_BASIS_POINTS : 0;

/* ── Lo que ve la caja ─────────────────────────────────────────────────────── */

/**
 * Las formas de la respuesta viven en el **contrato** (`billingDraftSummarySchema` y compañía), no
 * aquí: la interfaz las valida contra el mismo esquema que documenta la API.
 */
export type DraftSummary = BillingDraftSummary;
export type DraftItem = BillingDraftItem;
export type DraftDetail = BillingDraftDetail;

/* ── Las líneas, desde el catálogo ─────────────────────────────────────────── */

interface ItemRow {
  catalogId: string | null;
  code: string;
  description: string;
  toothNumber: number | null;
  surfaces: string[] | null;
  quantity: number;
  unitPriceCentsUsd: number;
  totalPriceCentsUsd: number;
  taxCategory: TaxCategory;
  taxRateBasisPoints: number;
  ivaAmountCentsUsd: number;
  needsPricing: boolean;
}

interface LineInput {
  code: string;
  detail?: string | null;
  toothNumber?: number | null;
  surfaces?: readonly string[];
  quantity?: number;
  unitPriceCentsUsd?: number;
  description?: string | null;
}

/**
 * Arma las líneas contra el catálogo. **Nunca se bloquea**: lo que no está en el catálogo —o está con
 * precio 0, que es el centinela de «sin precio»— entra marcado para que la caja lo resuelva.
 */
const buildItems = async (db: BillingDb, lines: readonly LineInput[]): Promise<ItemRow[]> => {
  const codigos = [...new Set(lines.map((line) => line.code))];
  const catalogo =
    codigos.length === 0
      ? []
      : await db.select().from(treatmentCatalog).where(inArray(treatmentCatalog.code, codigos));
  const porCodigo = new Map(catalogo.map((fila) => [fila.code, fila]));

  return lines.map((line) => {
    const delCatalogo = porCodigo.get(line.code);
    const quantity = line.quantity ?? 1;
    const unitPriceCentsUsd = line.unitPriceCentsUsd ?? delCatalogo?.priceCentsUsd ?? 0;
    const taxCategory = (delCatalogo?.taxCategory ?? 'exento') as TaxCategory;
    const taxRateBasisPoints = taxRateForItem(taxCategory);
    const surfaces = line.surfaces ?? [];
    /**
     * `otros` es un cajón, no un servicio: lo que se hizo es el detalle que escribió el odontólogo
     * («Sellado de fosas profundo»), y eso es lo que tiene que decir la factura.
     */
    const porDefecto =
      line.code === 'otros' && line.detail != null && line.detail.trim() !== ''
        ? line.detail
        : (delCatalogo?.name ?? 'Procedimiento');

    return {
      catalogId: delCatalogo?.id ?? null,
      code: line.code,
      description: line.description ?? porDefecto,
      toothNumber: line.toothNumber ?? null,
      surfaces: surfaces.length > 0 ? [...surfaces] : null,
      quantity,
      unitPriceCentsUsd,
      totalPriceCentsUsd: unitPriceCentsUsd * quantity,
      taxCategory,
      taxRateBasisPoints,
      ivaAmountCentsUsd: ivaCentsForItem({
        baseCentsUsd: unitPriceCentsUsd * quantity,
        taxCategory,
        taxRateBasisPoints,
      }),
      needsPricing: unitPriceCentsUsd === 0,
    };
  });
};

/* ── El borrador desde la sesión cerrada (ADR 0044, B1) ────────────────────── */

export interface SessionClosedInput {
  eventId: string;
  topic: string;
  sessionId: string;
  patientId: string;
  procedures: readonly {
    code: string;
    detail: string | null;
    toothNumber: number | null;
    surfaces: readonly string[];
  }[];
}

/** `creado` | `duplicado` (el evento ya se procesó) | `ya_cobrada` (esa sesión ya tiene factura). */
export type DraftOutcome = 'creado' | 'duplicado' | 'ya_cobrada';

/**
 * Crea el borrador de factura de una sesión cerrada, **idempotente por partida doble**: el `eventId`
 * se reclama en `processed_events` dentro de la misma transacción (primera red) y
 * `uq_invoice_sessions_session` impide dos facturas para la misma sesión (segunda).
 *
 * Si la ficha del paciente no se puede leer, **lanza**: el evento se reintenta en vez de escribir un
 * nombre inventado en un documento fiscal. La atención clínica no depende de esto (la sesión ya está
 * cerrada y guardada).
 */
export const createDraftFromSession = async (
  deps: { db: BillingDb; patientLookup: BillingPatientLookup },
  input: SessionClosedInput,
): Promise<DraftOutcome> => {
  const [yaProcesado] = await deps.db
    .select({ eventId: processedEvents.eventId })
    .from(processedEvents)
    .where(eq(processedEvents.eventId, input.eventId))
    .limit(1);
  if (yaProcesado !== undefined) return 'duplicado';

  const paciente = await deps.patientLookup(input.patientId);
  if (paciente === null) {
    throw new Error(
      `no se pudo leer la ficha del paciente ${input.patientId}: el evento se reintentará`,
    );
  }

  const lineas = await buildItems(deps.db, input.procedures);
  const totales = invoiceTotalsFromItems(lineas);
  // B5: el borrador nace con la **tasa provisional** del día (la definitiva se congela al emitir).
  const tasa = await rateForDate(deps.db, rateDateInCaracas());

  return deps.db.transaction(async (tx) => {
    const reclamado = await tx
      .insert(processedEvents)
      .values({ eventId: input.eventId, topic: input.topic })
      .onConflictDoNothing()
      .returning({ eventId: processedEvents.eventId });
    if (reclamado.length === 0) return 'duplicado';

    const [yaTieneFactura] = await tx
      .select({ invoiceId: invoiceSessions.invoiceId })
      .from(invoiceSessions)
      .where(eq(invoiceSessions.clinicalSessionId, input.sessionId))
      .limit(1);
    if (yaTieneFactura !== undefined) return 'ya_cobrada';

    const [borrador] = await tx
      .insert(invoices)
      .values({
        status: 'borrador',
        patientId: paciente.patientId,
        patientName: paciente.fullName,
        patientDocType: paciente.docType,
        patientDocNumber: paciente.docNumber,
        patientTaxId: paciente.taxId,
        patientFiscalAddress: paciente.fiscalAddress,
        rateAtDraftMicros: tasa?.rate.rateMicros ?? null,
        exemptAmountCentsUsd: totales.exemptAmountCentsUsd,
        taxableAmountCentsUsd: totales.taxableAmountCentsUsd,
        ivaAmountCentsUsd: totales.ivaAmountCentsUsd,
        totalCentsUsd: totales.totalCentsUsd,
        balanceCentsUsd: totales.totalCentsUsd,
        createdByUserId: SISTEMA_USER_ID,
        createdByUsername: SISTEMA_USERNAME,
      })
      .returning({ id: invoices.id });
    if (borrador === undefined) throw new Error('no se pudo crear el borrador');

    if (lineas.length > 0) {
      await tx
        .insert(invoiceItems)
        .values(lineas.map((linea) => ({ ...linea, invoiceId: borrador.id })));
    }
    await tx
      .insert(invoiceSessions)
      .values({ invoiceId: borrador.id, clinicalSessionId: input.sessionId });

    return 'creado';
  });
};

/* ── Consultas y edición del borrador ──────────────────────────────────────── */

const resumen = (fila: {
  id: string;
  status: string;
  series: string;
  patientId: string;
  patientName: string;
  patientDocType: string;
  patientDocNumber: string;
  patientTaxId: string | null;
  patientFiscalAddress: string | null;
  invoiceNumber: number | null;
  exchangeRateMicros: number | null;
  createdAt: Date;
  exemptAmountCentsUsd: number;
  taxableAmountCentsUsd: number;
  ivaAmountCentsUsd: number;
  totalCentsUsd: number;
  balanceCentsUsd: number;
}): Omit<DraftSummary, 'itemCount' | 'needsPricing'> => ({
  id: fila.id,
  // El `CHECK` de la tabla garantiza que es un estado del contrato.
  status: fila.status as InvoiceStatus,
  series: fila.series,
  patientId: fila.patientId,
  patientName: fila.patientName,
  patientDocType: fila.patientDocType,
  patientDocNumber: fila.patientDocNumber,
  patientTaxId: fila.patientTaxId,
  patientFiscalAddress: fila.patientFiscalAddress,
  invoiceNumber: fila.invoiceNumber,
  exchangeRateMicros: fila.exchangeRateMicros,
  createdAt: fila.createdAt.toISOString(),
  exemptAmountCentsUsd: fila.exemptAmountCentsUsd,
  taxableAmountCentsUsd: fila.taxableAmountCentsUsd,
  ivaAmountCentsUsd: fila.ivaAmountCentsUsd,
  totalCentsUsd: fila.totalCentsUsd,
  balanceCentsUsd: fila.balanceCentsUsd,
});

const columnasResumen = {
  id: invoices.id,
  status: invoices.status,
  series: invoices.series,
  patientId: invoices.patientId,
  patientName: invoices.patientName,
  patientDocType: invoices.patientDocType,
  patientDocNumber: invoices.patientDocNumber,
  patientTaxId: invoices.patientTaxId,
  patientFiscalAddress: invoices.patientFiscalAddress,
  invoiceNumber: invoices.invoiceNumber,
  exchangeRateMicros: invoices.exchangeRateMicros,
  createdAt: invoices.createdAt,
  exemptAmountCentsUsd: invoices.exemptAmountCentsUsd,
  taxableAmountCentsUsd: invoices.taxableAmountCentsUsd,
  ivaAmountCentsUsd: invoices.ivaAmountCentsUsd,
  totalCentsUsd: invoices.totalCentsUsd,
  balanceCentsUsd: invoices.balanceCentsUsd,
};

/** Las partidas de un conjunto de facturas, contadas y con el aviso de precio pendiente. */
const agregadosDeItems = async (
  db: BillingDb,
  ids: readonly string[],
): Promise<Map<string, { itemCount: number; needsPricing: boolean }>> => {
  if (ids.length === 0) return new Map();
  const filas = await db
    .select({
      invoiceId: invoiceItems.invoiceId,
      itemCount: sql<number>`count(*)::int`,
      needsPricing: sql<boolean>`bool_or(${invoiceItems.needsPricing})`,
    })
    .from(invoiceItems)
    .where(inArray(invoiceItems.invoiceId, [...ids]))
    .groupBy(invoiceItems.invoiceId);
  return new Map(
    filas.map((fila) => [
      fila.invoiceId,
      { itemCount: fila.itemCount, needsPricing: fila.needsPricing },
    ]),
  );
};

/** La cola del día: borradores sin emitir, del más viejo al más nuevo. */
export const listDrafts = async (db: BillingDb): Promise<DraftSummary[]> => {
  const filas = await db
    .select(columnasResumen)
    .from(invoices)
    .where(eq(invoices.status, 'borrador'))
    .orderBy(asc(invoices.createdAt));
  const agregados = await agregadosDeItems(
    db,
    filas.map((fila) => fila.id),
  );
  return filas.map((fila) => ({
    ...resumen(fila),
    itemCount: agregados.get(fila.id)?.itemCount ?? 0,
    needsPricing: agregados.get(fila.id)?.needsPricing ?? false,
  }));
};

/** La factura en **cualquier estado**: la emisión vuelve a leerla ya emitida. */
export const getInvoice = async (db: BillingDb, invoiceId: string): Promise<DraftDetail> => {
  const [fila] = await db
    .select(columnasResumen)
    .from(invoices)
    .where(eq(invoices.id, invoiceId))
    .limit(1);
  if (fila === undefined) throw new NotFoundError('Esa factura no existe');

  const items = await db
    .select({
      id: invoiceItems.id,
      code: invoiceItems.code,
      description: invoiceItems.description,
      toothNumber: invoiceItems.toothNumber,
      surfaces: invoiceItems.surfaces,
      quantity: invoiceItems.quantity,
      unitPriceCentsUsd: invoiceItems.unitPriceCentsUsd,
      totalPriceCentsUsd: invoiceItems.totalPriceCentsUsd,
      taxCategory: invoiceItems.taxCategory,
      taxRateBasisPoints: invoiceItems.taxRateBasisPoints,
      ivaAmountCentsUsd: invoiceItems.ivaAmountCentsUsd,
      needsPricing: invoiceItems.needsPricing,
    })
    .from(invoiceItems)
    .where(eq(invoiceItems.invoiceId, invoiceId))
    .orderBy(asc(invoiceItems.code));

  const sesiones = await db
    .select({ clinicalSessionId: invoiceSessions.clinicalSessionId })
    .from(invoiceSessions)
    .where(eq(invoiceSessions.invoiceId, invoiceId));

  const agregados = await agregadosDeItems(db, [invoiceId]);

  return {
    ...resumen(fila),
    itemCount: agregados.get(invoiceId)?.itemCount ?? 0,
    needsPricing: agregados.get(invoiceId)?.needsPricing ?? false,
    // La categoría la garantiza el `CHECK` de la tabla; el tipo la pide del contrato.
    items: items.map((item) => ({ ...item, taxCategory: item.taxCategory as TaxCategory })),
    clinicalSessionIds: sesiones.map((sesion) => sesion.clinicalSessionId),
  };
};

/**
 * Reemplaza las líneas del borrador y recalcula los totales **sumando las partidas** (nunca al revés).
 * Solo se puede mientras es `borrador`: una factura emitida no se edita, se anula con nota de crédito
 * (ADR 0048).
 */
export const replaceDraftItems = async (
  db: BillingDb,
  invoiceId: string,
  items: readonly DraftItemInput[],
): Promise<InvoiceTotals> => {
  const lineas = await buildItems(
    db,
    items.map((item) => ({
      code: item.code,
      quantity: item.quantity,
      unitPriceCentsUsd: item.unitPriceCentsUsd,
      description: item.description,
      toothNumber: item.toothNumber,
      surfaces: item.surfaces,
    })),
  );
  const totales = invoiceTotalsFromItems(lineas);

  return db.transaction(async (tx) => {
    const [fila] = await tx
      .select({ status: invoices.status })
      .from(invoices)
      .where(eq(invoices.id, invoiceId))
      .limit(1);
    if (fila === undefined) throw new NotFoundError('Ese borrador no existe');
    if (fila.status !== 'borrador') {
      throw new ConflictError('Una factura emitida no se edita: se anula con nota de crédito', {
        extensions: { status: fila.status },
      });
    }

    await tx.delete(invoiceItems).where(eq(invoiceItems.invoiceId, invoiceId));
    if (lineas.length > 0) {
      await tx.insert(invoiceItems).values(lineas.map((linea) => ({ ...linea, invoiceId })));
    }
    await tx
      .update(invoices)
      .set({
        exemptAmountCentsUsd: totales.exemptAmountCentsUsd,
        taxableAmountCentsUsd: totales.taxableAmountCentsUsd,
        ivaAmountCentsUsd: totales.ivaAmountCentsUsd,
        totalCentsUsd: totales.totalCentsUsd,
        balanceCentsUsd: totales.totalCentsUsd,
      })
      .where(eq(invoices.id, invoiceId));

    return totales;
  });
};

/** El catálogo activo, para que la caja pueda añadir un bien a la factura. */
export const listCatalog = async (db: BillingDb) =>
  db
    .select({
      id: treatmentCatalog.id,
      code: treatmentCatalog.code,
      name: treatmentCatalog.name,
      kind: treatmentCatalog.kind,
      priceCentsUsd: treatmentCatalog.priceCentsUsd,
      taxCategory: treatmentCatalog.taxCategory,
    })
    .from(treatmentCatalog)
    .where(eq(treatmentCatalog.isActive, true))
    .orderBy(asc(treatmentCatalog.code));

/**
 * El borrador, para la caja: si ya es un documento, esta ruta no lo alcanza (un documento emitido no
 * se edita: se anula con nota de crédito).
 */
export const getDraft = async (db: BillingDb, invoiceId: string): Promise<DraftDetail> => {
  const detalle = await getInvoice(db, invoiceId);
  if (detalle.status !== 'borrador') throw new NotFoundError('Ese borrador no existe');
  return detalle;
};
