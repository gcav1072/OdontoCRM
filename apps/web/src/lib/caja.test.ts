import { describe, expect, it } from 'vitest';

import {
  FILTROS_VACIOS,
  aParametrosDeConsulta,
  formatBs,
  formatUsd,
  hayFiltros,
  lineTotalCents,
  linesReady,
  parseUsdToCents,
  puedeAnularse,
  puedeCobrarse,
  puedeDescartarse,
  puedeReimprimirse,
  rangoInvalido,
  reimpresionesEnTexto,
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

describe('el historial de la caja', () => {
  const documento = (status: string, printCount = 0) => ({ status, printCount });

  it('lo que se puede hacer con cada documento sale del estado, no de un if en la pantalla', () => {
    // El borrador: se descarta (no es documento) y no tiene papel que reimprimir.
    expect(puedeDescartarse(documento('borrador'))).toBe(true);
    expect(puedeReimprimirse(documento('borrador'))).toBe(false);
    expect(puedeCobrarse(documento('borrador'))).toBe(false);
    expect(puedeAnularse(documento('borrador'))).toBe(false);

    // Lo emitido sin cobrar del todo: se cobra, se anula y se reimprime.
    for (const estado of ['emitida', 'parcial']) {
      expect(puedeCobrarse(documento(estado))).toBe(true);
      expect(puedeAnularse(documento(estado))).toBe(true);
      expect(puedeReimprimirse(documento(estado))).toBe(true);
      expect(puedeDescartarse(documento(estado))).toBe(false);
    }

    // La pagada: primero se devuelven los cobros; el papel, reimprimible igual.
    expect(puedeCobrarse(documento('pagada'))).toBe(false);
    expect(puedeAnularse(documento('pagada'))).toBe(false);
    expect(puedeReimprimirse(documento('pagada'))).toBe(true);

    // La anulada conserva su PDF: se puede reimprimir, no cobrar ni volver a anular.
    expect(puedeReimprimirse(documento('anulada'))).toBe(true);
    expect(puedeCobrarse(documento('anulada'))).toBe(false);
    expect(puedeAnularse(documento('anulada'))).toBe(false);
  });

  it('las reimpresiones se dicen como se dicen en el mostrador', () => {
    expect(reimpresionesEnTexto(0)).toBe('Sin reimprimir');
    expect(reimpresionesEnTexto(1)).toBe('Reimpresa 1 vez');
    expect(reimpresionesEnTexto(3)).toBe('Reimpresa 3 veces');
  });

  it('los bolívares se escriben con dos decimales y separador de miles', () => {
    expect(formatBs(73_084)).toBe('730,84');
    expect(formatBs(1_234_567)).toBe('12.345,67');
  });

  it('los filtros vacíos no viajan y el texto se recorta', () => {
    expect(aParametrosDeConsulta(FILTROS_VACIOS, 1, 25)).toEqual({ page: 1, pageSize: 25 });
    expect(
      aParametrosDeConsulta(
        { status: 'emitida', from: '2026-10-01', to: '', search: '  90.000.001  ' },
        2,
        10,
      ),
    ).toEqual({
      status: 'emitida',
      from: '2026-10-01',
      search: '90.000.001',
      page: 2,
      pageSize: 10,
    });

    expect(hayFiltros(FILTROS_VACIOS)).toBe(false);
    expect(hayFiltros({ ...FILTROS_VACIOS, search: '  ' })).toBe(false);
    expect(hayFiltros({ ...FILTROS_VACIOS, status: 'pagada' })).toBe(true);

    expect(rangoInvalido({ ...FILTROS_VACIOS, from: '2026-10-05', to: '2026-10-01' })).toBe(true);
    expect(rangoInvalido({ ...FILTROS_VACIOS, from: '2026-10-01', to: '2026-10-05' })).toBe(false);
    expect(rangoInvalido(FILTROS_VACIOS)).toBe(false);
  });
});
