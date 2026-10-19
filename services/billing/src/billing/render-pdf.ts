import { ServiceUnavailableError } from '@odontocrm/kernel';

import type { PdfPageOptions } from '../pdf-renderer.js';

/** Lo mínimo del renderizador: `render(html, opciones) → bytes`. */
export interface PdfRender {
  render: (html: string, options?: PdfPageOptions) => Promise<Buffer>;
}

/**
 * Compone un PDF de la caja con Chromium (Playwright).
 *
 * El navegador vive **fuera del código** (en `PLAYWRIGHT_BROWSERS_PATH` o en la caché del
 * usuario del servicio): si falta, no arranca o le faltan bibliotecas, `playwright` lanza un
 * error de bajo nivel. Eso **no** puede llegar al mostrador como un **500 opaco** —«error
 * interno del servidor»—: aquí se convierte en un **503 que dice qué pasa y dónde se arregla**,
 * el mismo trato que ya recibe el PDF de los reportes.
 */
export const renderBillingPdf = async (
  pdf: PdfRender,
  html: string,
  documento: string,
  options?: PdfPageOptions,
): Promise<Buffer> => {
  try {
    return await pdf.render(html, options);
  } catch (error) {
    throw new ServiceUnavailableError(
      `No se pudo generar el PDF de ${documento}: revisa el navegador (Chromium) del servidor. ` +
        (error instanceof Error ? error.message : String(error)),
    );
  }
};
