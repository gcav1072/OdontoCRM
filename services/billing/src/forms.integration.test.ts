import type { CreateFiscalFormLotInput } from '@odontocrm/contracts';
import { outboxEvents } from '@odontocrm/db';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  activeLot,
  consumeControl,
  createLot,
  listLots,
  spoilForm,
} from './billing/fiscal-forms-service.js';
import { loadBillingConfig } from './config.js';
import { createBillingDatabase } from './db/client.js';
import { fiscalForms } from './db/schema.js';

/**
 * Pruebas de integración del lote de formas libres (ADR 0047) contra PostgreSQL real:
 *  1. el alta normaliza el rango y deja el lote listo para consumir;
 *  2. dos lotes de la misma serie **no pueden solaparse** (un control repetido sería un documento
 *     repetido), ni el rango ir al revés, ni ser alfanumérico;
 *  3. los controles se consumen **en orden** y el lote se agota solo;
 *  4. una forma dañada ocupa su control, se cuenta y **se conserva**;
 *  5. quedan pocas formas ⇒ la caja lo avisa;
 *  6. el alta y la forma dañada dejan su evento en el outbox con la carga de auditoría.
 *
 * El rango y el RIF son **únicos por corrida**: si una corrida anterior murió a medias, sus lotes no
 * pueden chocar con estos (ni al revés). Y limpia lo suyo, **incluido el outbox**: un evento sin
 * publicar dejaría al auditor denunciando un outbox atascado.
 */
const billingUrl = process.env['TEST_BILLING_DATABASE_URL'];
const ready = billingUrl !== undefined;
const describeWithDatabase = ready ? describe : describe.skip;

const MARKER = `prueba-formas-${String(Date.now()).slice(-7)}`;
/** Base numérica única por corrida: 12 dígitos, dentro del tope de 15 del validador. */
const BASE = Number(String(Date.now()).slice(-9)) * 1000;
const RIF = `J-${String(Date.now()).slice(-8)}`;

const actor = {
  actorId: null,
  actorUsername: MARKER,
  ip: '127.0.0.1',
  userAgent: 'vitest',
  requestId: `req-${MARKER}`,
};

const rango = (desde: number, hasta: number): [string, string] => [
  String(BASE + desde),
  String(BASE + hasta),
];

const lote = (
  desde: number,
  hasta: number,
  extra: Partial<CreateFiscalFormLotInput> = {},
): CreateFiscalFormLotInput => ({
  series: 'A',
  controlFrom: rango(desde, hasta)[0],
  controlTo: rango(desde, hasta)[1],
  printerName: `Imprenta ${MARKER}`,
  printerRif: RIF,
  authorizationRef: 'Providencia 0071/2026',
  authorizationDate: '2026-09-30',
  printDate: '2026-10-01',
  ...extra,
});

describeWithDatabase('el lote de formas libres', () => {
  let handle: Awaited<ReturnType<typeof createBillingDatabase>>;
  const ids: string[] = [];

  beforeAll(async () => {
    if (!ready) throw new Error('falta TEST_BILLING_DATABASE_URL');
    handle = createBillingDatabase(
      loadBillingConfig({ DATABASE_URL: billingUrl, LOG_LEVEL: 'silent' }),
    );
  });

  afterAll(async () => {
    if (!ready) return;
    if (ids.length > 0) {
      await handle.db.delete(outboxEvents).where(inArray(outboxEvents.aggregateId, ids));
    }
    await handle.db.delete(fiscalForms).where(eq(fiscalForms.printerRif, RIF));
    await handle.close();
  });

  it('el alta normaliza el rango y deja el lote listo para consumir', async () => {
    const nuevo = await createLot(handle.db, lote(1, 500), actor);
    ids.push(nuevo.id);

    expect(nuevo).toMatchObject({
      series: 'A',
      controlFrom: rango(1, 500)[0],
      controlTo: rango(1, 500)[1],
      nextControl: rango(1, 500)[0],
      remaining: 500,
      isLow: false,
      spoiledCount: 0,
      exhaustedAt: null,
    });
  });

  it('dos lotes de la misma serie no pueden solaparse', async () => {
    await expect(createLot(handle.db, lote(400, 900), actor)).rejects.toThrow(/se cruza/);

    // Pegado al anterior sí se puede: el rango empieza donde termina el otro.
    const contiguo = await createLot(handle.db, lote(501, 502), actor);
    ids.push(contiguo.id);
    expect(contiguo.remaining).toBe(2);
    // Y con dos formas, la caja ya avisa de que quedan pocas.
    expect(contiguo.isLow).toBe(true);
  });

  it('el rango no puede ir al revés ni llevar controles no numéricos', async () => {
    await expect(createLot(handle.db, lote(700, 600), actor)).rejects.toThrow(/al revés/);
    await expect(
      createLot(handle.db, lote(800, 900, { controlFrom: 'A0001' }), actor),
    ).rejects.toThrow(/numérico/);
    await expect(createLot(handle.db, lote(800, 900, { series: 'Z' }), actor)).rejects.toThrow(
      /no existe/,
    );
  });

  it('el lote activo es el más antiguo que todavía tenga formas', async () => {
    const activo = await activeLot(handle.db, 'A');
    expect(activo?.controlFrom).toBe(rango(1, 500)[0]);

    const mios = (await listLots(handle.db, 'A')).filter((fila) => fila.printerRif === RIF);
    expect(mios.map((fila) => fila.controlFrom)).toEqual([rango(1, 500)[0], rango(501, 502)[0]]);
  });

  it('los controles se consumen en orden y el lote se agota solo', async () => {
    const [pequeno] = await handle.db
      .select()
      .from(fiscalForms)
      .where(eq(fiscalForms.controlFrom, rango(501, 502)[0]));
    expect(pequeno).toBeDefined();
    if (pequeno === undefined) return;

    const consumible = {
      id: pequeno.id,
      controlFrom: pequeno.controlFrom,
      controlTo: pequeno.controlTo,
      nextControl: pequeno.nextControl,
    };

    const primero = await handle.db.transaction((tx) => consumeControl(tx, consumible));
    expect(primero).toBe(rango(501, 502)[0]);

    const segundo = await handle.db.transaction((tx) =>
      consumeControl(tx, { ...consumible, nextControl: rango(502, 502)[0] }),
    );
    expect(segundo).toBe(rango(502, 502)[0]);

    // Se consumieron las dos que había: el lote queda agotado y ya no se ofrece.
    const gastado = (await listLots(handle.db, 'A')).find(
      (fila) => fila.controlFrom === rango(501, 502)[0],
    );
    expect(gastado?.remaining).toBe(0);
    expect(gastado?.exhaustedAt).not.toBeNull();
    expect(gastado?.isLow).toBe(false);
  });

  it('una forma dañada ocupa su control, se cuenta y se conserva', async () => {
    const [grande] = await handle.db
      .select()
      .from(fiscalForms)
      .where(eq(fiscalForms.controlFrom, rango(1, 500)[0]));
    expect(grande).toBeDefined();
    if (grande === undefined) return;

    const marcado = await spoilForm(
      handle.db,
      grande.id,
      { reason: 'Se atascó en la impresora' },
      actor,
    );
    expect(marcado.spoiledCount).toBe(1);
    expect(marcado.nextControl).toBe(rango(2, 500)[0]);
    expect(marcado.exhaustedAt).toBeNull();
    expect(marcado.remaining).toBe(499);
  });

  it('el alta y la forma dañada dejan su evento en el outbox', async () => {
    const eventos = await handle.db
      .select({ envelope: outboxEvents.envelope, eventType: outboxEvents.eventType })
      .from(outboxEvents)
      .where(inArray(outboxEvents.aggregateId, ids));

    expect(eventos).toHaveLength(3);
    expect(eventos.every((evento) => evento.eventType === 'billing.forms.registered')).toBe(true);

    const acciones = eventos.map(
      (evento) => (evento.envelope as { payload?: { action?: string } }).payload?.action,
    );
    expect(acciones).toContain('fiscal_forms_registered');
    expect(acciones).toContain('fiscal_form_spoiled');
  });
});
