import { BRAND, type BrandThemePayload, type ClinicIdentity } from '@odontocrm/contracts';
import { describe, expect, it } from 'vitest';

import { renderCreditNoteHtml, type CreditNotePdfInput } from './credit-note-pdf.js';
import { renderReceiptHtml, type ReceiptPdfInput } from './receipt-pdf.js';

/** Un consultorio con la razón social en blanco: el caso que destapó el membrete sin nombre. */
const consultorio = {
  name: 'Consultorio Sonrisa',
  legalName: '',
  address: 'Calle 1',
  city: 'Caracas',
  phones: [],
  email: null,
  rif: null,
  website: null,
  logoPath: null,
  dentists: [],
} satisfies ClinicIdentity;

/**
 * El **recibo** y la **nota de crédito** no tenían prueba de plantilla. Además de dejar
 * constancia de lo que llevan, aquí se fija lo mismo que en la factura: los colores del
 * papel salen de la **marca del panel** y no del respaldo del código (el fallo de
 * «cambié el color y el papel salió igual»).
 */
const marca: BrandThemePayload = {
  palette: { ...BRAND.palette, primary: '#c81e1e', accent: '#f97316' },
  typography: BRAND.typography,
  letterhead: BRAND.letterhead,
  recipePaper: BRAND.recipePaper,
};

const recibo = (extra: Partial<ReceiptPdfInput> = {}): ReceiptPdfInput => ({
  receiptLabel: 'REC-000001',
  invoiceLabel: 'A-000123',
  paidAt: new Date('2026-10-06T14:00:00.000Z'),
  patient: { name: 'Ana Pérez', docType: 'V', docNumber: '12345678' },
  method: 'efectivo',
  tenderedAmount: 30,
  tenderedCurrency: 'USD',
  amountCentsUsd: 2500,
  rateMicros: 36_542_000,
  imputationPolicy: 'pago_primero',
  fxDifferenceCentsUsd: 0,
  igtf: {
    applies: false,
    perceivedBy: null,
    basisPoints: 0,
    amountCentsUsd: 0,
    amountVesCentimos: 0,
  },
  totalCentsUsd: 2500,
  balanceCentsUsd: 0,
  receivedByUsername: 'prueba',
  ...extra,
});

const nota = (extra: Partial<CreditNotePdfInput> = {}): CreditNotePdfInput => ({
  creditNoteLabel: 'NC-000001',
  issuedAt: new Date('2026-10-06T14:00:00.000Z'),
  invoice: {
    numberLabel: 'A-000123',
    issuedAt: new Date('2026-10-05T14:00:00.000Z'),
    totalCentsUsd: 2500,
  },
  patient: { name: 'Ana Pérez', docType: 'V', docNumber: '12345678' },
  reason: 'Devolución del tratamiento',
  totalCentsUsd: 2500,
  totalVesCentimos: 91_355_000,
  rateMicros: 36_542_000,
  issuedByUsername: 'prueba',
  ...extra,
});

describe('la plantilla del recibo', () => {
  it('lleva el número, la factura que paga, el medio y el saldo', async () => {
    const html = await renderReceiptHtml(recibo());
    expect(html).toContain('REC-000001');
    expect(html).toContain('A-000123');
    expect(html).toContain('Ana Pérez');
  });

  it('el nombre del consultorio encabeza el membrete (no la razón social)', async () => {
    const html = await renderReceiptHtml(recibo({ clinic: consultorio }));
    expect(html).toContain('<p class="brand-lh-name">Consultorio Sonrisa</p>');
  });

  it('los COLORES del papel salen de la marca del panel, no del código', async () => {
    const html = await renderReceiptHtml(recibo({ brand: marca }));
    expect(html).toContain('--brand-primary: #c81e1e;');
    expect(html).toContain('--brand-accent: #f97316;');
    expect(html).not.toContain(`--brand-primary: ${BRAND.palette.primary};`);
  });
});

describe('la plantilla de la nota de crédito', () => {
  it('referencia la factura que deja sin efecto, con su número, fecha y monto', async () => {
    const html = await renderCreditNoteHtml(nota());
    expect(html).toContain('NC-000001');
    expect(html).toContain('A-000123');
    expect(html).toContain('Devolución del tratamiento');
  });

  it('el nombre del consultorio encabeza el membrete (no la razón social)', async () => {
    const html = await renderCreditNoteHtml(nota({ clinic: consultorio }));
    expect(html).toContain('<p class="brand-lh-name">Consultorio Sonrisa</p>');
  });

  it('los COLORES del papel salen de la marca del panel, no del código', async () => {
    const html = await renderCreditNoteHtml(nota({ brand: marca }));
    expect(html).toContain('--brand-primary: #c81e1e;');
    expect(html).toContain('--brand-accent: #f97316;');
    expect(html).not.toContain(`--brand-primary: ${BRAND.palette.primary};`);
  });
});
