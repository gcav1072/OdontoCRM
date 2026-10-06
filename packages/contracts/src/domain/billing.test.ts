import { describe, expect, it } from 'vitest';

import {
  FOREIGN_CURRENCY_IVA_BASIS_POINTS_DEFAULT,
  INVOICE_TRANSITIONS,
  IVA_GENERAL_BASIS_POINTS,
  PAYMENT_METHODS,
  automaticInvoiceTransitions,
  canTransitionInvoice,
  divideHalfUp,
  findPaymentMethod,
  formatCreditNoteNumber,
  formatInvoiceNumber,
  formatRateMicros,
  formatReceiptNumber,
  igtfCents,
  igtfDecision,
  igtfPercentLabel,
  igtfToCollectCents,
  invoiceStatusForBalance,
  invoiceStatusLabel,
  invoiceTotalsFromItems,
  invoiceTransitionsFor,
  invoiceTransitionsFrom,
  invoiceVesTotals,
  isCollectableInvoice,
  isPaymentMethodCode,
  isTerminalInvoiceStatus,
  ivaCentsForItem,
  paymentMethodLabel,
  rateToMicros,
  resolveIgtfRule,
  taxCategoryLetter,
  usdCentsFromVes,
  vesCentimosFromUsd,
} from './billing.js';
import { INVOICE_STATUSES } from './enums.js';

/**
 * Pruebas del contrato de facturación (§9.1 del plan de la fase, `docs/feat_billing.md`): la
 * aritmética del dinero, el IGTF y la máquina de estados. Son **unitarias**, sin base de datos: lo
 * que se fija aquí es la regla, y el servicio no puede tener otra.
 */

/** La tasa del día que usan casi todas las pruebas: 36,5420 Bs./USD. */
const TASA = 36_542_000;

describe('aritmética del dinero: enteros, una sola regla de redondeo', () => {
  it('el redondeo es half-up sobre enteros no negativos', () => {
    expect(divideHalfUp(5n, 2n)).toBe(3n);
    expect(divideHalfUp(1n, 2n)).toBe(1n);
    expect(divideHalfUp(1n, 3n)).toBe(0n);
    expect(divideHalfUp(2n, 3n)).toBe(1n);
    expect(divideHalfUp(0n, 7n)).toBe(0n);
    expect(divideHalfUp(4n, 2n)).toBe(2n);
  });

  it('un divisor no positivo o un dividendo negativo se rechazan en vez de improvisar', () => {
    expect(() => divideHalfUp(1n, 0n)).toThrow(RangeError);
    expect(() => divideHalfUp(1n, -2n)).toThrow(RangeError);
    expect(() => divideHalfUp(-1n, 2n)).toThrow(RangeError);
  });

  it('la tasa se parsea exacto, sin pasar por coma flotante', () => {
    expect(rateToMicros('36,5420')).toBe(TASA);
    expect(rateToMicros('36.5420')).toBe(TASA);
    // Los ceros de la derecha no cambian la tasa.
    expect(rateToMicros('36,542')).toBe(TASA);
    expect(rateToMicros('36,542000')).toBe(TASA);
    expect(rateToMicros('1')).toBe(1_000_000);
    expect(rateToMicros('0,000001')).toBe(1);
    expect(rateToMicros(' 36,5420 ')).toBe(TASA);
  });

  it('una tasa que no se puede interpretar sin adivinar se rechaza', () => {
    // «1.234,56» es ambiguo: ¿mil doscientos treinta y cuatro, o uno coma doscientos treinta y
    // cuatro mil? En un dato del que depende el dinero no se adivina.
    expect(() => rateToMicros('1.234,56')).toThrow(RangeError);
    expect(() => rateToMicros('36,5420123')).toThrow(RangeError);
    expect(() => rateToMicros('1 234')).toThrow(RangeError);
    expect(() => rateToMicros('abc')).toThrow(RangeError);
    expect(() => rateToMicros('')).toThrow(RangeError);
    expect(() => rateToMicros('-1')).toThrow(RangeError);
    expect(() => rateToMicros('0')).toThrow(RangeError);
  });

  it('la tasa se imprime con sus decimales significativos', () => {
    expect(formatRateMicros(TASA)).toBe('36,542');
    expect(formatRateMicros(36_500_000)).toBe('36,5');
    expect(formatRateMicros(1_000_000)).toBe('1');
    expect(formatRateMicros(1)).toBe('0,000001');
  });

  it('céntimos de USD a céntimos de Bs., redondeando una sola vez', () => {
    // 1,00 USD a 36,5420 son 36,5420 Bs. = 3654 céntimos.
    expect(vesCentimosFromUsd(100, TASA)).toBe(3654);
    expect(vesCentimosFromUsd(0, TASA)).toBe(0);
    // El medio céntimo sube: 1 × 0,5 = 0,5 → 1; 3 × 0,5 = 1,5 → 2.
    expect(vesCentimosFromUsd(1, 500_000)).toBe(1);
    expect(vesCentimosFromUsd(3, 500_000)).toBe(2);
    expect(vesCentimosFromUsd(1, 1_499_999)).toBe(1);
    expect(vesCentimosFromUsd(1, 1_500_000)).toBe(2);
  });

  it('las dos conversiones son inversas dentro del céntimo', () => {
    for (const centsUsd of [1, 7, 100, 9_999, 1_234_567, 1_000_000_000]) {
      const ves = vesCentimosFromUsd(centsUsd, TASA);
      expect(Math.abs(usdCentsFromVes(ves, TASA) - centsUsd)).toBeLessThanOrEqual(1);
    }
  });

  it('los importes grandes no pierden precisión y el que se sale del rango se rechaza', () => {
    // 10⁹ céntimos de USD (10 millones de dólares) a 36,5420.
    expect(vesCentimosFromUsd(1_000_000_000, TASA)).toBe(36_542_000_000);
    expect(usdCentsFromVes(36_542_000_000, TASA)).toBe(1_000_000_000);
    // 10¹² céntimos: el producto intermedio es enorme y aun así es exacto (BigInt).
    expect(vesCentimosFromUsd(1_000_000_000_000, TASA)).toBe(36_542_000_000_000);
    // 10¹⁵ céntimos ya no caben en el rango entero seguro: se avisa, no se redondea en silencio.
    expect(() => vesCentimosFromUsd(1_000_000_000_000_000, TASA)).toThrow(RangeError);
    expect(() => vesCentimosFromUsd(-1, TASA)).toThrow(RangeError);
    expect(() => vesCentimosFromUsd(1.5, TASA)).toThrow(RangeError);
    expect(() => usdCentsFromVes(100, 0)).toThrow(RangeError);
  });
});

describe('IGTF: el tributo del medio de pago', () => {
  it('el 3 % de 100,00 USD son 3,00 USD, y sin alícuota no hay IGTF', () => {
    expect(igtfCents(10_000, 300)).toBe(300);
    expect(igtfCents(10_000, 0)).toBe(0);
    expect(igtfCents(0, 300)).toBe(0);
    // El redondeo es el mismo de todo el módulo: 0,5 sube y 0,45 no.
    expect(igtfCents(10, 500)).toBe(1);
    expect(igtfCents(9, 500)).toBe(0);
    expect(igtfPercentLabel(300)).toBe('3,00 %');
  });

  it('lo que debita el banco no se le cobra al paciente (no se cobra dos veces)', () => {
    const decision = igtfDecision({ method: 'card_usd', isSpecialTaxpayer: false });
    expect(decision.applies).toBe(true);
    expect(decision.perceivedBy).toBe('banco');
    expect(decision.basisPoints).toBe(300);
    // Causa IGTF, pero la clínica no lo cobra: solo lo registra para conciliar el extracto.
    expect(igtfToCollectCents(decision, 10_000)).toBe(0);
  });

  it('la configuración real de la clínica (contribuyente ordinario, no SPE) no percibe nada', () => {
    for (const method of PAYMENT_METHODS.map((m) => m.code)) {
      const decision = igtfDecision({ method, isSpecialTaxpayer: false });
      if (decision.perceivedBy !== 'banco') {
        expect(decision.applies, `${method} no debería causar IGTF sin SPE`).toBe(false);
      }
      expect(igtfToCollectCents(decision, 10_000), `${method} no debería cobrarse`).toBe(0);
    }
  });

  it('con la bandera de SPE encendida el 3 % vuelve a calcularse (el camino no queda muerto)', () => {
    const efectivo = igtfDecision({ method: 'cash_usd', isSpecialTaxpayer: true });
    expect(efectivo.applies).toBe(true);
    expect(efectivo.perceivedBy).toBe('clinica');
    expect(igtfToCollectCents(efectivo, 10_000)).toBe(300);

    for (const method of ['zelle', 'crypto_usdt'] as const) {
      const decision = igtfDecision({ method, isSpecialTaxpayer: true });
      expect(decision.perceivedBy, `${method} con SPE`).toBe('clinica');
      expect(igtfToCollectCents(decision, 10_000)).toBe(300);
    }
    // Y el bancarizado sigue siendo del banco aunque la clínica sea SPE.
    expect(igtfDecision({ method: 'card_usd', isSpecialTaxpayer: true }).perceivedBy).toBe('banco');
  });

  it('los medios sin IGTF y los que el contador aún no decidió no cobran nada', () => {
    expect(igtfDecision({ method: 'cash_ves', isSpecialTaxpayer: false }).applies).toBe(false);
    expect(igtfDecision({ method: 'pago_movil', isSpecialTaxpayer: false }).applies).toBe(false);
    const sinConfigurar = igtfDecision({ method: 'international_wire', isSpecialTaxpayer: true });
    expect(sinConfigurar.applies).toBe(false);
    expect(sinConfigurar.perceivedBy).toBeNull();
    expect(sinConfigurar.reason).toMatch(/contador/);
  });

  it('la regla configurada manda sobre lo que declara el medio de pago', () => {
    const conRegla = igtfDecision({
      method: 'cash_usd',
      isSpecialTaxpayer: true,
      rule: {
        method: 'cash_usd',
        basisPoints: 500,
        perceivedBy: 'clinica',
        effectiveFrom: '2026-01-01',
      },
    });
    expect(conRegla.basisPoints).toBe(500);
    expect(igtfToCollectCents(conRegla, 10_000)).toBe(500);

    // Y si el contador decide que el medio no causa IGTF, la clínica no lo cobra ni siendo SPE.
    const apagado = igtfDecision({
      method: 'cash_usd',
      isSpecialTaxpayer: true,
      rule: {
        method: 'cash_usd',
        basisPoints: 300,
        perceivedBy: 'no_aplica',
        effectiveFrom: '2026-01-01',
      },
    });
    expect(apagado.applies).toBe(false);
    expect(igtfToCollectCents(apagado, 10_000)).toBe(0);

    // Una regla que dice «lo percibe la clínica» no la convierte en SPE.
    const sinSpe = igtfDecision({
      method: 'cash_usd',
      isSpecialTaxpayer: false,
      rule: {
        method: 'cash_usd',
        basisPoints: 300,
        perceivedBy: 'clinica',
        effectiveFrom: '2026-01-01',
      },
    });
    expect(sinSpe.applies).toBe(false);
    expect(sinSpe.reason).toMatch(/Sujeto Pasivo Especial/);
  });

  it('la regla vigente es la última anterior o igual a la fecha', () => {
    const reglas = [
      {
        method: 'cash_usd' as const,
        basisPoints: 300,
        perceivedBy: 'clinica' as const,
        effectiveFrom: '2026-01-01',
      },
      {
        method: 'cash_usd' as const,
        basisPoints: 500,
        perceivedBy: 'clinica' as const,
        effectiveFrom: '2026-07-01',
      },
      {
        method: 'zelle' as const,
        basisPoints: 300,
        perceivedBy: 'banco' as const,
        effectiveFrom: '2026-01-01',
      },
    ];
    expect(resolveIgtfRule(reglas, 'cash_usd', '2026-06-30')?.basisPoints).toBe(300);
    expect(resolveIgtfRule(reglas, 'cash_usd', '2026-07-01')?.basisPoints).toBe(500);
    expect(resolveIgtfRule(reglas, 'cash_usd', '2027-01-01')?.basisPoints).toBe(500);
    expect(resolveIgtfRule(reglas, 'zelle', '2026-08-01')?.perceivedBy).toBe('banco');
    expect(resolveIgtfRule(reglas, 'cash_usd', '2025-12-31')).toBeNull();
    expect(resolveIgtfRule(reglas, 'pago_movil', '2026-08-01')).toBeNull();
  });
});

describe('IVA: la alícuota se copia, y la adicional del Art. 62 está apagada', () => {
  it('lo exento no paga la alícuota general y el bien gravado sí', () => {
    expect(IVA_GENERAL_BASIS_POINTS).toBe(1600);
    expect(
      ivaCentsForItem({ baseCentsUsd: 10_000, taxCategory: 'exento', taxRateBasisPoints: 1600 }),
    ).toBe(0);
    expect(
      ivaCentsForItem({ baseCentsUsd: 10_000, taxCategory: 'general', taxRateBasisPoints: 1600 }),
    ).toBe(1600);
  });

  it('la adicional del Art. 62 viene en 0 y solo se aplica si se configura', () => {
    expect(FOREIGN_CURRENCY_IVA_BASIS_POINTS_DEFAULT).toBe(0);
    // Con la adicional apagada, una partida exenta no paga nada.
    expect(
      ivaCentsForItem({ baseCentsUsd: 10_000, taxCategory: 'exento', taxRateBasisPoints: 1600 }),
    ).toBe(0);
    // Con la adicional encendida (5 %), el parágrafo primero la aplica **también a lo exento**…
    expect(
      ivaCentsForItem({
        baseCentsUsd: 10_000,
        taxCategory: 'exento',
        taxRateBasisPoints: 1600,
        foreignCurrencyIvaBasisPoints: 500,
      }),
    ).toBe(500);
    // …y a lo gravado se le suma a la general.
    expect(
      ivaCentsForItem({
        baseCentsUsd: 10_000,
        taxCategory: 'general',
        taxRateBasisPoints: 1600,
        foreignCurrencyIvaBasisPoints: 500,
      }),
    ).toBe(2100);
  });
});

describe('totales del documento', () => {
  it('se suman las partidas, nunca al revés', () => {
    const totales = invoiceTotalsFromItems([
      { totalPriceCentsUsd: 3000, taxCategory: 'exento', ivaAmountCentsUsd: 0 },
      { totalPriceCentsUsd: 2000, taxCategory: 'exento', ivaAmountCentsUsd: 0 },
      { totalPriceCentsUsd: 2000, taxCategory: 'general', ivaAmountCentsUsd: 320 },
    ]);
    expect(totales).toEqual({
      exemptAmountCentsUsd: 5000,
      taxableAmountCentsUsd: 2000,
      ivaAmountCentsUsd: 320,
      totalCentsUsd: 7320,
    });
    expect(invoiceTotalsFromItems([])).toEqual({
      exemptAmountCentsUsd: 0,
      taxableAmountCentsUsd: 0,
      ivaAmountCentsUsd: 0,
      totalCentsUsd: 0,
    });
  });

  it('los totales en Bs. salen de las partes para que el desglose cuadre con el total', () => {
    const totales = {
      exemptAmountCentsUsd: 3000,
      taxableAmountCentsUsd: 2000,
      ivaAmountCentsUsd: 320,
      totalCentsUsd: 5320,
    };
    const enBs = invoiceVesTotals(totales, TASA);
    expect(enBs).toEqual({
      exemptAmountVesCentimos: vesCentimosFromUsd(3000, TASA),
      taxableAmountVesCentimos: vesCentimosFromUsd(2000, TASA),
      ivaAmountVesCentimos: vesCentimosFromUsd(320, TASA),
      totalVesCentimos:
        vesCentimosFromUsd(3000, TASA) +
        vesCentimosFromUsd(2000, TASA) +
        vesCentimosFromUsd(320, TASA),
    });

    // El caso que obliga a decidir: convertir el total por su cuenta daría 5 y el desglose suma 6.
    const medioCentimo = invoiceVesTotals(
      {
        exemptAmountCentsUsd: 1,
        taxableAmountCentsUsd: 1,
        ivaAmountCentsUsd: 1,
        totalCentsUsd: 3,
      },
      1_500_000,
    );
    expect(medioCentimo).toEqual({
      exemptAmountVesCentimos: 2,
      taxableAmountVesCentimos: 2,
      ivaAmountVesCentimos: 2,
      totalVesCentimos: 6,
    });
    expect(vesCentimosFromUsd(3, 1_500_000)).toBe(5);
  });
});

describe('la máquina de estados de la factura', () => {
  it('cubre todos los estados y ninguno se queda sin salida (salvo la anulada)', () => {
    const mencionados = new Set<string>();
    for (const transicion of INVOICE_TRANSITIONS) {
      mencionados.add(transicion.from);
      mencionados.add(transicion.to);
    }
    for (const estado of INVOICE_STATUSES) {
      expect(mencionados.has(estado), `${estado} no aparece en ninguna transición`).toBe(true);
      const salidas = invoiceTransitionsFrom(estado);
      if (isTerminalInvoiceStatus(estado)) {
        expect(salidas, `${estado} es terminal`).toHaveLength(0);
      } else {
        expect(salidas.length, `${estado} se queda sin salida`).toBeGreaterThan(0);
      }
    }
    expect(isTerminalInvoiceStatus('anulada')).toBe(true);
    expect(isTerminalInvoiceStatus('pagada')).toBe(false);
  });

  it('un borrador solo recibe dinero después de emitirse', () => {
    expect(isCollectableInvoice('emitida')).toBe(true);
    expect(isCollectableInvoice('parcial')).toBe(true);
    expect(isCollectableInvoice('borrador')).toBe(false);
    expect(isCollectableInvoice('pagada')).toBe(false);
    expect(isCollectableInvoice('anulada')).toBe(false);
  });

  it('las transiciones del saldo son automáticas y no se ofrecen como botones', () => {
    for (const estado of INVOICE_STATUSES) {
      for (const transicion of automaticInvoiceTransitions(estado)) {
        expect(transicion.roles).toHaveLength(0);
      }
    }
    const automaticas = automaticInvoiceTransitions('emitida').map((t) => t.to);
    expect(automaticas).toContain('parcial');
    expect(automaticas).toContain('pagada');
    // Anular no es automático: lo decide una persona y exige motivo.
    expect(invoiceTransitionsFor('emitida', 'secretario').map((t) => t.to)).toContain('anulada');
  });

  it('la secretaría emite y anula con motivo; el odontólogo solo mira', () => {
    expect(canTransitionInvoice('borrador', 'emitida', 'secretario')).toBe(true);
    expect(canTransitionInvoice('borrador', 'emitida', 'admin')).toBe(true);
    expect(canTransitionInvoice('borrador', 'emitida', 'odontologo')).toBe(false);
    expect(canTransitionInvoice('borrador', 'emitida', 'pantalla')).toBe(false);

    expect(canTransitionInvoice('emitida', 'anulada', 'secretario')).toBe(true);
    expect(canTransitionInvoice('emitida', 'anulada', 'odontologo')).toBe(false);

    // Toda transición que se ofrece a una persona y anula exige motivo escrito.
    for (const transicion of INVOICE_TRANSITIONS.filter((t) => t.to === 'anulada')) {
      expect(transicion.requiresReason, `${transicion.from} → anulada sin motivo`).toBe(true);
    }
    // Y emitir no lo exige: es el acto normal del mostrador.
    const emitir = INVOICE_TRANSITIONS.find((t) => t.from === 'borrador' && t.to === 'emitida');
    expect(emitir?.requiresReason).toBeUndefined();
  });

  it('el estado lo mueve el saldo, no una persona', () => {
    expect(invoiceStatusForBalance(1000, 1000)).toBe('emitida');
    expect(invoiceStatusForBalance(1000, 400)).toBe('parcial');
    expect(invoiceStatusForBalance(1000, 0)).toBe('pagada');
    // Una factura de total cero (todas las partidas sin precio) no tiene nada que cobrar.
    expect(invoiceStatusForBalance(0, 0)).toBe('pagada');
    expect(() => invoiceStatusForBalance(1000, 1001)).toThrow(RangeError);
    expect(() => invoiceStatusForBalance(1000, -1)).toThrow(RangeError);
  });

  it('las etiquetas de estado son las que ve el mostrador', () => {
    expect(invoiceStatusLabel('borrador')).toBe('Borrador');
    expect(invoiceStatusLabel('emitida')).toBe('Emitida');
    expect(invoiceStatusLabel('parcial')).toBe('Abonada');
    expect(invoiceStatusLabel('pagada')).toBe('Pagada');
    expect(invoiceStatusLabel('anulada')).toBe('Anulada');
  });
});

describe('medios de pago y números impresos', () => {
  it('los códigos de medio de pago son únicos y la moneda va con el medio', () => {
    const codigos = PAYMENT_METHODS.map((method) => method.code);
    expect(new Set(codigos).size).toBe(codigos.length);
    expect(findPaymentMethod('cash_usd')?.currency).toBe('USD');
    expect(findPaymentMethod('pago_movil')?.currency).toBe('VES');
    expect(findPaymentMethod('no_existe')).toBeUndefined();
    expect(isPaymentMethodCode('zelle')).toBe(true);
    expect(isPaymentMethodCode('bitcoin')).toBe(false);
    expect(paymentMethodLabel('card_usd')).toBe('Tarjeta en divisas');
    // Un código desconocido no rompe la pantalla: se muestra tal cual.
    expect(paymentMethodLabel('bitcoin')).toBe('bitcoin');
  });

  it('los números se formatean al imprimirlos, no se guardan formateados', () => {
    expect(formatInvoiceNumber('A', 123)).toBe('A-000123');
    expect(formatInvoiceNumber('T', 900001)).toBe('T-900001');
    expect(formatReceiptNumber(1)).toBe('REC-000001');
    expect(formatCreditNoteNumber(123456)).toBe('NC-123456');
  });

  it('la letra de la partida es la que exige la Providencia 0071', () => {
    expect(taxCategoryLetter('exento')).toBe('(E)');
    expect(taxCategoryLetter('general')).toBe('(G)');
  });
});
