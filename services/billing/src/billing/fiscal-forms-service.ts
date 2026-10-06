import {
  FISCAL_FORMS_LOW_THRESHOLD,
  type CreateFiscalFormLotInput,
  type FiscalFormLot,
  type SpoilFiscalFormInput,
} from '@odontocrm/contracts';
import { EVENT_TOPICS } from '@odontocrm/events';
import { ConflictError, NotFoundError } from '@odontocrm/kernel';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';

import type { BillingDb } from '../db/client.js';
import { fiscalForms, invoiceSeries } from '../db/schema.js';
import type { ActorContext } from '../shared/context.js';
import { auditPayload, publish } from '../shared/events.js';

/**
 * Las **formas libres** de imprenta autorizada (ADR 0047).
 *
 * El número de control viene **preimpreso** en la forma: el software no lo inventa, lo **consume en
 * orden** y lo imprime. De ahí las tres reglas que se ven aquí:
 *
 * 1. los controles son **numéricos** y se consumen en orden (si algún día llegan alfanuméricos, el
 *    alta lo dice en vez de consumirlos a ciegas);
 * 2. dos lotes de la misma serie **no pueden solaparse**: un control consumido dos veces sería un
 *    documento repetido;
 * 3. una forma dañada **no se reutiliza**: ocupa su control, se cuenta (`spoiledCount`) y se conserva
 *    (Art. 36 y 40). Y cuando quedan pocas, la caja lo avisa: quedarse sin formas es quedarse sin
 *    poder facturar.
 */

/** Un control numérico de hasta 15 dígitos; `null` si no lo es. */
const valorDeControl = (control: string): number | null =>
  /^\d{1,15}$/.test(control) ? Number(control) : null;

const formatearControl = (valor: number, ancho: number): string =>
  String(valor).padStart(ancho, '0');

interface FilaLote {
  id: string;
  series: string;
  controlFrom: string;
  controlTo: string;
  nextControl: string;
  printerName: string;
  printerRif: string;
  authorizationRef: string;
  authorizationDate: string;
  printDate: string;
  receivedAt: Date | null;
  spoiledCount: number;
  exhaustedAt: Date | null;
}

const aLote = (fila: FilaLote): FiscalFormLot => {
  const desde = valorDeControl(fila.controlFrom) ?? 0;
  const hasta = valorDeControl(fila.controlTo) ?? desde;
  const proximo = valorDeControl(fila.nextControl) ?? hasta + 1;
  const remaining = fila.exhaustedAt === null ? Math.max(0, hasta - proximo + 1) : 0;

  return {
    id: fila.id,
    series: fila.series,
    controlFrom: fila.controlFrom,
    controlTo: fila.controlTo,
    nextControl: fila.nextControl,
    remaining,
    isLow: remaining > 0 && remaining <= FISCAL_FORMS_LOW_THRESHOLD,
    printerName: fila.printerName,
    printerRif: fila.printerRif,
    authorizationRef: fila.authorizationRef,
    authorizationDate: fila.authorizationDate,
    printDate: fila.printDate,
    spoiledCount: fila.spoiledCount,
    exhaustedAt: fila.exhaustedAt?.toISOString() ?? null,
    receivedAt: fila.receivedAt?.toISOString() ?? null,
  };
};

/** Con la serie unida, que es lo que se muestra («A · del 000001 al 000500»). */
const columnasDelLote = {
  id: fiscalForms.id,
  series: invoiceSeries.series,
  controlFrom: fiscalForms.controlFrom,
  controlTo: fiscalForms.controlTo,
  nextControl: fiscalForms.nextControl,
  printerName: fiscalForms.printerName,
  printerRif: fiscalForms.printerRif,
  authorizationRef: fiscalForms.authorizationRef,
  authorizationDate: fiscalForms.authorizationDate,
  printDate: fiscalForms.printDate,
  receivedAt: fiscalForms.receivedAt,
  spoiledCount: fiscalForms.spoiledCount,
  exhaustedAt: fiscalForms.exhaustedAt,
};

/** Alta del lote: el rango autorizado y los datos de la imprenta (Art. 13 nums. 15 y 16). */
export const createLot = async (
  db: BillingDb,
  input: CreateFiscalFormLotInput,
  actor: ActorContext,
): Promise<FiscalFormLot> => {
  const desde = valorDeControl(input.controlFrom);
  const hasta = valorDeControl(input.controlTo);
  if (desde === null || hasta === null) {
    throw new ConflictError(
      'El número de control tiene que ser numérico: el rango se consume en orden',
      {
        extensions: { controlFrom: input.controlFrom, controlTo: input.controlTo },
      },
    );
  }
  if (hasta < desde) {
    throw new ConflictError('El rango está al revés: el control «desde» es mayor que el «hasta»', {
      extensions: { controlFrom: input.controlFrom, controlTo: input.controlTo },
    });
  }

  const [serie] = await db
    .select()
    .from(invoiceSeries)
    .where(eq(invoiceSeries.series, input.series))
    .limit(1);
  if (serie === undefined) {
    throw new NotFoundError(`La serie ${input.series} no existe`);
  }

  const existentes = await db.select().from(fiscalForms).where(eq(fiscalForms.seriesId, serie.id));
  const solapado = existentes.find((fila) => {
    const suDesde = valorDeControl(fila.controlFrom) ?? 0;
    const suHasta = valorDeControl(fila.controlTo) ?? suDesde;
    return desde <= suHasta && suDesde <= hasta;
  });
  if (solapado !== undefined) {
    throw new ConflictError(
      `Ese rango se cruza con el lote ${solapado.controlFrom}–${solapado.controlTo} de la serie ${serie.series}`,
      { extensions: { controlFrom: input.controlFrom, controlTo: input.controlTo } },
    );
  }

  const ancho = Math.max(input.controlFrom.length, input.controlTo.length);
  const controlFrom = formatearControl(desde, ancho);
  const controlTo = formatearControl(hasta, ancho);

  return db.transaction(async (tx) => {
    const [nuevo] = await tx
      .insert(fiscalForms)
      .values({
        seriesId: serie.id,
        controlFrom,
        controlTo,
        nextControl: controlFrom,
        printerName: input.printerName,
        printerRif: input.printerRif,
        authorizationRef: input.authorizationRef,
        authorizationDate: input.authorizationDate,
        printDate: input.printDate,
        receivedAt: new Date(),
      })
      .returning();
    if (nuevo === undefined) throw new Error('no se pudo dar de alta el lote');

    await publish(tx, {
      topic: EVENT_TOPICS.formsRegistered,
      aggregateId: nuevo.id,
      actor,
      payload: {
        ...auditPayload({
          entityId: nuevo.id,
          action: 'fiscal_forms_registered',
          entityType: 'invoice',
          summary: `Lote de formas libres ${serie.series}: del ${controlFrom} al ${controlTo} (${input.printerName})`,
          changedFields: [],
          after: {
            series: serie.series,
            controlFrom,
            controlTo,
            authorizationRef: input.authorizationRef,
          },
          actor,
        }),
        lot: { series: serie.series, controlFrom, controlTo, remaining: hasta - desde + 1 },
      },
    });

    return aLote({ ...nuevo, series: serie.series });
  });
};

export const listLots = async (db: BillingDb, series?: string): Promise<FiscalFormLot[]> => {
  const filas = await db
    .select(columnasDelLote)
    .from(fiscalForms)
    .innerJoin(invoiceSeries, eq(invoiceSeries.id, fiscalForms.seriesId))
    .where(series === undefined ? undefined : eq(invoiceSeries.series, series))
    .orderBy(asc(invoiceSeries.series), asc(fiscalForms.controlFrom));
  return filas.map(aLote);
};

/** El lote del que se consume: el más antiguo que todavía tenga formas. */
export const activeLot = async (db: BillingDb, series: string): Promise<FiscalFormLot | null> => {
  const [fila] = await db
    .select(columnasDelLote)
    .from(fiscalForms)
    .innerJoin(invoiceSeries, eq(invoiceSeries.id, fiscalForms.seriesId))
    .where(
      and(
        eq(invoiceSeries.series, series),
        isNull(fiscalForms.exhaustedAt),
        sql`${fiscalForms.nextControl} <= ${fiscalForms.controlTo}`,
      ),
    )
    .orderBy(asc(fiscalForms.controlFrom))
    .limit(1);
  return fila === undefined ? null : aLote(fila);
};

/** Lo mínimo para consumir: así sirve igual dentro de la emisión y del marcado de una forma dañada. */
export interface LoteConsumible {
  id: string;
  controlFrom: string;
  controlTo: string;
  nextControl: string;
}

/**
 * Toma el control que toca y avanza el lote. **Dentro de la transacción** de quien lo llama: el
 * número y el documento se guardan juntos o no se guarda ninguno.
 */
export const consumeControl = async (
  tx: Pick<BillingDb, 'update'>,
  lote: LoteConsumible,
): Promise<string> => {
  const actual = valorDeControl(lote.nextControl);
  if (actual === null) throw new ConflictError('El lote tiene un control ilegible');
  const ancho = lote.controlFrom.length;
  const siguiente = formatearControl(actual + 1, ancho);
  const agotado = siguiente > lote.controlTo;

  await tx
    .update(fiscalForms)
    .set({ nextControl: siguiente, exhaustedAt: agotado ? new Date() : null })
    .where(eq(fiscalForms.id, lote.id));

  return lote.nextControl;
};

/**
 * Marca una forma como **dañada**: ocupa su control, se cuenta y se conserva. El documento no se
 * destruye (Art. 36) ni la forma se reutiliza.
 */
export const spoilForm = async (
  db: BillingDb,
  lotId: string,
  input: SpoilFiscalFormInput,
  actor: ActorContext,
): Promise<FiscalFormLot> =>
  db.transaction(async (tx) => {
    const [fila] = await tx
      .select(columnasDelLote)
      .from(fiscalForms)
      .innerJoin(invoiceSeries, eq(invoiceSeries.id, fiscalForms.seriesId))
      .where(eq(fiscalForms.id, lotId))
      .limit(1);
    if (fila === undefined) throw new NotFoundError('Ese lote de formas no existe');
    if (fila.exhaustedAt !== null) {
      throw new ConflictError('Ese lote ya está agotado: da de alta el rango siguiente', {
        extensions: { lote: lotId },
      });
    }

    const control = await consumeControl(tx, fila);
    const [actualizado] = await tx
      .update(fiscalForms)
      .set({ spoiledCount: fila.spoiledCount + 1 })
      .where(eq(fiscalForms.id, lotId))
      .returning();
    if (actualizado === undefined) throw new Error('no se pudo marcar la forma');

    await publish(tx, {
      topic: EVENT_TOPICS.formsRegistered,
      aggregateId: lotId,
      actor,
      payload: {
        ...auditPayload({
          entityId: lotId,
          action: 'fiscal_form_spoiled',
          entityType: 'invoice',
          summary: `Forma libre ${control} de la serie ${fila.series} estropeada (se conserva)`,
          changedFields: ['spoiled_count'],
          before: { spoiledCount: fila.spoiledCount },
          after: { spoiledCount: fila.spoiledCount + 1 },
          reason: input.reason,
          actor,
        }),
        lot: { series: fila.series, control, remaining: null },
      },
    });

    return aLote({ ...actualizado, series: fila.series });
  });
