import { describe, expect, it } from 'vitest';

import {
  estadoDeFactura,
  igtfPrevisto,
  imputacionPrevista,
  puedeEmitirse,
  saldoEnBs,
  tasaEnTexto,
  type EditableLine,
} from './caja.js';

/**
 * Las reglas de la caja para **emitir y cobrar**: qué dice el estado, qué falta para emitir, cuánto es
 * el saldo en bolívares y qué se va a imputar con lo tecleado.
 *
 * Lo que se prueba aquí es lo que la pantalla decide **antes** de llamar al servicio. La aritmética del
 * dinero no se reimplementa: la hacen los helpers del contrato, los mismos que usa el servicio, y eso es
 * justo lo que se comprueba (que la previsión coincida con la regla).
 */
const linea = (priceText: string, quantity = 1): EditableLine => ({
  code: 'profilaxis',
  description: 'Profilaxis',
  toothNumber: null,
  surfaces: [],
  quantity,
  priceText,
  taxCategory: 'exento',
  taxRateBasisPoints: 0,
  needsPricing: priceText === '',
});

describe('el estado de una factura, en palabras del mostrador', () => {
  it('cada estado tiene su palabra', () => {
    const base = { totalCentsUsd: 6392, balanceCentsUsd: 6392 };
    expect(estadoDeFactura({ ...base, status: 'borrador' })).toBe('Sin emitir');
    expect(estadoDeFactura({ ...base, status: 'emitida' })).toBe('Por cobrar');
    expect(estadoDeFactura({ ...base, status: 'parcial' })).toBe('Abonada');
    expect(estadoDeFactura({ ...base, status: 'pagada' })).toBe('Pagada');
    expect(estadoDeFactura({ ...base, status: 'anulada' })).toBe('Anulada');
  });
});

describe('qué falta para emitir', () => {
  it('un borrador sin partidas no se emite', () => {
    expect(puedeEmitirse([])).toBe(false);
  });

  it('una partida sin precio frena la emisión', () => {
    expect(puedeEmitirse([linea('12,34'), linea('')])).toBe(false);
    expect(puedeEmitirse([linea('12,34'), linea('0')])).toBe(true);
  });

  it('con todas las partidas preciadas se emite', () => {
    expect(puedeEmitirse([linea('12,34'), linea('5')])).toBe(true);
  });
});

describe('el saldo en bolívares', () => {
  it('se convierte a la tasa congelada de la factura', () => {
    // 63,92 US$ × 36,542 = 2.335,75664 Bs. → 233.576 céntimos (la mitad hacia arriba).
    expect(saldoEnBs(6392, 36_542_000)).toBe(233_576);
  });

  it('sin tasa congelada no se inventa un número', () => {
    expect(saldoEnBs(6392, null)).toBeNull();
    expect(saldoEnBs(6392, 0)).toBeNull();
  });

  it('la tasa se escribe como se lee en el mostrador', () => {
    expect(tasaEnTexto(36_542_000)).toBe('36,542');
    expect(tasaEnTexto(null)).toBe('—');
  });
});

describe('lo que se va a imputar con lo tecleado', () => {
  const base = {
    method: 'pago_movil',
    rateMicros: 36_542_000,
    invoiceRateMicros: 36_000_000,
    policy: 'tasa_del_pago' as const,
    balanceCentsUsd: 6392,
  };

  it('en bolívares, con la tasa del pago', () => {
    // Los bolívares que valen la deuda entera, entregados hoy.
    const previsto = imputacionPrevista({ ...base, tenderedText: '2335,60' });
    expect(previsto.cents).toBe(6392);
    expect(previsto.aviso).toBeNull();
  });

  it('en bolívares, con la tasa de la factura (el paciente paga los Bs. impresos)', () => {
    // 2.335,60 Bs. a la tasa impresa (36,000) valen 64,87 US$: 6.487 céntimos, y se avisa de sobra.
    const previsto = imputacionPrevista({
      ...base,
      policy: 'tasa_de_la_factura',
      tenderedText: '2335,60',
    });
    expect(previsto.cents).toBe(6488);
    expect(previsto.aviso).toBe('El monto supera el saldo.');
  });

  it('en divisas, lo entregado es lo imputado', () => {
    const previsto = imputacionPrevista({
      ...base,
      method: 'cash_usd',
      tenderedText: '30',
    });
    expect(previsto.cents).toBe(3000);
    expect(previsto.aviso).toBeNull();
  });

  it('si el monto supera el saldo, se avisa antes de mandarlo', () => {
    const previsto = imputacionPrevista({ ...base, method: 'cash_usd', tenderedText: '100' });
    expect(previsto.aviso).toBe('El monto supera el saldo.');
  });

  it('sin importe legible, o sin tasa, no se calcula nada', () => {
    expect(imputacionPrevista({ ...base, tenderedText: '' }).cents).toBeNull();
    expect(imputacionPrevista({ ...base, tenderedText: 'treinta' }).aviso).toContain(
      'Escribe el monto',
    );
    expect(imputacionPrevista({ ...base, tenderedText: '0' }).cents).toBeNull();
    expect(imputacionPrevista({ ...base, rateMicros: null, tenderedText: '100' }).aviso).toContain(
      'No hay tasa publicada',
    );
  });
});

describe('la descomposición del cobro que se ve antes de confirmar (ADR 0069)', () => {
  const base = {
    method: 'pago_movil',
    // 1.020,00 Bs./USD hoy; la factura se emitió a 1.000,00. Deuda: $10,00.
    rateMicros: 1_020_000_000,
    invoiceRateMicros: 1_000_000_000,
    policy: 'tasa_del_pago' as const,
    balanceCentsUsd: 1_000,
  };

  it('el pago exacto muestra imputación histórica y ganancia cambiaria', () => {
    const previsto = imputacionPrevista({ ...base, tenderedText: '10200,00' });
    expect(previsto.cents).toBe(1_000);
    expect(previsto.historicalVesCentimos).toBe(1_000_000); // 10.000,00 Bs. a la tasa de emisión
    expect(previsto.exchangeDiffVesCentimos).toBe(20_000); // +200,00 Bs.
    expect(previsto.absorbeRedondeo).toBe(false);
    expect(previsto.aviso).toBeNull();
  });

  it('el Pago Móvil redondeado al bolívar entero cierra la deuda y avisa la absorción', () => {
    // 10.234,00 Bs. cuando lo exacto son 10.234,70: el residuo se absorbe en el diferencial.
    const previsto = imputacionPrevista({
      ...base,
      rateMicros: 1_023_470_000,
      tenderedText: '10234,00',
    });
    expect(previsto.cents).toBe(1_000);
    expect(previsto.aviso).toBeNull();
    expect(previsto.absorbeRedondeo).toBe(true);
    expect(previsto.exchangeDiffVesCentimos).toBe(23_400); // +234,00 Bs.
  });

  it('un sobrepago real se avisa: la tolerancia no lo absorbe', () => {
    // 10.300,00 Bs. valen 1.010 céntimos: diez de más, más allá de los ±5.
    expect(imputacionPrevista({ ...base, tenderedText: '10300,00' }).aviso).toBe(
      'El monto supera el saldo.',
    );
    expect(imputacionPrevista({ ...base, tenderedText: '10300,00' }).cents).toBe(1010);
    expect(imputacionPrevista({ ...base, tenderedText: '10300,00' }).absorbeRedondeo).toBe(false);
  });

  it('en divisas la previsión dice que no habrá diferencial cambiario', () => {
    const previsto = imputacionPrevista({ ...base, method: 'cash_usd', tenderedText: '10' });
    expect(previsto.cents).toBe(1_000);
    expect(previsto.exchangeDiffVesCentimos).toBe(0);
    expect(previsto.historicalVesCentimos).toBe(1_000_000);
    expect(previsto.absorbeRedondeo).toBe(false);
  });
});

describe('el IGTF previsto del cobro (ADR 0069)', () => {
  it('con SPE el 3 % se causa y se convierte a la tasa del cobro', () => {
    const previsto = igtfPrevisto({
      method: 'cash_usd',
      amountCentsUsd: 1_000,
      rateMicros: 1_020_000_000,
      isSpecialTaxpayer: true,
      igtfRateBp: 300,
    });
    expect(previsto).toMatchObject({ aplica: true, basisPoints: 300, amountCentsUsd: 30 });
    expect(previsto.amountVesCentimos).toBe(30_600); // 0,30 USD a 1.020,00 → 306,00 Bs.
  });

  it('sin SPE no se cobra nada, y lo que debita el banco tampoco', () => {
    expect(
      igtfPrevisto({
        method: 'cash_usd',
        amountCentsUsd: 1_000,
        rateMicros: 1_020_000_000,
        isSpecialTaxpayer: false,
        igtfRateBp: 300,
      }).aplica,
    ).toBe(false);
    // Tarjeta en divisas: lo debita el banco (Art. 4.5); cobrarlo sería cobrar dos veces.
    expect(
      igtfPrevisto({
        method: 'card_usd',
        amountCentsUsd: 1_000,
        rateMicros: 1_020_000_000,
        isSpecialTaxpayer: true,
        igtfRateBp: 300,
      }).aplica,
    ).toBe(false);
  });

  it('una alícuota configurada distinta se respeta (cambiar la ley es configuración)', () => {
    expect(
      igtfPrevisto({
        method: 'cash_usd',
        amountCentsUsd: 1_000,
        rateMicros: 1_020_000_000,
        isSpecialTaxpayer: true,
        igtfRateBp: 500,
      }).amountCentsUsd,
    ).toBe(50);
  });
});
