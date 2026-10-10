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

/** Un `.woff2` como `data:` URI, o `null` si el archivo no está. */
export const readFontFileDataUri = async (path: string): Promise<string | null> => {
  try {
    const data = await readFile(resolve(path));
    return `data:${FONT_MIME};base64,${data.toString('base64')}`;
  } catch {
    return null;
  }
};

/** Una fuente ya resuelta a su `data:` URI, lista para armar su `@font-face`. */
export interface ResolvedFontFace {
  family: string;
  weight: number;
  style: 'normal' | 'italic';
  dataUri: string;
}

/** La regla `@font-face` de una fuente resuelta. */
export const fontFaceRule = (face: ResolvedFontFace): string =>
  '@font-face {\n' +
  `  font-family: '${face.family}';\n` +
  `  font-style: ${face.style};\n` +
  `  font-weight: ${String(face.weight)};\n` +
  '  font-display: swap;\n' +
  `  src: url(${face.dataUri}) format('woff2');\n` +
  '}';

/**
 * Todas las reglas `@font-face` de una lista **ya resuelta** (cada `.woff2` como
 * `data:` URI). Es la parte pura: quien lee los archivos es el llamador —el servicio
 * de documentos del repositorio, o identity para las fuentes subidas al almacén—.
 */
export const fontFaceCssFromResolved = (faces: readonly ResolvedFontFace[]): string =>
  faces.map(fontFaceRule).join('\n');

/**
 * Las reglas `@font-face` de las fuentes de la marca, con cada `.woff2` del
 * repositorio incrustado como `data:` URI.
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
  const porFamilia = await Promise.all(
    fonts.families.map(async (familia) =>
      Promise.all(
        familia.files.map(async (file): Promise<ResolvedFontFace | null> => {
          const dataUri = await readFontFileDataUri(file.path);
          return dataUri === null
            ? null
            : { family: familia.name, weight: file.weight, style: file.style, dataUri };
        }),
      ),
    ),
  );
  const faces = porFamilia.flat().filter((face): face is ResolvedFontFace => face !== null);
  return fontFaceCssFromResolved(faces);
};
