import type { PublicLicensingView } from '@odontocrm/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { LicenseBanner } from './LicenseBanner';

/**
 * El banner se prueba pintado a HTML estático (como el resto de componentes del
 * proyecto): interesa qué lee una persona y en qué papel, no el DOM.
 *
 * Se pinta **sin proveedores** a propósito: el banner presentacional es el que también
 * se monta en el login y en las pantallas kiosko, donde no hay sesión.
 */
const vista = (over: Partial<PublicLicensingView> = {}): PublicLicensingView => ({
  estado: 'trial',
  soloLectura: false,
  origen: 'trial',
  tipo: null,
  diasRestantes: 23,
  venceEn: '2026-12-11T12:00:00.000-04:00',
  mensaje: 'Estás en el periodo de prueba: quedan 23 días.',
  ...over,
});

const pintar = (estado: PublicLicensingView | undefined, puedeActivar = false): string =>
  renderToStaticMarkup(createElement(LicenseBanner, { vista: estado, puedeActivar }));

describe('LicenseBanner', () => {
  it('no ocupa nada mientras no se sabe el estado', () => {
    expect(pintar(undefined)).toBe('');
  });

  it('no se pinta con la licencia vigente', () => {
    expect(
      pintar(
        vista({
          estado: 'licencia_vigente',
          origen: 'licencia',
          tipo: 'anual',
          diasRestantes: 200,
        }),
      ),
    ).toBe('');
  });

  it('la prueba se anuncia con los días que quedan y sin romper el papel', () => {
    const html = pintar(vista());

    expect(html).toContain('PRUEBA');
    expect(html).toContain('23 días');
    expect(html).toContain('Estás en el periodo de prueba');
    expect(html).toContain('role="status"');
    expect(html).toContain('data-testid="banner-licencia"');
    // En papel no sale: los documentos llevan su propio membrete.
    expect(html).toContain('print:hidden');
  });

  it('el modo consulta es rojo, se queda fijo y avisa de que se puede ver pero no editar', () => {
    const html = pintar(
      vista({
        estado: 'licencia_vencida',
        soloLectura: true,
        origen: 'licencia',
        tipo: 'mensual',
        diasRestantes: 0,
        mensaje:
          'La licencia venció el 10/12/2026. El sistema está en modo consulta: se puede ver, imprimir y exportar, pero no editar.',
      }),
    );

    expect(html).toContain('LICENCIA VENCIDA');
    expect(html).toContain('modo consulta');
    expect(html).toContain('role="alert"');
    expect(html).toContain('sticky');
  });

  it('el enlace a /licencia solo se pinta para quien puede activar', () => {
    const vencida = vista({ estado: 'trial_vencida', soloLectura: true, diasRestantes: 0 });

    const conPermiso = pintar(vencida, true);
    expect(conPermiso).toContain('href="/licencia"');
    expect(conPermiso).toContain('Activar licencia');

    const sinPermiso = pintar(vencida, false);
    expect(sinPermiso).not.toContain('href="/licencia"');
    expect(sinPermiso).toContain('Pide al administrador');
  });

  it('la licencia por vencer avisa en amarillo y enlaza a la página', () => {
    const html = pintar(
      vista({
        estado: 'licencia_por_vencer',
        origen: 'licencia',
        tipo: 'trimestral',
        diasRestantes: 5,
      }),
      true,
    );

    expect(html).toContain('LICENCIA');
    expect(html).toContain('5 días');
    expect(html).toContain('href="/licencia"');
    expect(html).toContain('Ver licencia');
  });
});
