import { describe, expect, it } from 'vitest';

import {
  IGTF_NO_PERCIBIDO,
  fechaFiscal,
  renderInvoiceHtml,
  type InvoicePdfInput,
} from './invoice-pdf.js';

/**
 * La plantilla de la factura, comprobada como **texto**: lo que exige el Art. 13 de la Providencia
 * 0071 tiene que estar en el papel, y el PDF (Chromium) es solo el transporte. Así esta prueba corre
 * siempre y no depende de un navegador.
 */
const partida = (
  code: string,
  description: string,
  unitPriceCentsUsd: number,
  taxCategory: 'exento' | 'general',
  taxRateBasisPoints: number,
  ivaAmountCentsUsd: number,
): InvoicePdfInput['items'][number] => ({
  id: globalThis.crypto.randomUUID(),
  code,
  description,
  toothNumber: null,
  surfaces: null,
  quantity: 1,
  unitPriceCentsUsd,
  totalPriceCentsUsd: unitPriceCentsUsd,
  taxCategory,
  taxRateBasisPoints,
  ivaAmountCentsUsd,
  needsPricing: false,
});

const factura = (extra: Partial<InvoicePdfInput> = {}): InvoicePdfInput => ({
  series: 'A',
  numberLabel: 'A-000123',
  controlNumber: '000456',
  controlRange: { from: '000401', to: '000500' },
  issuedAt: new Date('2026-10-06T14:00:00.000Z'),
  patient: {
    name: 'Ana Pérez',
    docType: 'V',
    docNumber: '12345678',
    taxId: null,
    fiscalAddress: null,
  },
  items: [
    partida('obturacion_resina', 'Obturación con resina compuesta', 5000, 'exento', 0, 0),
    partida('gel_fluorado', 'Gel fluorado', 1200, 'general', 1600, 192),
  ],
  totals: {
    exemptAmountCentsUsd: 5000,
    taxableAmountCentsUsd: 1200,
    ivaAmountCentsUsd: 192,
    totalCentsUsd: 6392,
  },
  rateMicros: 36_542_000,
  printer: {
    name: 'Imprenta Autorizada, C.A.',
    rif: 'J-12345678-9',
    authorizationRef: 'Providencia 0071/2026',
    authorizationDate: '2026-09-30',
    printDate: '2026-10-01',
  },
  igtfNote: IGTF_NO_PERCIBIDO,
  ...extra,
});

describe('la plantilla de la factura', () => {
  it('lleva los dos números, su rango y la fecha en DDMMAAAA', () => {
    const html = renderInvoiceHtml(factura());
    expect(html).toContain('FACTURA');
    expect(html).toContain('A-000123');
    expect(html).toContain('N° de control: 000456');
    expect(html).toContain('desde el N° 000401 hasta el N° 000500');
    // El 6 de octubre a las 14:00 UTC son las 10:00 del 6 en Caracas.
    expect(html).toContain('Fecha de emisión: 06102026');
    // Las 02:00 UTC del 5 son las 22:00 del **4** en Caracas: el papel dice 4.
    expect(fechaFiscal(new Date('2026-10-05T02:00:00.000Z'))).toBe('04102026');
  });

  it('desglosa la base por alícuota con el total exento aparte y marca (E) y (G)', () => {
    const html = renderInvoiceHtml(factura());
    expect(html).toContain('(E)');
    expect(html).toContain('(G)');
    expect(html).toContain('Total exento');
    expect(html).toContain('Base gravada al 16,00 %');
    expect(html).toContain('IVA');
    // Las dos monedas y el tipo de cambio aplicado (Art. 13 num. 14).
    expect(html).toContain('Tipo de cambio:</strong> 36,542 Bs./USD');
    expect(html).toContain('Bs. ');
    expect(html).toContain('US$ ');
    expect(html).toContain('Total general');
  });

  it('imprime la leyenda de doble tasa, la exención y los datos de la imprenta', () => {
    const html = renderInvoiceHtml(factura());
    expect(html).toContain('Art. 19, numeral 6 de la Ley de IVA');
    expect(html).toContain('Convenio Cambiario N.º 1, Art. 8.a');
    expect(html).toContain('Imprenta Autorizada, C.A.');
    expect(html).toContain('J-12345678-9');
    expect(html).toContain('Providencia 0071/2026');
    expect(html).toContain(IGTF_NO_PERCIBIDO);
  });

  it('la copia lleva «sin derecho a crédito fiscal»; el original, no', () => {
    expect(renderInvoiceHtml(factura())).not.toContain('SIN DERECHO A CRÉDITO FISCAL');
    expect(renderInvoiceHtml(factura({ esCopia: true }))).toContain(
      'COPIA — SIN DERECHO A CRÉDITO FISCAL',
    );
  });

  it('un membrete incompleto no rompe el papel: se imprime lo que hay', () => {
    // La clínica tiene que poder cobrar el primer día aunque falten el RIF o la dirección.
    const html = renderInvoiceHtml(
      factura({
        clinic: {
          name: 'Consultorio',
          legalName: 'Consultorio, C.A.',
          rif: '',
          address: '',
          city: '',
        } as never,
      }),
    );
    expect(html).toContain('Consultorio, C.A.');
    expect(html).toContain('RIF:');
  });
});
