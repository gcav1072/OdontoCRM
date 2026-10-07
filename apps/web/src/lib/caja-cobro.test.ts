import { describe, expect, it } from 'vitest';

import {
  estadoDeFactura,
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
