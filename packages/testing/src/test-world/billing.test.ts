import {
  findPaymentMethod,
  igtfDecision,
  invoiceStatusForBalance,
  invoiceTotalsFromItems,
  invoiceVesTotals,
  SESSION_PROCEDURES,
  vesCentimosFromUsd,
} from '@odontocrm/contracts';
import { describe, expect, it } from 'vitest';

import { buildTestWorldEvents, sessionClosedEventId } from './events.js';
import { rateForClinicDate } from './billing.js';
import { buildTestWorld, FICTITIOUS_SEQUENCE_MIN, type TestWorld } from './world.js';

/**
 * La facturación del mundo tiene que ser **imposible de sembrar mal**: las mismas
 * invariantes que vigilan los `CHECK` de `odonto_billing`, más las que solo se ven
 * mirando el conjunto (una factura por sesión, la cola de la caja, la tasa de cada
 * día congelada en su factura). Si algo de esto se rompe, `seed:test` escribiría
 * filas que la base rechaza —o peor, filas que la base acepta y no cuadran—.
 */
const ANCLA = '2026-10-02';
const AHORA = new Date('2026-10-02T14:00:00.000Z');

const mundo = (anchor = ANCLA): TestWorld => buildTestWorld({ anchor, now: AHORA });
const facturas = (world: TestWorld) => world.billing.invoices;
const cobros = (world: TestWorld) => facturas(world).flatMap((invoice) => invoice.payments);
const anioDeHorario = (instant: string): string =>
  new Date(new Date(instant).getTime() - 4 * 3_600_000).toISOString().slice(11, 16);

describe('facturación · el reparto del mundo', () => {
  it('cada sesión cerrada tiene exactamente una factura', () => {
    const world = mundo();

    expect(facturas(world)).toHaveLength(world.sessions.length);
    expect(new Set(facturas(world).map((invoice) => invoice.sessionId)).size).toBe(
      world.sessions.length,
    );
    for (const session of world.sessions) {
      expect(facturas(world).some((invoice) => invoice.sessionId === session.id)).toBe(true);
    }
  });

  it('la cola de la caja son las últimas sesiones y el resto tiene su historia', () => {
    const world = mundo();
    const sesiones = [...world.sessions].sort((left, right) =>
      left.closedAt < right.closedAt ? -1 : 1,
    );
    const estadoDe = (desdeElFinal: number): string | undefined =>
      facturas(world).find((invoice) => invoice.sessionId === sesiones.at(-1 - desdeElFinal)?.id)
        ?.status;

    expect(estadoDe(0)).toBe('borrador');
    expect(estadoDe(1)).toBe('borrador');
    expect(estadoDe(2)).toBe('borrador');
    expect(estadoDe(3)).toBe('emitida');
    expect(estadoDe(4)).toBe('parcial');
    expect(estadoDe(5)).toBe('anulada');
    expect(estadoDe(6)).toBe('pagada');
    expect(world.totals.drafts).toBe(3);
    expect(world.totals.creditNotes).toBe(1);
  });

  it('el cobro anulado es de una factura pagada y no cuenta para el saldo', () => {
    const world = mundo();
    const anulados = cobros(world).filter((payment) => payment.voidedAt !== null);
    const conAnulado = facturas(world).filter((invoice) =>
      invoice.payments.some((payment) => payment.voidedAt !== null),
    );

    expect(anulados).toHaveLength(1);
    expect(conAnulado).toHaveLength(1);
    // El cobro anulado tiene que venir **antes** que el que lo corrige.
    for (const invoice of conAnulado) {
      const [primero, segundo] = invoice.payments;
      expect(primero?.voidedAt).not.toBeNull();
      expect(segundo?.voidedAt).toBeNull();
      expect((primero?.createdAt ?? '') < (segundo?.createdAt ?? '')).toBe(true);
    }
  });

  it('el anulado y el corregido no se pisan: la corrección va después de anular', () => {
    const world = mundo();
    for (const invoice of facturas(world)) {
      const anulado = invoice.payments.find((payment) => payment.voidedAt !== null);
      if (anulado === undefined) continue;
      const correccion = invoice.payments.find((payment) => payment.id !== anulado.id);
      expect((correccion?.createdAt ?? '') >= (anulado.voidedAt ?? '')).toBe(true);
    }
  });
});

describe('facturación · los documentos', () => {
  it('el borrador no es un documento: ni número, ni tasa congelada, ni PDF', () => {
    for (const invoice of facturas(mundo()).filter((item) => item.status === 'borrador')) {
      expect(invoice.invoiceNumber).toBeNull();
      expect(invoice.exchangeRateMicros).toBeNull();
      expect(invoice.issuedAt).toBeNull();
      expect(invoice.pdfLines).toBeNull();
      expect(invoice.venBs).toBeNull();
      expect(invoice.rateAtDraftMicros).toBeGreaterThan(0);
      expect(invoice.balanceCentsUsd).toBe(invoice.totalCentsUsd);
      expect(invoice.items.length).toBeGreaterThan(0);
    }
  });

  it('lo emitido está completo, en el rango reservado y sin repetir número', () => {
    const emitidas = facturas(mundo()).filter((invoice) => invoice.status !== 'borrador');
    const numeros = emitidas.map((invoice) => invoice.invoiceNumber ?? 0);

    expect(emitidas.length).toBeGreaterThan(0);
    expect(new Set(numeros).size).toBe(numeros.length);
    for (const numero of numeros) expect(numero).toBeGreaterThanOrEqual(FICTITIOUS_SEQUENCE_MIN);

    for (const invoice of emitidas) {
      expect(invoice.series).toBe('A');
      expect(invoice.issuedAt).not.toBeNull();
      expect(invoice.exchangeRateMicros).toBeGreaterThan(0);
      expect(invoice.pdfLines?.length ?? 0).toBeGreaterThan(3);
      expect(invoice.venBs?.totalVesCentimos).toBeGreaterThan(0);
    }
  });

  it('la numeración sigue el orden en que se emitió', () => {
    const emitidas = facturas(mundo())
      .filter((invoice) => invoice.issuedAt !== null)
      .sort((left, right) => ((left.issuedAt ?? '') < (right.issuedAt ?? '') ? -1 : 1));

    const numeros = emitidas.map((invoice) => invoice.invoiceNumber ?? 0);
    expect(numeros).toEqual([...numeros].sort((left, right) => left - right));
  });

  it('ningún acto de dinero cae fuera del horario del consultorio', () => {
    const world = mundo();
    const instantes = [
      ...facturas(world).flatMap((invoice) => [
        invoice.createdAt,
        ...(invoice.issuedAt === null ? [] : [invoice.issuedAt]),
        ...(invoice.voidedAt === null ? [] : [invoice.voidedAt]),
        ...(invoice.creditNote === null ? [] : [invoice.creditNote.issuedAt]),
        ...invoice.payments.flatMap((payment) => [
          payment.createdAt,
          ...(payment.voidedAt === null ? [] : [payment.voidedAt]),
        ]),
      ]),
    ];

    for (const instante of instantes) {
      const hora = anioDeHorario(instante);
      expect(hora >= '08:00').toBe(true);
      expect(hora <= '18:00').toBe(true);
    }
  });

  it('las partidas cuadran con el total y llevan su IVA copiado', () => {
    for (const invoice of facturas(mundo())) {
      const totales = invoiceTotalsFromItems(invoice.items);

      expect(invoice.totalCentsUsd).toBe(totales.totalCentsUsd);
      expect(invoice.exemptAmountCentsUsd).toBe(totales.exemptAmountCentsUsd);
      expect(invoice.taxableAmountCentsUsd).toBe(totales.taxableAmountCentsUsd);
      expect(invoice.ivaAmountCentsUsd).toBe(totales.ivaAmountCentsUsd);

      for (const item of invoice.items) {
        expect(item.quantity).toBeGreaterThan(0);
        expect(item.totalPriceCentsUsd).toBe(item.unitPriceCentsUsd * item.quantity);
        expect(item.needsPricing).toBe(false);
        expect(item.description.length).toBeGreaterThan(3);
        if (item.taxCategory === 'exento') expect(item.ivaAmountCentsUsd).toBe(0);
      }
    }
  });

  it('los totales en bolívares son los de la tasa congelada', () => {
    for (const invoice of facturas(mundo())) {
      if (invoice.exchangeRateMicros === null || invoice.venBs === null) continue;
      expect(invoice.venBs).toEqual(
        invoiceVesTotals(
          {
            exemptAmountCentsUsd: invoice.exemptAmountCentsUsd,
            taxableAmountCentsUsd: invoice.taxableAmountCentsUsd,
            ivaAmountCentsUsd: invoice.ivaAmountCentsUsd,
            totalCentsUsd: invoice.totalCentsUsd,
          },
          invoice.exchangeRateMicros,
        ),
      );
    }
  });

  it('la factura anulada lleva su nota de crédito y ninguna otra', () => {
    const world = mundo();
    const anuladas = facturas(world).filter((invoice) => invoice.status === 'anulada');

    expect(anuladas).toHaveLength(1);
    for (const invoice of anuladas) {
      expect(invoice.voidedAt).not.toBeNull();
      expect(invoice.voidReason).not.toBeNull();
      // Una factura pagada no se anula hasta devolver sus cobros.
      expect(invoice.payments).toHaveLength(0);
      expect(invoice.balanceCentsUsd).toBe(invoice.totalCentsUsd);
      expect(invoice.creditNote?.kind).toBe('total');
      expect(invoice.creditNote?.totalCentsUsd).toBe(invoice.totalCentsUsd);
      expect(invoice.creditNote?.totalVesCentimos).toBe(invoice.venBs?.totalVesCentimos);
      expect(invoice.creditNote?.exchangeRateMicros).toBe(invoice.exchangeRateMicros);
      expect(invoice.creditNote?.issuedAt).toBe(invoice.voidedAt);
    }
  });
});

describe('facturación · el saldo y los cobros', () => {
  it('el saldo sale de los cobros vigentes y el estado, del saldo', () => {
    for (const invoice of facturas(mundo())) {
      const cobrado = invoice.payments
        .filter((payment) => payment.voidedAt === null)
        .reduce((suma, payment) => suma + payment.amountCentsUsd, 0);
      const saldo = invoice.totalCentsUsd - cobrado;

      expect(invoice.balanceCentsUsd).toBe(saldo);
      expect(invoice.balanceCentsUsd).toBeGreaterThanOrEqual(0);
      expect(invoice.balanceCentsUsd).toBeLessThanOrEqual(invoice.totalCentsUsd);
      if (invoice.status === 'borrador' || invoice.status === 'anulada') continue;
      expect(invoice.status).toBe(invoiceStatusForBalance(invoice.totalCentsUsd, saldo));
    }
  });

  it('cada cobro entrega la moneda de su medio y la tasa del día del pago', () => {
    const world = mundo();
    for (const payment of cobros(world)) {
      const medio = findPaymentMethod(payment.method);
      expect(medio).toBeDefined();
      expect(payment.tenderedCurrency).toBe(medio?.currency);
      expect(payment.amountCentsUsd).toBeGreaterThan(0);
      expect(payment.imputationPolicy).toBe('tasa_del_pago');

      if (payment.tenderedCurrency === 'USD') {
        expect(payment.tenderedAmount).toBe(payment.amountCentsUsd);
        expect(payment.fxDifferenceCentsUsd).toBe(0);
      } else {
        // En bolívares se entrega lo que vale el monto a la tasa del pago.
        expect(payment.tenderedAmount).toBe(
          vesCentimosFromUsd(payment.amountCentsUsd, payment.exchangeRateMicros),
        );
      }

      // Y la tasa del cobro es la que regía ese día en el histórico del mundo.
      const dia = new Date(new Date(payment.createdAt).getTime() - 4 * 3_600_000)
        .toISOString()
        .slice(0, 10);
      expect(payment.exchangeRateMicros).toBe(
        rateForClinicDate(world.billing.rates, dia).rateMicros,
      );
    }

    // La tasa solo sube: quien paga más tarde imputa a una tasa mayor o igual.
    for (const invoice of facturas(world)) {
      for (const payment of invoice.payments) {
        expect(payment.exchangeRateMicros).toBeGreaterThanOrEqual(invoice.exchangeRateMicros ?? 0);
      }
    }
  });

  it('el IGTF se decide con la regla del contrato y no se cobra lo que debita el banco', () => {
    const world = mundo();
    for (const payment of cobros(world)) {
      const decision = igtfDecision({
        method: payment.method,
        // La clínica del mundo es contribuyente ordinario, como la siembra de ajustes.
        isSpecialTaxpayer: false,
        rule: null,
      });

      expect(payment.appliesIgtf).toBe(decision.applies);
      expect(payment.igtfPerceivedBy).toBe(decision.perceivedBy);
      expect(payment.igtfBasisPoints).toBe(decision.applies ? decision.basisPoints : 0);
      // Lo percibe el banco, así que la clínica **no** lo suma al cobro.
      expect(payment.igtfAmountCentsUsd).toBe(0);
      expect(payment.igtfAmountVesCentimos).toBe(0);
    }
    expect(cobros(world).some((payment) => payment.appliesIgtf)).toBe(true);
  });

  it('los recibos van en el rango reservado, sin repetir y en orden de cobro', () => {
    const world = mundo();
    const ordenados = [...cobros(world)].sort((left, right) =>
      left.createdAt < right.createdAt ? -1 : 1,
    );
    const numeros = ordenados.map((payment) => payment.receiptNumber);

    expect(world.totals.payments).toBe(numeros.length);
    expect(new Set(numeros).size).toBe(numeros.length);
    expect(numeros[0]).toBe(FICTITIOUS_SEQUENCE_MIN + 1);
    for (const numero of numeros) expect(numero).toBeGreaterThan(FICTITIOUS_SEQUENCE_MIN);
    for (const payment of ordenados) expect(payment.pdfLines.length).toBeGreaterThan(3);
  });

  it('el recibo imprime su número y el saldo que deja', () => {
    for (const invoice of facturas(mundo())) {
      for (const payment of invoice.payments) {
        const etiqueta = `REC-${String(payment.receiptNumber).padStart(6, '0')}`;
        expect(payment.pdfLines[1]).toContain(etiqueta);
        expect(payment.pdfLines.join(' ')).toContain(invoice.patientName);
      }
    }
  });
});

describe('facturación · tasas y aranceles', () => {
  it('hay una tasa por día laborable, creciente, y el día del ancla es manual', () => {
    const world = mundo();
    const rates = world.billing.rates;

    expect(rates.length).toBeGreaterThan(10);
    expect(new Set(rates.map((rate) => rate.rateDate)).size).toBe(rates.length);
    for (const [index, rate] of rates.entries()) {
      const dia = new Date(`${rate.rateDate}T12:00:00Z`).getUTCDay();
      expect(dia).toBeGreaterThanOrEqual(1);
      expect(dia).toBeLessThanOrEqual(5);
      expect(rate.note).not.toBeNull();
      expect(rate.source).toBe(rate.rateDate === ANCLA ? 'manual' : 'bcv_oficial');
      const anterior = rates[index - 1];
      if (anterior !== undefined) expect(rate.rateMicros).toBeGreaterThan(anterior.rateMicros);
    }
    expect(rates.at(-1)?.rateDate).toBe(ANCLA);
  });

  it('la primera tasa cubre el día de la sesión más vieja y la última, el ancla', () => {
    const world = mundo();
    const primeraSesion = [...world.sessions].sort((left, right) =>
      left.closedAt < right.closedAt ? -1 : 1,
    )[0];
    const dia = new Date(new Date(primeraSesion?.closedAt ?? '').getTime() - 4 * 3_600_000)
      .toISOString()
      .slice(0, 10);

    expect(world.billing.rates[0]?.rateDate).toBe(dia);
    expect(rateForClinicDate(world.billing.rates, ANCLA).rateDate).toBe(ANCLA);
  });

  it('cada factura congeló la tasa que regía el día que se emitió', () => {
    const world = mundo();
    for (const invoice of facturas(world)) {
      if (invoice.issuedAt === null) continue;
      const dia = new Date(new Date(invoice.issuedAt).getTime() - 4 * 3_600_000)
        .toISOString()
        .slice(0, 10);
      expect(invoice.exchangeRateMicros).toBe(
        rateForClinicDate(world.billing.rates, dia).rateMicros,
      );
    }
  });

  it('los aranceles cubren todo el catálogo clínico con precio y sin gravar', () => {
    const aranceles = mundo().billing.aranceles;

    expect(aranceles.map((arancel) => arancel.code)).toEqual(
      SESSION_PROCEDURES.map((procedimiento) => procedimiento.code),
    );
    for (const arancel of aranceles) {
      expect(arancel.priceCentsUsd).toBeGreaterThan(0);
      expect(arancel.kind).toBe('servicio');
      expect(arancel.taxCategory).toBe('exento');
    }
  });
});

describe('facturación · los eventos', () => {
  it('la emisión, el cobro, la anulación y la tasa dejan su evento', () => {
    const world = mundo();
    const events = buildTestWorldEvents(world);
    const deFacturacion = events.filter((event) => event.producer === 'billing');
    const emitidas = facturas(world).filter((invoice) => invoice.issuedAt !== null);

    expect(deFacturacion.filter((event) => event.topic === 'billing.rate.set')).toHaveLength(
      world.billing.rates.length,
    );
    expect(deFacturacion.filter((event) => event.topic === 'billing.invoice.issued')).toHaveLength(
      emitidas.length,
    );
    expect(
      deFacturacion.filter((event) => event.topic === 'billing.payment.received'),
    ).toHaveLength(world.totals.payments);
    expect(deFacturacion.filter((event) => event.topic === 'billing.payment.voided')).toHaveLength(
      1,
    );
    expect(
      deFacturacion.filter((event) => event.topic === 'billing.credit_note.issued'),
    ).toHaveLength(1);

    // El borrador no publica: es un acto interno que se puede descartar.
    for (const invoice of facturas(world).filter((item) => item.status === 'borrador')) {
      expect(deFacturacion.some((event) => event.aggregateId === invoice.id)).toBe(false);
    }
  });

  it('el cierre de la sesión tiene el identificador que el seed reclama al facturar', () => {
    const world = mundo();
    const cierres = buildTestWorldEvents(world).filter(
      (event) => event.topic === 'clinical.session.closed',
    );

    expect(cierres).toHaveLength(world.sessions.length);
    for (const session of world.sessions) {
      const evento = cierres.find((item) => item.aggregateId === session.id);
      expect(evento?.id).toBe(sessionClosedEventId(session.id));
    }
  });

  it('la tasa del día viaja antes que la primera factura que la usa', () => {
    const world = mundo();
    const events = buildTestWorldEvents(world);
    const primeraEmision = events.findIndex((event) => event.topic === 'billing.invoice.issued');
    const tasasAntes = events
      .slice(0, primeraEmision)
      .filter((event) => event.topic === 'billing.rate.set');

    expect(primeraEmision).toBeGreaterThan(0);
    expect(tasasAntes.length).toBeGreaterThan(0);
  });
});
