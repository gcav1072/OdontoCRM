import { domainAuditPayloadSchema } from '@odontocrm/contracts';
import { outboxEvents } from '@odontocrm/db';
import { domainEventSchema } from '@odontocrm/events';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getBillingSettings, updateBillingSettings } from './billing/settings-service.js';
import { loadBillingConfig } from './config.js';
import { createBillingDatabase } from './db/client.js';
import { billingSettings } from './db/schema.js';

/**
 * El `PATCH` de la configuración fiscal (SPE y alícuota del IGTF, ADR 0045 y 0069).
 *
 * Lo que se prueba aquí no es la validación de los campos —eso es del contrato— sino
 * que el cambio **se publica y se audita**, porque el evento viaja dentro de la misma
 * transacción: si el sobre no valida, el `PATCH` entero revierte y el panel responde
 * 500. La fila es un entero (`id = 1`), así que el `aggregateId` no puede salir de la
 * tabla: lo deriva `stableUuid`.
 */
const billingUrl = process.env['TEST_BILLING_DATABASE_URL'];
const ready = billingUrl !== undefined;
const describeWithDatabase = ready ? describe : describe.skip;

const MARKER = `prueba-ajustes-${String(Date.now()).slice(-7)}`;

const actor = {
  actorId: null,
  actorUsername: MARKER,
  ip: '127.0.0.1',
  userAgent: 'vitest',
  requestId: `req-${MARKER}`,
};

describeWithDatabase('configuración fiscal de la caja', () => {
  let handle: Awaited<ReturnType<typeof createBillingDatabase>>;
  let original: Awaited<ReturnType<typeof getBillingSettings>> | undefined;

  beforeAll(async () => {
    if (!ready) throw new Error('falta TEST_BILLING_DATABASE_URL');
    handle = createBillingDatabase(
      loadBillingConfig({ DATABASE_URL: billingUrl, LOG_LEVEL: 'silent' }),
    );
    original = await getBillingSettings(handle.db);
  });

  afterAll(async () => {
    if (!ready || original === undefined) return;
    // La fila se deja exactamente como estaba: esta suite no toca el régimen fiscal real.
    await handle.db
      .update(billingSettings)
      .set({
        isSpecialTaxpayer: original.isSpecialTaxpayer,
        speNotifiedAt: original.speNotifiedAt,
        speReference: original.speReference,
        igtfRateBp: original.igtfRateBp,
      })
      .where(eq(billingSettings.id, 1));
    await handle.db
      .delete(outboxEvents)
      .where(sql`${outboxEvents.envelope}->'payload'->>'actorUsername' = ${MARKER}`);
    await handle.close();
  });

  it('guarda el SPE con su oficio y publica un evento y una auditoría válidos', async () => {
    const guardada = await updateBillingSettings(
      handle.db,
      {
        isSpecialTaxpayer: true,
        speNotifiedAt: '2026-10-14',
        speReference: 'SNAT/2026/000123',
        igtfRateBp: 300,
      },
      actor,
    );

    expect(guardada).toMatchObject({
      isSpecialTaxpayer: true,
      speNotifiedAt: '2026-10-14',
      speReference: 'SNAT/2026/000123',
      igtfRateBp: 300,
    });

    // Persistió: la lectura siguiente lo ve (el 500 de antes dejaba la fila intacta).
    expect((await getBillingSettings(handle.db)).isSpecialTaxpayer).toBe(true);

    const filas = await handle.db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.eventType, 'billing.settings.changed'))
      .orderBy(sql`${outboxEvents.occurredAt} desc`)
      .limit(1);
    const fila = filas[0];
    expect(fila).toBeDefined();
    if (fila === undefined) return;

    // El sobre completo pasa el contrato del outbox: esto es lo que fallaba con el id entero.
    const sobre = domainEventSchema.parse(fila.envelope);
    expect(sobre.eventType).toBe('billing.settings.changed');
    expect(sobre.aggregateId).toMatch(/^[0-9a-f-]{36}$/);

    // Y la carga de auditoría también: `entityId` es un UUID, no el `1` de la fila.
    const carga = domainAuditPayloadSchema.parse(sobre.payload);
    expect(carga.entityType).toBe('billing_settings');
    expect(carga.action).toBe('billing_settings_changed');
    expect(carga.actorUsername).toBe(MARKER);
    expect(carga.changedFields).toEqual(
      expect.arrayContaining(['isSpecialTaxpayer', 'igtfRateBp', 'speNotifiedAt', 'speReference']),
    );
    expect(carga.before).not.toBeNull();
    expect(carga.after).not.toBeNull();
    // El identificador del evento y el de la auditoría son el mismo agregado.
    expect(carga.entityId).toBe(sobre.aggregateId);
  });

  it('el PATCH es parcial: lo que no se manda no se toca', async () => {
    // La alícuota cambia sola; el SPE y su oficio siguen como los dejó la prueba anterior.
    const guardada = await updateBillingSettings(handle.db, { igtfRateBp: 200 }, actor);

    expect(guardada.igtfRateBp).toBe(200);
    expect(guardada.isSpecialTaxpayer).toBe(true);
    expect(guardada.speReference).toBe('SNAT/2026/000123');
  });
});
