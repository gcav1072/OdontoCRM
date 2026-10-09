import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  BRAND,
  brandCssVariables,
  brandRootBlock,
  brandStyles,
  brandWatermarkCss,
  brandWatermarkHtml,
  logoMimeType,
} from './brand.js';

/**
 * La marca es una **fuente única** que dos consumidores leen de formas distintas:
 * las plantillas del servidor incrustan `brandRootBlock()` en su `<style>` y la SPA
 * carga `packages/ui/src/styles/marca.css`, generado con `npm run marca:css`.
 *
 * Estas pruebas fijan las dos cosas: que las variables salen completas y que el CSS
 * versionado **no se queda desfasado** del código (el fallo silencioso: alguien
 * cambia un color aquí, no regenera y la pantalla y el papel dejan de coincidir).
 */
const marcaCssPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../packages/ui/src/styles/marca.css',
);

/** Bloque `:root { … }` del CSS, sin la cabecera de aviso del generador. */
const bloqueRoot = (css: string): string => {
  const inicio = css.indexOf(':root {');
  const fin = css.indexOf('\n}', inicio);
  return css.slice(inicio, fin + 2);
};

describe('la marca del consultorio', () => {
  it('declara todas las variables de paleta, tipografía y membrete', () => {
    const variables = brandCssVariables().split('\n');
    expect(variables).toHaveLength(23);
    expect(variables.every((linea) => linea.startsWith('  --brand-'))).toBe(true);
    expect(brandRootBlock()).toContain(`--brand-primary: ${BRAND.palette.primary};`);
    // Los documentos tienen DOS tipografías: la de los títulos y la del cuerpo.
    expect(brandRootBlock()).toContain(
      `--brand-font-doc-title: ${BRAND.typography.documentTitleSans};`,
    );
    expect(brandRootBlock()).toContain(
      `--brand-font-doc-body: ${BRAND.typography.documentBodySans};`,
    );
    expect(brandRootBlock()).toContain(
      `--brand-logo-height-mm: ${String(BRAND.letterhead.logoHeightMm)}mm;`,
    );
  });

  it('declara las dos tipografías y la familia de las fuentes auto-hospedadas', () => {
    expect(BRAND.typography.documentTitleSans).toContain(`'${BRAND.fonts.family}'`);
    expect(BRAND.typography.documentBodySans).toContain(`'${BRAND.fonts.family}'`);
    expect(BRAND.fonts.files.length).toBeGreaterThan(0);
    expect(BRAND.fonts.files.every((file) => file.path.startsWith('assets/clinic/fonts/'))).toBe(
      true,
    );
    // Los pesos que usan los documentos: 700 para los títulos y 400 para el cuerpo.
    const pesos = new Set(BRAND.fonts.files.map((file) => file.weight));
    expect(pesos.has(400)).toBe(true);
    expect(pesos.has(700)).toBe(true);
  });

  it('los archivos de fuente declarados existen en el repositorio', () => {
    const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
    for (const file of BRAND.fonts.files) {
      expect(existsSync(resolve(raiz, file.path)), `falta ${file.path}`).toBe(true);
    }
  });

  it('el CSS versionado coincide con brand.ts (hay que regenerarlo si cambia)', () => {
    const css = readFileSync(marcaCssPath, 'utf8');
    expect(bloqueRoot(css)).toBe(brandRootBlock());
  });

  it('brandStyles() trae las variables y el cuerpo del documento', () => {
    const estilos = brandStyles();
    expect(estilos).toContain(brandRootBlock());
    expect(estilos).toContain('font-family: var(--brand-font-doc-body);');
    expect(estilos).toContain('color: var(--brand-ink);');
    // Los títulos van con su propia familia, aplicada por la clase `.brand-title`.
    expect(estilos).toContain('.brand-title');
    expect(estilos).toContain('font-family: var(--brand-font-doc-title);');
  });

  it('reconoce el tipo MIME del logo por su extensión', () => {
    expect(logoMimeType('assets/clinic/logo.svg')).toBe('image/svg+xml');
    expect(logoMimeType('assets/clinic/logo.png')).toBe('image/png');
    expect(logoMimeType('assets/clinic/logo.JPG')).toBe('image/jpeg');
    expect(logoMimeType('assets/clinic/logo.jpeg')).toBe('image/jpeg');
    expect(logoMimeType('assets/clinic/logo.webp')).toBe('image/webp');
    // Sin extensión reconocible cae en PNG, que es el comportamiento de siempre.
    expect(logoMimeType('assets/clinic/logo')).toBe('image/png');
  });

  it('el logo y la marca de agua apuntan a un archivo del almacén de la clínica', () => {
    expect(BRAND.logoPath.startsWith('assets/clinic/')).toBe(true);
    expect(BRAND.watermarkPath.startsWith('assets/clinic/')).toBe(true);
  });

  it('la marca de agua se centra, se repite por hoja y deja el contenido por encima', () => {
    const css = brandWatermarkCss();
    expect(css).toContain('.brand-watermark');
    expect(css).toContain('position: fixed');
    expect(css).toContain('width: var(--brand-watermark-width-mm)');
    expect(css).toContain('opacity: var(--brand-watermark-opacity)');
    // El contenido va sobre el velo; sin esta regla, la marca taparía el texto.
    expect(css).toContain('.brand-doc');
  });

  it('sin logo no hay marca de agua (una cadena vacía, no un elemento roto)', () => {
    expect(brandWatermarkHtml(null)).toBe('');
    expect(brandWatermarkHtml('')).toBe('');
    expect(brandWatermarkHtml('data:image/svg+xml;base64,AAAA')).toBe(
      '<img class="brand-watermark" src="data:image/svg+xml;base64,AAAA" alt="" aria-hidden="true">',
    );
  });
});
