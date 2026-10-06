import { outboxEvents } from '@odontocrm/db';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadBillingConfig } from './config.js';
import { createBillingDatabase } from './db/client.js';
import { exchangeRates } from './db/schema.js';
import { daysBetween, listRates, rateForDate, rateStatus, setRate } from './rates/rate-service.js';

/**
 * Pruebas de integración de la tasa del BCV (ADR 0046) contra PostgreSQL real:
 *  1. se da de alta y queda como vigente de ese día (sin hueco);
 *  2. **corregir** marca la fila anterior y exige motivo: la historia no se reescribe;
 *  3. los días sin publicación **arrastran** la última tasa, y un hueco mayor al umbral pide
 *     confirmación (M8);
 *  4. sin ninguna tasa publicada, la caja no puede cobrar y lo dice;
 *  5. el alta deja su evento en el outbox con la carga de auditoría (B10) y el bloque `rate`.
 *
 * Usa días de 1990 para no pisar tasas reales y limpia lo suyo al terminar (incluido el outbox: un
 * evento sin publicar dejaría al auditor denunciando un outbox atascado).
 */
const billingUrl = process.env['TEST_BILLING_DATABASE_URL'];
const ready = billingUrl !== undefined;
const describeWithDatabase = ready ? describe : describe.skip;

const DIA_1 = '1990-01-08';
const DIA_2 = '1990-01-09';
const MARKER = `prueba-tasas-${String(Date.now()).slice(-7)}`;

const actor = {
  actorId: null,
  actorUsername: MARKER,
  ip: '127.0.0.1',
  userAgent: 'vitest',
  requestId: `req-${MARKER}`,
};

describeWithDatabase('la tasa del día', () => {
  let handle: Awaited<ReturnType<typeof createBillingDatabase>>;
  const ids: string[] = [];

  const guardar = async (rateDate: string, rate: string, note: string | null = null) => {
    const fila = await setRate(handle.db, { rateDate, rate, note }, actor);
    ids.push(fila.id);
    return fila;
  };

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
    await handle.db.delete(exchangeRates).where(eq(exchangeRates.setByUsername, MARKER));
    await handle.close();
  });

  it('sin ninguna tasa publicada, la caja no puede cobrar', async () => {
    const estado = await rateStatus(handle.db, '1989-12-31');
    expect(estado).toEqual({ current: null, gapDays: 0, needsConfirmation: true });
    expect(await rateForDate(handle.db, '1989-12-31')).toBeNull();
  });

  it('el alta deja la tasa vigente de ese día', async () => {
    const fila = await guardar(DIA_1, '36,5420');
    expect(fila).toMatchObject({ rateDate: DIA_1, rateMicros: 36_542_000, source: 'manual' });

    const estado = await rateStatus(handle.db, DIA_1);
    expect(estado.current?.rateMicros).toBe(36_542_000);
    expect(estado.gapDays).toBe(0);
    expect(estado.needsConfirmation).toBe(false);
  });

  it('los días sin publicación arrastran la última tasa, y el hueco se informa', async () => {
    // Dos días después: la tasa del 8 sigue vigente y arrastra 2 días (menos que el umbral de 5).
    const cerca = await rateStatus(handle.db, '1990-01-10');
    expect(cerca.current?.rateDate).toBe(DIA_1);
    expect(cerca.gapDays).toBe(2);
    expect(cerca.needsConfirmation).toBe(false);

    // Diez días después: el hueco pasa el umbral y cobrar exige confirmar.
    const lejos = await rateStatus(handle.db, '1990-01-18');
    expect(lejos.gapDays).toBe(10);
    expect(lejos.needsConfirmation).toBe(true);
  });

  it('corregir la tasa del día exige motivo y marca la anterior, no la edita', async () => {
    await expect(guardar(DIA_1, '40,0000')).rejects.toThrow(/motivo/);

    const corregida = await guardar(DIA_1, '40,0000', 'El BCV publicó una corrección');
    expect(corregida.rateMicros).toBe(40_000_000);

    const estado = await rateStatus(handle.db, DIA_1);
    expect(estado.current?.rateMicros).toBe(40_000_000);
    expect(estado.current?.note).toBe('El BCV publicó una corrección');

    // La anterior sigue en la historia, marcada como superada.
    const historia = await handle.db
      .select()
      .from(exchangeRates)
      .where(eq(exchangeRates.rateDate, DIA_1));
    const vieja = historia.find((fila) => fila.rateMicros === 36_542_000);
    expect(vieja?.supersededById).toBe(corregida.id);
    expect(vieja?.supersedesId).toBeNull();
  });

  it('el historial va del día más reciente al más viejo y admite filtros', async () => {
    await guardar(DIA_2, '41,2500');
    const todo = await listRates(handle.db, { from: '1990-01-01', to: '1990-01-31' });
    expect(todo.map((fila) => fila.rateDate)).toEqual([DIA_2, DIA_1, DIA_1]);

    const soloElNueve = await listRates(handle.db, { from: DIA_2, to: DIA_2 });
    expect(soloElNueve).toHaveLength(1);
    expect(soloElNueve[0]?.rateMicros).toBe(41_250_000);
  });

  it('cada alta deja su evento en el outbox con la carga de auditoría', async () => {
    const eventos = await handle.db
      .select({ envelope: outboxEvents.envelope, eventType: outboxEvents.eventType })
      .from(outboxEvents)
      .where(inArray(outboxEvents.aggregateId, ids));

    expect(eventos).toHaveLength(3);
    expect(eventos.every((evento) => evento.eventType === 'billing.rate.set')).toBe(true);

    const carga = (eventos[0]?.envelope as { payload?: Record<string, unknown> } | undefined)
      ?.payload;
    expect(carga?.['action']).toBe('exchange_rate_set');
    expect(carga?.['entityType']).toBe('exchange_rate');
    expect(carga?.['rate']).toMatchObject({
      rateDate: DIA_1,
      rateMicros: 36_542_000,
      source: 'manual',
    });
  });

  it('la tasa ilegible se rechaza antes de escribir nada', async () => {
    await expect(guardar('1990-01-11', 'treinta y seis')).rejects.toThrow(/tasa no válida/);

    // No se escribió ninguna fila para ese día…
    const filas = await handle.db
      .select()
      .from(exchangeRates)
      .where(eq(exchangeRates.rateDate, '1990-01-11'));
    expect(filas).toHaveLength(0);
    // …y la vigente sigue siendo la del 9, que es la que arrastra la caja.
    expect((await rateForDate(handle.db, '1990-01-11'))?.rate.rateDate).toBe(DIA_2);
  });
});

describe('los días entre dos fechas', () => {
  it('se cuentan en días de calendario', () => {
    expect(daysBetween('1990-01-08', '1990-01-08')).toBe(0);
    expect(daysBetween('1990-01-08', '1990-01-10')).toBe(2);
    expect(daysBetween('1990-01-08', '1989-12-31')).toBe(-8);
    // Un cambio de mes y de año no se le escapa.
    expect(daysBetween('2026-12-31', '2027-01-01')).toBe(1);
  });
});
