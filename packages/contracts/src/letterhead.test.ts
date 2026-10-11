import { describe, expect, it } from 'vitest';

import { BRAND } from './brand.js';
import { CLINIC, type ClinicIdentity } from './clinic.js';
import { buildLetterheadView, letterheadHtml } from './letterhead.js';

/** Un consultorio completo: el membrete tiene de todo. */
const clinica: ClinicIdentity = {
  name: 'Clínica Sonrisa',
  legalName: 'Clínica Sonrisa, C.A.',
  address: 'Av. Principal 123',
  city: 'Caracas',
  phones: ['0212-1234567'],
  email: 'hola@sonrisa.test',
  rif: 'J-12345678-9',
  website: 'https://sonrisa.test',
  logoPath: null,
  dentists: [],
};

describe('buildLetterheadView', () => {
  it('compone el nombre y las líneas en el orden de la marca', () => {
    const view = buildLetterheadView(clinica, 'Od. Ana · Endodoncia · MPPS 1');
    expect(view.name).toBe('Clínica Sonrisa');
    expect(view.lines.map((line) => line.key)).toEqual([
      'address',
      'rif',
      'contact',
      'website',
      'dentist',
    ]);
    expect(view.lines.find((line) => line.key === 'address')?.text).toBe(
      'Av. Principal 123, Caracas',
    );
    expect(view.lines.find((line) => line.key === 'rif')?.text).toBe('RIF J-12345678-9');
    expect(view.lines.find((line) => line.key === 'contact')?.text).toBe(
      '0212-1234567 · hola@sonrisa.test',
    );
  });

  it('respeta el orden y la visibilidad que trae la marca', () => {
    const view = buildLetterheadView(clinica, 'Od. A · Endodoncia', {
      ...BRAND.letterhead,
      lines: [
        { key: 'rif', visible: true },
        { key: 'address', visible: false },
        { key: 'dentist', visible: true },
      ],
    });
    // La dirección quedó oculta y el RIF sube al primer lugar.
    expect(view.lines.map((line) => line.key)).toEqual(['rif', 'dentist']);
  });

  it('descarta las líneas sin dato (nunca imprime un renglón en blanco)', () => {
    const view = buildLetterheadView({ ...CLINIC, name: 'X' }, null);
    expect(view.lines).toHaveLength(0);
  });

  it('una dirección a medias (solo el separador) no deja un renglón huérfano', () => {
    const view = buildLetterheadView({ ...CLINIC, name: 'X', address: '', city: '' }, null);
    expect(view.lines).toHaveLength(0);
  });

  it('el subtítulo y el pie son opcionales', () => {
    const view = buildLetterheadView(
      clinica,
      null,
      { ...BRAND.letterhead, footer: 'Cuidamos tu sonrisa' },
      { subtitle: 'Sucursal Centro' },
    );
    expect(view.subtitle).toBe('Sucursal Centro');
    expect(view.footer).toBe('Cuidamos tu sonrisa');
  });

  it('un pie en blanco no se imprime', () => {
    const view = buildLetterheadView(clinica, null, { ...BRAND.letterhead, footer: '   ' });
    expect(view.footer).toBeNull();
  });
});

describe('letterheadHtml', () => {
  it('pinta el logo, el nombre y las líneas, y escapa el texto', () => {
    const view = buildLetterheadView({ ...clinica, name: '<b>X</b>' }, 'Od. A');
    const html = letterheadHtml(view, 'data:image/svg+xml;base64,AAAA');
    expect(html).toContain('class="brand-lh brand-lh--rule"');
    expect(html).toContain('class="brand-lh-logo" src="data:image/svg+xml;base64,AAAA"');
    expect(html).toContain('&lt;b&gt;X&lt;/b&gt;');
    expect(html).not.toContain('<b>X</b>');
  });

  it('sin regla cuando se pide (documentos de cobro) y sin logo si no hay', () => {
    const view = buildLetterheadView(clinica, null);
    const html = letterheadHtml(view, null, { rule: false });
    expect(html).toContain('class="brand-lh"');
    expect(html).not.toContain('brand-lh--rule');
    expect(html).not.toContain('brand-lh-logo');
  });

  it('marca la línea del especialista con su clase', () => {
    const view = buildLetterheadView(clinica, 'Od. A · Endodoncia');
    expect(letterheadHtml(view, null)).toContain('class="brand-lh-line brand-lh-dentist"');
  });
});
