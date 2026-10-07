import { ServiceUnavailableError } from '@odontocrm/kernel';
import { describe, expect, it } from 'vitest';

import { renderBillingPdf } from './render-pdf.js';

/**
 * El envoltorio del PDF de la caja: cuando Chromium no puede componer el documento (el navegador
 * no está bajado, no arranca o le faltan bibliotecas), el error de bajo nivel de Playwright **no**
 * puede llegar al mostrador como un 500 opaco: se convierte en un 503 que dice de qué va.
 */
describe('el PDF de la caja cuando Chromium falla', () => {
  it('convierte el fallo del navegador en un 503 explicado', async () => {
    const pdf = {
      render: () => Promise.reject(new Error('browserType.launch: Executable doesn’t exist')),
    };

    await expect(renderBillingPdf(pdf, '<html></html>', 'la factura')).rejects.toBeInstanceOf(
      ServiceUnavailableError,
    );
    await expect(renderBillingPdf(pdf, '<html></html>', 'la factura')).rejects.toThrow(
      /navegador \(Chromium\)/,
    );
  });

  it('deja pasar los bytes cuando el navegador sí compone', async () => {
    const bytes = Buffer.from('%PDF-1.7');
    const pdf = { render: () => Promise.resolve(bytes) };

    await expect(renderBillingPdf(pdf, '<html></html>', 'el recibo')).resolves.toBe(bytes);
  });
});
