import { describe, expect, it } from 'vitest';

import {
  formatUsd,
  lineTotalCents,
  linesReady,
  parseUsdToCents,
  toDraftItems,
  toEditableLine,
  type EditableLine,
} from './caja';

/**
 * Piezas puras de la caja: lo que se teclea, lo que se muestra y lo que se manda. La prueba corre en
 * Node (sin DOM).
 */
describe('el dinero en la caja', () => {
  it('se escribe con dos decimales y coma', () => {
    expect(formatUsd(0)).toBe('0,00');
    expect(formatUsd(1234)).toBe('12,34');
    expect(formatUsd(100_000)).toBe('1.000,00');
  });

  it('lo que se teclea se convierte a céntimos, y lo que no es un importe se rechaza', () => {
    expect(parseUsdToCents('12,34')).toBe(1234);
    expect(parseUsdToCents('12.34')).toBe(1234);
    expect(parseUsdToCents('12')).toBe(1200);
    expect(parseUsdToCents('12,5')).toBe(1250);
    expect(parseUsdToCents(' 50,00 ')).toBe(5000);
    // Un cero escrito a mano es un precio legítimo; el vacío y la basura no.
    expect(parseUsdToCents('0')).toBe(0);
    expect(parseUsdToCents('')).toBeNull();
    expect(parseUsdToCents('12,345')).toBeNull();
    expect(parseUsdToCents('doce')).toBeNull();
    expect(parseUsdToCents('-5')).toBeNull();
  });

  it('una partida sin precio llega con el campo vacío y marcada', () => {
    const linea = toEditableLine({
      id: '11111111-1111-4111-8111-111111111111',
      code: 'profilaxis',
      description: 'Profilaxis (limpieza)',
      toothNumber: null,
      surfaces: null,
      quantity: 1,
      unitPriceCentsUsd: 0,
      totalPriceCentsUsd: 0,
      taxCategory: 'exento',
      taxRateBasisPoints: 0,
      ivaAmountCentsUsd: 0,
      needsPricing: true,
    });
    expect(linea.priceText).toBe('');
    expect(linea.needsPricing).toBe(true);
    expect(linea.surfaces).toEqual([]);
    expect(linesReady([linea])).toBe(false);

    expect(linesReady([{ ...linea, priceText: '30,00' }])).toBe(true);
  });

  it('el total de la línea es precio × cantidad, sin redondear nada', () => {
    const base: EditableLine = {
      code: 'gel_fluorado',
      description: 'Gel fluorado',
      toothNumber: null,
      surfaces: [],
      quantity: 3,
      priceText: '12,34',
      needsPricing: false,
    };
    expect(lineTotalCents(base)).toBe(3702);
    // Media entrada: se cuenta como 0 mientras no sea un importe legible.
    expect(lineTotalCents({ ...base, priceText: '' })).toBe(0);
  });

  it('la lista que se manda lleva la pieza y las caras de cada partida', () => {
    const items = toDraftItems([
      {
        code: 'obturacion_resina',
        description: 'Obturación con resina compuesta',
        toothNumber: 26,
        surfaces: ['occlusal', 'mesial'],
        quantity: 1,
        priceText: '50,00',
        needsPricing: false,
      },
      {
        code: 'otros',
        description: '',
        toothNumber: null,
        surfaces: [],
        quantity: 2,
        priceText: '10',
        needsPricing: false,
      },
    ]);

    expect(items).toEqual([
      {
        code: 'obturacion_resina',
        quantity: 1,
        unitPriceCentsUsd: 5000,
        description: 'Obturación con resina compuesta',
        toothNumber: 26,
        surfaces: ['occlusal', 'mesial'],
      },
      {
        code: 'otros',
        quantity: 2,
        unitPriceCentsUsd: 1000,
        // Una descripción vacía se manda como `null` para que el servicio use la del arancel.
        description: null,
        toothNumber: null,
        surfaces: [],
      },
    ]);
  });
});
