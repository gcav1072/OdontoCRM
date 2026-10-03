import { describe, expect, it } from 'vitest';

import { createRng, hashSeed, SeededRandom, TEST_MODE_SEED } from './prng.js';

describe('generador determinista', () => {
  it('produce la misma secuencia con la misma semilla', () => {
    const first = createRng('semilla-fija');
    const second = createRng('semilla-fija');

    const sequenceA = Array.from({ length: 25 }, () => first.next());
    const sequenceB = Array.from({ length: 25 }, () => second.next());

    expect(sequenceA).toEqual(sequenceB);
  });

  it('produce secuencias distintas con semillas distintas', () => {
    const a = Array.from({ length: 10 }, () => createRng('a').next());
    const b = Array.from({ length: 10 }, () => createRng('b').next());
    expect(a).not.toEqual(b);
  });

  it('la semilla del modo test es estable (no cambiar sin avisar)', () => {
    expect(TEST_MODE_SEED).toBe('odontocrm-2026');
    expect(hashSeed(TEST_MODE_SEED)).toBe(hashSeed('odontocrm-2026'));
  });

  it('genera enteros dentro del rango y siempre el mismo primero', () => {
    const rng = createRng('enteros');
    for (let index = 0; index < 200; index += 1) {
      const value = rng.int(5, 9);
      expect(value).toBeGreaterThanOrEqual(5);
      expect(value).toBeLessThanOrEqual(9);
      expect(Number.isInteger(value)).toBe(true);
    }

    const fixed = new SeededRandom('reproducible');
    const other = new SeededRandom('reproducible');
    expect(fixed.int(0, 1_000_000)).toBe(other.int(0, 1_000_000));
  });

  it('elige elementos de una lista y falla si está vacía', () => {
    const rng = createRng('listas');
    expect(['a', 'b', 'c']).toContain(rng.pick(['a', 'b', 'c']));
    expect(() => rng.pick([])).toThrowError(RangeError);
  });

  it('respeta los pesos en la elección ponderada', () => {
    const rng = createRng('pesos');
    let favouring = 0;
    for (let index = 0; index < 500; index += 1) {
      if (
        rng.weighted([
          { value: 'comun', weight: 9 },
          { value: 'raro', weight: 1 },
        ]) === 'comun'
      ) {
        favouring += 1;
      }
    }
    expect(favouring).toBeGreaterThan(380);
    expect(() => rng.weighted([{ value: 'x', weight: 0 }])).toThrowError(RangeError);
  });

  it('mezcla sin perder elementos', () => {
    const rng = createRng('mezcla');
    const original = ['1', '2', '3', '4', '5'];
    const shuffled = rng.shuffle(original);

    expect([...shuffled].sort()).toEqual([...original].sort());
    expect(original).toEqual(['1', '2', '3', '4', '5']);
  });

  it('genera fechas dentro del rango pedido', () => {
    const rng = createRng('fechas');
    const from = new Date('2026-01-01T00:00:00.000Z');
    const to = new Date('2026-10-02T23:59:59.000Z');

    for (let index = 0; index < 50; index += 1) {
      const date = rng.dateBetween(from, to);
      expect(date.getTime()).toBeGreaterThanOrEqual(from.getTime());
      expect(date.getTime()).toBeLessThanOrEqual(to.getTime());
    }

    expect(() => rng.dateBetween(to, from)).toThrowError(RangeError);
  });
});
