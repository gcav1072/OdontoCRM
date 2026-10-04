import { chromium, type Browser } from 'playwright';

/**
 * El PDF A5 del récipe, con Chromium ([ADR 0015](../../../docs/adr/0015-recipe-a5-en-pdf.md)).
 *
 * Un solo navegador por proceso, reutilizado entre récipes: arrancarlo cuesta más que
 * generar el PDF. Las páginas se abren de a una (una cola sencilla) porque el
 * consultorio emite pocos récipes y no merece la pena un grupo de navegadores; si
 * algún día hacen falta, la cola es el sitio donde cambiarlo.
 */

export interface PdfRendererOptions {
  /** Ruta a un Chromium concreto; vacío usa el que administra Playwright. */
  executablePath?: string | undefined;
  /** Tope de tiempo para que el PDF salga. */
  timeoutMs: number;
}

export interface PdfRenderer {
  /** HTML → PDF A5 (devuelve los bytes). */
  render: (html: string) => Promise<Buffer>;
  /** Cierra el navegador (lo llama el apagado del servicio). */
  close: () => Promise<void>;
  /** `true` cuando el navegador ya está levantado (diagnóstico y pruebas). */
  isRunning: () => boolean;
}

export const createPdfRenderer = (options: PdfRendererOptions): PdfRenderer => {
  let browser: Browser | null = null;
  /** Cola: encadena un render detrás del otro sin abrir dos páginas a la vez. */
  let cola: Promise<unknown> = Promise.resolve();

  const launch = async (): Promise<Browser> => {
    if (browser !== null && browser.isConnected()) return browser;
    browser = await chromium.launch({
      headless: true,
      // `--no-sandbox` es lo habitual en un servicio que corre como usuario de
      // sistema en Linux (Fedora); en Windows no cambia nada.
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
      ...(options.executablePath === undefined ? {} : { executablePath: options.executablePath }),
    });
    return browser;
  };

  const render = (html: string): Promise<Buffer> => {
    const tarea = async (): Promise<Buffer> => {
      const instance = await launch();
      const page = await instance.newPage();
      try {
        page.setDefaultTimeout(options.timeoutMs);
        await page.setContent(html, { waitUntil: 'load', timeout: options.timeoutMs });
        // A5 exacto (148 × 210 mm) con los márgenes de la plantilla.
        return await page.pdf({
          format: 'A5',
          printBackground: true,
        });
      } finally {
        await page.close().catch(() => undefined);
      }
    };

    const resultado = cola.then(tarea, tarea);
    // La cola no se rompe porque un récipe falle: el siguiente vuelve a intentarlo.
    cola = resultado.catch(() => undefined);
    return resultado;
  };

  return {
    render,
    isRunning: () => browser !== null && browser.isConnected(),
    close: async () => {
      const instance = browser;
      browser = null;
      await instance?.close().catch(() => undefined);
    },
  };
};
