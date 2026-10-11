import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  BRAND,
  RECIPE_MARGIN_MM,
  brandCssVariables,
  brandRootBlock,
  brandStyles,
  brandWatermarkCss,
  brandWatermarkHtml,
  fontStackFor,
  letterheadCss,
  logoMimeType,
  recipePaperGeometry,
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
    expect(variables).toHaveLength(31);
    expect(variables.every((linea) => linea.startsWith('  --brand-'))).toBe(true);
    expect(brandRootBlock()).toContain(`--brand-primary: ${BRAND.palette.primary};`);
    // Los documentos tienen DOS tipografías: la de los títulos y la del cuerpo.
    expect(brandRootBlock()).toContain(
      `--brand-font-doc-title: ${BRAND.typography.documentTitleSans};`,
    );
    expect(brandRootBlock()).toContain(
      `--brand-font-doc-body: ${BRAND.typography.documentBodySans};`,
    );
    // Y un peso por rol, para no fijar «700» a mano en las plantillas.
    expect(brandRootBlock()).toContain(
      `--brand-font-doc-title-weight: ${String(BRAND.typography.documentTitleWeight)};`,
    );
    expect(brandRootBlock()).toContain(
      `--brand-font-doc-body-weight: ${String(BRAND.typography.documentBodyWeight)};`,
    );
    expect(brandRootBlock()).toContain(
      `--brand-logo-height-mm: ${String(BRAND.letterhead.logoHeightMm)}mm;`,
    );
  });

  it('publica las variables del membrete configurable (alineación, tipografía, líneas)', () => {
    const raiz = brandRootBlock();
    expect(raiz).toContain('--brand-lh-logo-align: flex-start;');
    expect(raiz).toContain('--brand-lh-logo-valign: center;');
    expect(raiz).toContain(`--brand-lh-title-pt: ${String(BRAND.letterhead.titlePt)}pt;`);
    expect(raiz).toContain(`--brand-lh-line-pt: ${String(BRAND.letterhead.linePt)}pt;`);
    // La tipografía del nombre cae en la de los títulos cuando no se elige una propia.
    expect(raiz).toContain(`--brand-lh-title-font: ${BRAND.typography.documentTitleSans};`);
  });

  it('el CSS del bloque de identidad comparte clases y lee las variables de la marca', () => {
    const css = letterheadCss();
    expect(css).toContain('.brand-lh');
    expect(css).toContain('.brand-lh--rule');
    expect(css).toContain('align-items: var(--brand-lh-logo-valign)');
    expect(css).toContain('justify-content: var(--brand-lh-logo-align)');
    expect(css).toContain('height: var(--brand-logo-height-mm)');
    expect(css).toContain('font-size: var(--brand-lh-line-pt)');
    // El nombre del membrete puede ir en dos líneas: el CSS respeta el salto.
    expect(css).toContain('white-space: pre-line');
  });

  it('declara las dos tipografías sobre familias del catálogo, con su peso', () => {
    const nombres = BRAND.fonts.families.map((familia) => `'${familia.name}'`);
    const familiaDeLaPila = (pila: string): string => pila.split(',')[0]?.trim() ?? '';

    // La familia del título es una del catálogo y tiene archivo con el peso del título.
    const titulo = familiaDeLaPila(BRAND.typography.documentTitleSans);
    expect(nombres).toContain(titulo);
    const familiaTitulo = BRAND.fonts.families.find((f) => `'${f.name}'` === titulo);
    expect(
      familiaTitulo?.files.some((file) => file.weight === BRAND.typography.documentTitleWeight),
    ).toBe(true);

    // Lo mismo para el cuerpo.
    const cuerpo = familiaDeLaPila(BRAND.typography.documentBodySans);
    expect(nombres).toContain(cuerpo);
    const familiaCuerpo = BRAND.fonts.families.find((f) => `'${f.name}'` === cuerpo);
    expect(
      familiaCuerpo?.files.some((file) => file.weight === BRAND.typography.documentBodyWeight),
    ).toBe(true);

    const archivos = BRAND.fonts.families.flatMap((familia) => familia.files);
    expect(archivos.length).toBeGreaterThan(0);
    expect(archivos.every((file) => file.path.startsWith('assets/clinic/fonts/'))).toBe(true);
    // Los pesos que usan los documentos: 700 para los títulos y 400 para el cuerpo.
    const pesos = new Set(archivos.map((file) => file.weight));
    expect(pesos.has(400)).toBe(true);
    expect(pesos.has(700)).toBe(true);
  });

  it('compone la pila de una familia con el respaldo detrás', () => {
    expect(fontStackFor('Lobster')).toBe(
      `'Lobster', 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif`,
    );
  });

  it('los archivos de fuente declarados existen en el repositorio', () => {
    const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
    for (const familia of BRAND.fonts.families) {
      for (const file of familia.files) {
        expect(existsSync(resolve(raiz, file.path)), `falta ${file.path}`).toBe(true);
      }
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

describe('el papel del récipe', () => {
  it('la marca de fábrica imprime en A4, el papel de los demás imprimibles', () => {
    // Regresión del fallo de producción: el récipe salía en carta apaisada (215,9 mm de
    // alto) y esa hoja no cabe en una A4 (210 mm): la impresora dejaba una segunda hoja
    // en blanco con el récipe perfecto en la primera.
    expect(BRAND.recipePaper).toBe('A4');
  });

  it('la geometría dice lo mismo para el `@page` y para el PDF', () => {
    const a4 = recipePaperGeometry('A4');
    expect(a4.cssSize).toBe('A4 landscape');
    expect(a4.format).toBe('A4');
    // Medida apaisada y real de la hoja (mm): la que decide si cabe en el papel.
    expect(a4.widthMm).toBe(297);
    expect(a4.heightMm).toBe(210);

    const carta = recipePaperGeometry('letter');
    expect(carta.cssSize).toBe('letter landscape');
    expect(carta.format).toBe('Letter');
    expect(carta.widthMm).toBeCloseTo(279.4, 1);
    expect(carta.heightMm).toBeCloseTo(215.9, 1);
    // El área imprimible no puede ser cero: el margen de la plantilla es menor que el papel.
    expect(RECIPE_MARGIN_MM).toBeGreaterThan(0);
    expect(RECIPE_MARGIN_MM * 2).toBeLessThan(a4.heightMm);
  });
});
