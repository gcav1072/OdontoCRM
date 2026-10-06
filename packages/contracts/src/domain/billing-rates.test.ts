import { describe, expect, it } from 'vitest';

import { rateDateInCaracas, rateToMicros, setExchangeRateSchema } from './billing.js';

/**
 * La tasa del día (ADR 0046): **cuándo** es «hoy» y **cómo** entra la tasa. Va en su propio archivo
 * porque el contrato de la tasa llegó con la sesión B del módulo, después del de la aritmética.
 */
describe('el día de la tasa y del hecho imponible', () => {
  it('es el de Caracas, no el de UTC', () => {
    // 2026-10-06 a las 02:00 UTC son las 22:00 del **5** en Caracas (UTC−4).
    expect(rateDateInCaracas(new Date('2026-10-06T02:00:00.000Z'))).toBe('2026-10-05');
    // Y a las 04:00 UTC ya es el 6 en Caracas.
    expect(rateDateInCaracas(new Date('2026-10-06T04:00:00.000Z'))).toBe('2026-10-06');
    expect(rateDateInCaracas(new Date('2026-12-31T23:00:00.000Z'))).toBe('2026-12-31');
  });
});

describe('la tasa se pide como se teclea', () => {
  it('y se guarda en micros', () => {
    expect(setExchangeRateSchema.parse({ rateDate: '2026-10-06', rate: '36,5420' })).toEqual({
      rateDate: '2026-10-06',
      rate: '36,5420',
      note: null,
    });
    expect(rateToMicros('36,5420')).toBe(36_542_000);
  });

  it('una fecha que no es AAAA-MM-DD o una tasa vacía se rechazan', () => {
    expect(
      setExchangeRateSchema.safeParse({ rateDate: '06/10/2026', rate: '36,5420' }).success,
    ).toBe(false);
    expect(setExchangeRateSchema.safeParse({ rateDate: '2026-10-06', rate: '' }).success).toBe(
      false,
    );
  });
});
