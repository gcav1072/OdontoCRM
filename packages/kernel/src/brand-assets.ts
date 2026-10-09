import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { BRAND, logoMimeType, type BrandFonts } from '@odontocrm/contracts';

/**
 * Lee una imagen del repositorio (el logo o la marca de agua del consultorio) y la
 * devuelve como `data:` URI, lista para incrustar en el HTML que se compone a PDF.
 *
 * **¿Por qué un `data:` URI y no la ruta?** Porque el documento que sale de aquí se
 * le pasa a Chromium como cadena y el PDF se archiva: si la imagen dependiera de una
 * ruta del sistema, el papel dejaría de explicarse solo en cuanto el archivo se
 * moviera. El tipo MIME lo resuelve `logoMimeType` de la marca, que reconoce el SVG
 * (el logo por defecto es un vector) además de PNG y JPG.
 *
 * Devuelve `null` —y el documento sale sin esa imagen— cuando la ruta es `null`, está
 * vacía o el archivo no existe: nunca lanza. Igual que el membrete, que avisa de lo
 * que le falta en vez de romper el papel (`letterheadMissingFields`).
 *
 * La ruta es **relativa a la raíz del repositorio**, como las de `BRAND` y `CLINIC`
 * (`assets/clinic/logo.svg`); la resuelve el proceso del servicio, que corre desde la
 * raíz del proyecto.
 */
export const readImageDataUri = async (path: string | null | undefined): Promise<string | null> => {
  if (path === null || path === undefined || path.trim() === '') return null;
  try {
    const data = await readFile(resolve(path));
    return `data:${logoMimeType(path)};base64,${data.toString('base64')}`;
  } catch {
    return null;
  }
};

/** Tipo MIME de los archivos de fuente que sirve la marca (subconjunto `latin`). */
const FONT_MIME = 'font/woff2';

/** Un `.woff2` del repositorio como `data:` URI, o `null` si el archivo no está. */
const readFontDataUri = async (path: string): Promise<string | null> => {
  try {
    const data = await readFile(resolve(path));
    return `data:${FONT_MIME};base64,${data.toString('base64')}`;
  } catch {
    return null;
  }
};

/**
 * Las reglas `@font-face` de las fuentes de la marca, con cada `.woff2` incrustado
 * como `data:` URI.
 *
 * **¿Por qué incrustadas y no un `<link>` o un `@import`?** Porque el HTML se le pasa
 * a Chromium como **cadena** y el PDF se archiva: una fuente que dependiera de una
 * ruta del sistema —o de que el equipo la tenga instalada— cambiaría el documento
 * según dónde se compusiera. Incrustada, el récipe sale igual en cualquier servidor,
 * y la SPA usa los MISMOS archivos (los `.woff2` de `assets/clinic/fonts/`).
 *
 * Un archivo que falte se salta sin romper el documento: el texto cae en la pila de
 * respaldo de `documentTitleSans`/`documentBodySans`.
 */
export const brandFontFaceCss = async (fonts: BrandFonts = BRAND.fonts): Promise<string> => {
  const reglas = await Promise.all(
    fonts.files.map(async (file) => {
      const dataUri = await readFontDataUri(file.path);
      if (dataUri === null) return '';
      return (
        '@font-face {\n' +
        `  font-family: '${fonts.family}';\n` +
        `  font-style: ${file.style};\n` +
        `  font-weight: ${String(file.weight)};\n` +
        '  font-display: swap;\n' +
        `  src: url(${dataUri}) format('woff2');\n` +
        '}'
      );
    }),
  );
  return reglas.filter((regla) => regla !== '').join('\n');
};
