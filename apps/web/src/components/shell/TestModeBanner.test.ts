import {
  FICTITIOUS_DOCUMENT_MAX,
  FICTITIOUS_DOCUMENT_MIN,
  resolveTestMode,
  TEST_MODE_BANNER,
  TEST_MODE_BANNER_DETAIL,
  TEST_MODE_SEED,
  type SystemMeta,
} from '@odontocrm/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { t } from '../../lib/i18n';
import { TestModeBanner } from './TestModeBanner';

/**
 * El banner se prueba pintado a HTML estático (como el resto de componentes del
 * proyecto): interesa el texto y el papel que lee una persona, no el DOM.
 */
const meta = (nodeEnv: string, testMode: boolean, allowTestMode: boolean): SystemMeta => ({
  service: 'gateway',
  version: '0.1.0',
  environment: nodeEnv,
  timestamp: '2026-10-04T12:00:00.000Z',
  testMode: resolveTestMode({ nodeEnv, testMode, allowTestMode }),
  fixtures: {
    seed: TEST_MODE_SEED,
    documentMin: FICTITIOUS_DOCUMENT_MIN,
    documentMax: FICTITIOUS_DOCUMENT_MAX,
  },
});

const pintar = (estado: SystemMeta | undefined): string =>
  renderToStaticMarkup(createElement(TestModeBanner, { meta: estado }));

describe('TestModeBanner', () => {
  it('no ocupa nada mientras no se sabe el estado', () => {
    expect(pintar(undefined)).toBe('');
  });

  it('no se pinta con el modo test apagado', () => {
    expect(pintar(meta('development', false, false))).toBe('');
    // Pedido sin permiso: tampoco (la regla la decide el servidor, no la interfaz).
    expect(pintar(meta('development', true, false))).toBe('');
  });

  it('en producción nunca se pinta, aunque las banderas estén en true', () => {
    expect(pintar(meta('production', true, true))).toBe('');
  });

  it('con el modo test activo avisa, dice qué no hacer y enseña la semilla', () => {
    const html = pintar(meta('development', true, true));

    expect(html).toContain(TEST_MODE_BANNER);
    expect(html).toContain('no uses esta instalación con pacientes reales');
    expect(html).toContain(TEST_MODE_SEED);
    expect(html).toContain('role="status"');
    // En papel no sale: los documentos llevan su propia marca.
    expect(html).toContain('print:hidden');
  });

  it('el texto del banner y el del contrato no se separan', () => {
    expect(t('modoTest.titulo')).toBe(TEST_MODE_BANNER);
    expect(t('modoTest.detalle')).toBe(TEST_MODE_BANNER_DETAIL);
  });
});
