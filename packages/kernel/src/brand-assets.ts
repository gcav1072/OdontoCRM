import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { logoMimeType } from '@odontocrm/contracts';

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
