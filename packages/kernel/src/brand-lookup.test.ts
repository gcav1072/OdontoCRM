import { BRAND } from '@odontocrm/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createBrandLookup } from './brand-lookup.js';

/**
 * La lectura de la **marca efectiva** (ADR 0060) es la que decide si el papel sale con
 * los colores, las fuentes y el membrete **del panel** o con los **del código**.
 *
 * Esta prueba existe por el fallo silencioso detrás de «cambié el color y el papel salió
 * igual»: si la lectura interna falla —identity caído, la ruta sin desplegar, el secreto
 * distinto, una respuesta que no cumple el contrato—, el servicio degradaba a `BRAND`
 * **sin decir nada**. Ahora el respaldo avisa (`onFallback`), y aquí se fija que:
 *
 *  - una lectura buena devuelve la marca de identity y **no** avisa;
 *  - una lectura rota degrada al respaldo del código **y avisa** con el motivo;
 *  - el aviso no se repite sin parar (como mucho uno por minuto);
 *  - la caché corta evita repetir la lectura entre documentos.
 */
const config = (extra: Partial<Parameters<typeof createBrandLookup>[0]> = {}) => ({
  IDENTITY_URL: 'http://127.0.0.1:4001',
  INTERNAL_SERVICE_SECRET: 'secreto-de-prueba-de-marca',
  ...extra,
});

/** Una marca efectiva válida, con el primario que se quiera. */
const efectiva = (primary: string) => ({
  theme: {
    palette: { ...BRAND.palette, primary },
    typography: { ...BRAND.typography },
    letterhead: { ...BRAND.letterhead, lines: BRAND.letterhead.lines.map((line) => ({ ...line })) },
  },
  fontFaceCss: "@font-face{font-family:'X';src:url(data:font/woff2;base64,AA) format('woff2');}",
  logoDataUri: null,
  version: 'prueba',
  fromDatabase: true,
});

const respuesta = (status: number, body: unknown): Response =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const espia = () => vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createBrandLookup', () => {
  it('devuelve la marca que sirve identity y no avisa del respaldo', async () => {
    const fetchFalso = espia().mockResolvedValue(respuesta(200, efectiva('#c81e1e')));
    vi.stubGlobal('fetch', fetchFalso);
    const onFallback = vi.fn();

    const marca = await createBrandLookup(config({ onFallback }))();

    expect(marca.fromDatabase).toBe(true);
    expect(marca.theme.palette.primary).toBe('#c81e1e');
    expect(onFallback).not.toHaveBeenCalled();
  });

  it('manda el secreto interno en la cabecera', async () => {
    const fetchFalso = espia().mockResolvedValue(respuesta(200, efectiva('#14504d')));
    vi.stubGlobal('fetch', fetchFalso);

    await createBrandLookup(config())();

    const [url, init] = fetchFalso.mock.calls[0] ?? [];
    expect(String(url)).toBe('http://127.0.0.1:4001/internal/v1/identity/brand');
    expect((init?.headers as Record<string, string>)['x-internal-token']).toBe(
      'secreto-de-prueba-de-marca',
    );
  });

  it('si identity responde 404 degrada al respaldo del código y AVISA', async () => {
    vi.stubGlobal('fetch', espia().mockResolvedValue(respuesta(404, { title: 'No existe' })));
    const onFallback = vi.fn();

    const marca = await createBrandLookup(config({ onFallback }))();

    expect(marca.fromDatabase).toBe(false);
    expect(marca.theme.palette.primary).toBe(BRAND.palette.primary);
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(String(onFallback.mock.calls[0]?.[0])).toContain('404');
  });

  it('una respuesta que no cumple el contrato también avisa (y no rompe el papel)', async () => {
    vi.stubGlobal('fetch', espia().mockResolvedValue(respuesta(200, { theme: {} })));
    const onFallback = vi.fn();

    const marca = await createBrandLookup(config({ onFallback }))();

    expect(marca.theme.palette.primary).toBe(BRAND.palette.primary);
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(String(onFallback.mock.calls[0]?.[0])).toContain('contrato');
  });

  it('si no hay secreto interno no pregunta y avisa', async () => {
    const fetchFalso = espia();
    vi.stubGlobal('fetch', fetchFalso);
    const onFallback = vi.fn();

    await createBrandLookup(config({ INTERNAL_SERVICE_SECRET: undefined, onFallback }))();

    expect(fetchFalso).not.toHaveBeenCalled();
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(String(onFallback.mock.calls[0]?.[0])).toContain('INTERNAL_SERVICE_SECRET');
  });

  it('un fallo de red avisa con el motivo', async () => {
    vi.stubGlobal('fetch', espia().mockRejectedValue(new TypeError('fetch failed')));
    const onFallback = vi.fn();

    await createBrandLookup(config({ onFallback }))();

    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(String(onFallback.mock.calls[0]?.[0])).toContain('no se pudo leer la marca');
  });

  it('no repite el aviso en cada documento (como mucho uno por minuto)', async () => {
    vi.stubGlobal('fetch', espia().mockResolvedValue(respuesta(500, 'boom')));
    const onFallback = vi.fn();

    // Caché desactivada: cada lectura vuelve a preguntar (y a fallar).
    const lookup = createBrandLookup(config({ cacheTtlMs: 0, onFallback }));
    await lookup();
    await lookup();
    await lookup();

    expect(onFallback).toHaveBeenCalledTimes(1);
  });

  it('con caché, un cambio de marca se relee tras el TTL', async () => {
    const fetchFalso = espia()
      .mockResolvedValueOnce(respuesta(200, efectiva('#111111')))
      .mockResolvedValueOnce(respuesta(200, efectiva('#222222')));
    vi.stubGlobal('fetch', fetchFalso);

    // TTL de 1 ms: la segunda lectura ya está caducada.
    const lookup = createBrandLookup(config({ cacheTtlMs: 1 }));
    const primera = await lookup();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const segunda = await lookup();

    expect(primera.theme.palette.primary).toBe('#111111');
    expect(segunda.theme.palette.primary).toBe('#222222');
    expect(fetchFalso).toHaveBeenCalledTimes(2);
  });
});
