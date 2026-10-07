import { describe, expect, it } from 'vitest';

import { diaEnCaracas, rangoDelLibro } from './book-service.js';

/**
 * Las cuentas de fechas del libro, que son las que hacen que el contador cuadre: el día es el de
 * **Caracas** (no el del servidor, que puede estar en UTC) y el rango por defecto es el **mes en
 * curso**, con el último día bien calculado (febrero incluido).
 */
describe('el rango del libro', () => {
  it('sin fechas toma el mes en curso', () => {
    expect(rangoDelLibro({}, '2026-10-06')).toEqual({ from: '2026-10-01', to: '2026-10-31' });
  });

  it('el último día del mes se calcula, no se supone', () => {
    expect(rangoDelLibro({}, '2026-02-10').to).toBe('2026-02-28');
    expect(rangoDelLibro({}, '2028-02-10').to).toBe('2028-02-29');
    expect(rangoDelLibro({}, '2026-04-01').to).toBe('2026-04-30');
    expect(rangoDelLibro({}, '2026-12-31').to).toBe('2026-12-31');
  });

  it('lo que se pide manda, y se puede pedir solo un extremo', () => {
    expect(rangoDelLibro({ from: '2026-01-01', to: '2026-03-15' }, '2026-10-06')).toEqual({
      from: '2026-01-01',
      to: '2026-03-15',
    });
    expect(rangoDelLibro({ from: '2025-06-01' }, '2026-10-06')).toEqual({
      from: '2025-06-01',
      to: '2026-10-31',
    });
    expect(rangoDelLibro({ to: '2026-03-15' }, '2026-10-06')).toEqual({
      from: '2026-10-01',
      to: '2026-03-15',
    });
  });
});

describe('el día de Caracas', () => {
  it('las 02:00 UTC del 5 son las 22:00 del 4 en Caracas', () => {
    expect(diaEnCaracas(new Date('2026-10-05T02:00:00.000Z'))).toBe('2026-10-04');
    expect(diaEnCaracas(new Date('2026-10-05T14:00:00.000Z'))).toBe('2026-10-05');
    // Y el cambio de año, que es donde un `getDate()` local se equivoca.
    expect(diaEnCaracas(new Date('2027-01-01T02:00:00.000Z'))).toBe('2026-12-31');
  });
});
