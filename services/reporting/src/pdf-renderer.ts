import { chromium, type Browser } from 'playwright';

/**
 * El PDF del reporte, con Chromium.
 *
 * **Viene de `services/clinical/src/prescriptions/pdf-renderer.ts`** (el récipe A5):
 * mismo patrón —un navegador por proceso, reutilizado entre documentos, y una cola
 * sencilla para no abrir dos páginas a la vez—, cambia solo el formato del papel
 * (carta **horizontal**, que es lo que pide una tabla de reporte con muchas columnas).
 *
 * Se copia en vez de compartirse porque el paquete de utilidades comunes no tiene
 * (ni debe tener) dependencia de Playwright: los servicios que imprimen son dos y
 * cada uno decide su formato.
 */

export interface PdfRendererOptions {
  /** Ruta a un Chromium concreto; vacío usa el que administra Playwright. */
  executablePath?: string | undefined;
  /** Tope de tiempo para que el PDF salga. */
  timeoutMs: number;
}

export interface PdfRenderer {
  /** HTML → PDF carta horizontal (devuelve los bytes). */
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
        // Esquema de color EXPLÍCITO: el PDF es papel, no pantalla. Sin esto, un
        // Chromium con preferencia oscura podría pintar la plantilla en oscuro (y
        // con `printBackground` eso sale impreso). Medido en la Fase 10 con las
        // páginas que imprime el navegador.
        await page.emulateMedia({ colorScheme: 'light' });
        await page.setContent(html, { waitUntil: 'load', timeout: options.timeoutMs });
        // El evento `load` NO espera a que las `@font-face` se decodifiquen: sin esperar a
        // `document.fonts.ready`, el reporte podía salir con la pila de respaldo.
        await page.evaluate(async () => {
          // En la página (Chromium) existe `document.fonts`; el servicio compila sin la lib DOM.
          const fuentes = (globalThis as { document?: { fonts?: { ready?: Promise<unknown> } } })
            .document?.fonts;
          await fuentes?.ready;
        });
        return await page.pdf({
          format: 'Letter',
          landscape: true,
          printBackground: true,
        });
      } finally {
        await page.close().catch(() => undefined);
      }
    };

    const resultado = cola.then(tarea, tarea);
    // La cola no se rompe porque un reporte falle: el siguiente vuelve a intentarlo.
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
