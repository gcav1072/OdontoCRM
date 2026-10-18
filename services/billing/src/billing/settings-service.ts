import { type BillingSettings, type UpdateBillingSettingsInput } from '@odontocrm/contracts';
import { EVENT_TOPICS } from '@odontocrm/events';
import { NotFoundError, stableUuid } from '@odontocrm/kernel';
import { eq } from 'drizzle-orm';

import type { BillingDb } from '../db/client.js';
import { billingSettings } from '../db/schema.js';
import type { ActorContext } from '../shared/context.js';
import { auditPayload, publish } from '../shared/events.js';

/**
 * La configuración **fiscal** de la caja (ADR 0045 y 0069): una sola fila (`chk_billing_settings_
 * single_row`), sembrada por la migración y editable solo por el `admin` (`settings:manage`), con
 * cada cambio auditado.
 *
 * `isSpecialTaxpayer` **no se autodeclara**: lo notifica el SENIAT, y por eso el panel guarda junto al
 * interruptor la fecha y el oficio de la calificación. La alícuota del IGTF (`igtfRateBp`) se **copia**
 * en cada cobro: cambiarla aquí no reescribe lo ya percibido.
 */

/**
 * Identificador del agregado en el sobre del evento y en la auditoría.
 *
 * La fila se identifica con un entero (`id = 1`), pero el contrato exige un UUID en
 * `aggregateId`/`entityId`; sin esta derivación, `toOutboxInsert` lanzaba un `ZodError`
 * **dentro de la transacción** y el `PATCH` de `/configuracion` respondía 500 sin guardar
 * nada. El grano del evento es **la configuración**, no la fila, así que la clave es
 * estable y no depende de un contador.
 */
const ID_CONFIGURACION = stableUuid('billing_settings:1');

interface FilaAjustes {
  isSpecialTaxpayer: boolean;
  speNotifiedAt: string | null;
  speReference: string | null;
  igtfRateBp: number;
  imputationPolicy: string;
  rateGraceDays: number;
  foreignCurrencyIvaBasisPoints: number;
  updatedAt: Date;
}

const aSettings = (fila: FilaAjustes): BillingSettings => ({
  isSpecialTaxpayer: fila.isSpecialTaxpayer,
  speNotifiedAt: fila.speNotifiedAt,
  speReference: fila.speReference,
  igtfRateBp: fila.igtfRateBp,
  // El `CHECK` de la tabla garantiza que es una política del contrato.
  imputationPolicy: fila.imputationPolicy as BillingSettings['imputationPolicy'],
  rateGraceDays: fila.rateGraceDays,
  foreignCurrencyIvaBasisPoints: fila.foreignCurrencyIvaBasisPoints,
  updatedAt: fila.updatedAt.toISOString(),
});

export const getBillingSettings = async (db: BillingDb): Promise<BillingSettings> => {
  const [fila] = await db.select().from(billingSettings).limit(1);
  if (fila === undefined) {
    throw new NotFoundError('La configuración de la caja no está sembrada: corre las migraciones');
  }
  return aSettings(fila);
};

/**
 * El `PATCH` fiscal: **parcial**, lo que no se manda no se toca. Cada cambio queda en la auditoría con
 * su antes y su después —encender el interruptor del SENIAT es un acto que se tiene que poder rastrear—.
 */
export const updateBillingSettings = async (
  db: BillingDb,
  input: UpdateBillingSettingsInput,
  actor: ActorContext,
): Promise<BillingSettings> => {
  const antes = await getBillingSettings(db);

  const cambios: Partial<{
    isSpecialTaxpayer: boolean;
    speNotifiedAt: string | null;
    speReference: string | null;
    igtfRateBp: number;
  }> = {};
  if (input.isSpecialTaxpayer !== undefined) cambios.isSpecialTaxpayer = input.isSpecialTaxpayer;
  if (input.speNotifiedAt !== undefined) cambios.speNotifiedAt = input.speNotifiedAt;
  if (input.speReference !== undefined) cambios.speReference = input.speReference;
  if (input.igtfRateBp !== undefined) cambios.igtfRateBp = input.igtfRateBp;

  const despues = await db.transaction(async (tx) => {
    const [fila] = await tx
      .update(billingSettings)
      .set({
        ...cambios,
        updatedAt: new Date(),
        updatedByUserId: actor.actorId ?? null,
      })
      .where(eq(billingSettings.id, 1))
      .returning();
    if (fila === undefined) throw new Error('no se pudo actualizar la configuración de la caja');

    await publish(tx, {
      topic: EVENT_TOPICS.settingsChanged,
      aggregateId: ID_CONFIGURACION,
      actor,
      payload: {
        ...auditPayload({
          entityId: ID_CONFIGURACION,
          action: 'billing_settings_changed',
          entityType: 'billing_settings',
          summary: `Configuración fiscal de la caja actualizada: SPE ${fila.isSpecialTaxpayer ? 'sí' : 'no'}, IGTF ${String(fila.igtfRateBp)} pb`,
          changedFields: Object.keys(cambios),
          before: antes,
          after: aSettings(fila),
          actor,
        }),
        settings: aSettings(fila),
      },
    });

    return aSettings(fila);
  });

  return despues;
};
