import {
  formatRateMicros,
  rateDateInCaracas,
  rateToMicros,
  type BillingRate,
  type BillingRateStatus,
  type RateSource,
  type SetExchangeRateInput,
} from '@odontocrm/contracts';
import { EVENT_TOPICS } from '@odontocrm/events';
import { ConflictError } from '@odontocrm/kernel';
import { and, desc, eq, gte, isNull, lte } from 'drizzle-orm';

import type { BillingDb } from '../db/client.js';
import { billingSettings, exchangeRates } from '../db/schema.js';
import type { ActorContext } from '../shared/context.js';
import { auditPayload, publish } from '../shared/events.js';

/**
 * La tasa del BCV (ADR 0046): **histórica y de solo agregado**.
 *
 * - una fila por fecha y fuente; una corrección es una fila nueva que **marca** la anterior
 *   (`supersedes_id`), nunca un `update` que reescriba lo que ya se emitió;
 * - la tasa vigente de una fecha es la **última publicada hasta esa fecha** (los fines de semana y
 *   feriados arrastran), y el hueco se informa para que la caja avise (M8);
 * - todo se calcula en el día de `America/Caracas`, no en UTC.
 */

interface FilaTasa {
  id: string;
  rateDate: string;
  rateMicros: number;
  source: string;
  note: string | null;
  setByUsername: string | null;
  createdAt: Date;
}

const aRate = (fila: FilaTasa): BillingRate => ({
  id: fila.id,
  rateDate: fila.rateDate,
  rateMicros: fila.rateMicros,
  // El `CHECK` de la tabla garantiza que es una fuente del contrato.
  source: fila.source as RateSource,
  note: fila.note,
  setByUsername: fila.setByUsername,
  createdAt: fila.createdAt.toISOString(),
});

/** Días entre dos fechas `AAAA-MM-DD` (positivo si `hasta` es posterior). */
export const daysBetween = (desde: string, hasta: string): number =>
  Math.round((Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) / 86_400_000);

/** La tasa vigente para una fecha, con los días que arrastra. `null` = no hay ninguna publicada. */
export const rateForDate = async (
  db: BillingDb,
  date: string,
): Promise<{ rate: BillingRate; gapDays: number } | null> => {
  const [fila] = await db
    .select()
    .from(exchangeRates)
    .where(and(lte(exchangeRates.rateDate, date), isNull(exchangeRates.supersededById)))
    .orderBy(desc(exchangeRates.rateDate))
    .limit(1);
  if (fila === undefined) return null;
  return { rate: aRate(fila), gapDays: daysBetween(fila.rateDate, date) };
};

/**
 * Lo que la caja necesita saber de la tasa: cuál rige, cuántos días arrastra y si hay que confirmar.
 * Sin ninguna tasa publicada **no se puede cobrar** (y se dice, en vez de inventar un 1).
 */
export const rateStatus = async (
  db: BillingDb,
  date: string = rateDateInCaracas(),
): Promise<BillingRateStatus> => {
  const [ajustes] = await db
    .select({ grace: billingSettings.rateGraceDays })
    .from(billingSettings)
    .limit(1);
  const vigente = await rateForDate(db, date);
  if (vigente === null) return { current: null, gapDays: 0, needsConfirmation: true };
  return {
    current: vigente.rate,
    gapDays: vigente.gapDays,
    needsConfirmation: vigente.gapDays > (ajustes?.grace ?? 5),
  };
};

export interface SetRateOptions {
  /** `bcv_oficial` cuando la trae la captura automática; `manual` cuando la teclea la secretaría. */
  source?: Extract<RateSource, 'bcv_oficial' | 'manual'>;
}

/**
 * Da de alta la tasa de un día, o **corrige** la que había.
 *
 * Corregir exige motivo: la fila anterior queda como historia y la nueva apunta a ella. El orden
 * importa: primero se marca la vieja con el `id` de la nueva (que se genera aquí) y después se
 * inserta, porque el índice único parcial admite **una sola** tasa vigente por día.
 */
export const setRate = async (
  db: BillingDb,
  input: SetExchangeRateInput,
  actor: ActorContext,
  options: SetRateOptions = {},
): Promise<BillingRate> => {
  const rateMicros = rateToMicros(input.rate);
  const source = options.source ?? 'manual';

  const [existente] = await db
    .select()
    .from(exchangeRates)
    .where(and(eq(exchangeRates.rateDate, input.rateDate), isNull(exchangeRates.supersededById)))
    .limit(1);

  const motivo = input.note?.trim() ?? '';
  if (existente !== undefined && motivo.length < 3) {
    throw new ConflictError('Corregir la tasa de ese día exige un motivo', {
      extensions: { rateDate: input.rateDate },
    });
  }

  const nuevaId = globalThis.crypto.randomUUID();

  return db.transaction(async (tx) => {
    if (existente !== undefined) {
      await tx
        .update(exchangeRates)
        .set({ supersededById: nuevaId })
        .where(eq(exchangeRates.id, existente.id));
    }

    const [nueva] = await tx
      .insert(exchangeRates)
      .values({
        id: nuevaId,
        rateDate: input.rateDate,
        rateMicros,
        source,
        supersedesId: existente?.id ?? null,
        note: motivo === '' ? null : motivo,
        rawPayload: null,
        setByUserId: actor.actorId,
        setByUsername: actor.actorUsername,
      })
      .returning();
    if (nueva === undefined) throw new Error('no se pudo guardar la tasa');

    await publish(tx, {
      topic: EVENT_TOPICS.rateSet,
      aggregateId: nueva.id,
      actor,
      payload: {
        ...auditPayload({
          entityId: nueva.id,
          action: 'exchange_rate_set',
          entityType: 'exchange_rate',
          summary:
            existente === undefined
              ? `Tasa del ${input.rateDate}: ${formatRateMicros(rateMicros)} Bs./USD`
              : `Tasa del ${input.rateDate} corregida a ${formatRateMicros(rateMicros)} Bs./USD`,
          changedFields: existente === undefined ? [] : ['rate_micros'],
          before: existente === undefined ? null : { rateMicros: existente.rateMicros },
          after: { rateMicros },
          reason: motivo === '' ? null : motivo,
          actor,
        }),
        // Lo que necesita el consumidor (ADR 0041): el día, la tasa y de dónde salió.
        rate: { rateDate: input.rateDate, rateMicros, source },
      },
    });

    return aRate(nueva);
  });
};

/** El historial, del día más reciente al más viejo (incluye las correcciones). */
export const listRates = async (
  db: BillingDb,
  filtros: { from?: string | undefined; to?: string | undefined } = {},
): Promise<BillingRate[]> => {
  const condiciones = [
    filtros.from === undefined ? undefined : gte(exchangeRates.rateDate, filtros.from),
    filtros.to === undefined ? undefined : lte(exchangeRates.rateDate, filtros.to),
  ].filter((condicion) => condicion !== undefined);

  const filas = await db
    .select()
    .from(exchangeRates)
    .where(condiciones.length === 0 ? undefined : and(...condiciones))
    .orderBy(desc(exchangeRates.rateDate), desc(exchangeRates.createdAt))
    .limit(120);
  return filas.map(aRate);
};
