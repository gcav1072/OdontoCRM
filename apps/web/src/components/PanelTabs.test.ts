import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { PanelTabs, panelPanelId, panelTabId } from './PanelTabs';

/**
 * Pruebas del patrón de pestañas: se renderiza a HTML real (servidor) y se leen los
 * atributos ARIA, que es donde un `tablist` se rompe en silencio. No se simulan
 * pulsaciones —eso es comportamiento de navegador— pero sí queda fijado que el
 * reparto `tab`/`tabpanel` es coherente y que solo la pestaña activa es tabulable.
 *
 * El archivo va en `.ts` (no `.tsx`) porque `vitest.config.ts` solo recoge
 * `**\/*.test.ts`: el JSX se escribe con `createElement`.
 */

const PESTANAS = [
  { key: 'jornada' as const, label: 'Jornada' },
  { key: 'citas' as const, label: 'Citas' },
  { key: 'cancelaciones' as const, label: 'Cancelaciones' },
];

const html = (active: 'jornada' | 'citas' | 'cancelaciones'): string =>
  renderToStaticMarkup(
    createElement(PanelTabs, {
      idPrefix: 'programacion',
      label: 'Secciones de la jornada',
      tabs: PESTANAS,
      active,
      onSelect: () => undefined,
    }),
  );

describe('pestañas de sección', () => {
  it('arma un tablist con nombre accesible y una pestaña por sección', () => {
    const markup = html('jornada');
    expect(markup).toContain('role="tablist"');
    expect(markup).toContain('aria-label="Secciones de la jornada"');
    expect([...markup.matchAll(/role="tab"/g)]).toHaveLength(3);
    for (const pestana of PESTANAS) {
      expect(markup).toContain(`>${pestana.label}</button>`);
    }
  });

  it('marca solo la activa como seleccionada y, con roving tabindex, solo ella es tabulable', () => {
    const markup = html('citas');
    expect([...markup.matchAll(/aria-selected="true"/g)]).toHaveLength(1);
    // La pestaña activa es la única con `tabindex="0"`; las otras quedan en -1.
    expect([...markup.matchAll(/tabindex="0"/g)]).toHaveLength(1);
    expect([...markup.matchAll(/tabindex="-1"/g)]).toHaveLength(2);
    // Y el `tabindex="0"` cae justo en la de «Citas».
    const activa = /<button[^>]*tabindex="0"[^>]*>([^<]*)<\/button>/.exec(markup)?.[1];
    expect(activa).toBe('Citas');
  });

  it('cada pestaña apunta a su panel con los ids compartidos', () => {
    const markup = html('jornada');
    // Los ids que exporta el módulo son los que la página usa para el `tabpanel`.
    expect(markup).toContain(`id="${panelTabId('programacion', 'citas')}"`);
    expect(markup).toContain(`aria-controls="${panelPanelId('programacion', 'citas')}"`);
    expect(markup).toContain(`id="${panelTabId('programacion', 'cancelaciones')}"`);
    expect(markup).toContain(`aria-controls="${panelPanelId('programacion', 'cancelaciones')}"`);
  });

  it('una pestaña deshabilitada se pinta como tal', () => {
    const markup = renderToStaticMarkup(
      createElement(PanelTabs, {
        idPrefix: 'programacion',
        label: 'Secciones de la jornada',
        tabs: [
          { key: 'jornada' as const, label: 'Jornada' },
          { key: 'citas' as const, label: 'Citas', disabled: true },
        ],
        active: 'jornada',
        onSelect: () => undefined,
      }),
    );
    expect(markup).toContain('disabled=""');
  });
});
