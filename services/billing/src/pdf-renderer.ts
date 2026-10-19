import { chromium, type Browser } from 'playwright';

/**
 * El PDF de la factura, con Chromium.
 *
 * **Viene de `services/reporting/src/pdf-renderer.ts`** (que a su vez vino del récipe A5): mismo
 * patrón —un navegador por proceso, reutilizado entre documentos, y una cola sencilla para no abrir
 * dos páginas a la vez—, cambia solo el papel: **carta vertical**, que es la forma de la factura.
 *
 * Se copia en vez de compartirse porque el paquete de utilidades comunes no tiene (ni debe tener)
 * dependencia de Playwright.
 */
export interface PdfRendererOptions {
  /** Ruta a un Chromium concreto; vacío usa el que administra Playwright. */
  executablePath?: string | undefined;
  /** Tope de tiempo para que el PDF salga. */
  timeoutMs: number;
}

/** Cómo se compone el papel. La factura usa los valores por defecto (carta vertical, sin folio). */
export interface PdfPageOptions {
  /** Tabla ancha (los libros fiscales): carta **horizontal**. */
  landscape?: boolean;
  /** Numera las páginas al pie («Página 1 de 3»). Para informes de varias hojas. */
  folios?: boolean;
}

export interface PdfRenderer {
  /** HTML → PDF (devuelve los bytes). */
  render: (html: string, options?: PdfPageOptions) => Promise<Buffer>;
  /** Cierra el navegador (lo llama el apagado del servicio). */
  close: () => Promise<void>;
  /** `true` cuando el navegador ya está levantado (diagnóstico y pruebas). */
  isRunning: () => boolean;
}

/**
 * El pie de página de Chromium. Solo tiene las clases que inyecta el propio navegador
 * (`pageNumber`/`totalPages`); el resto del estilo va en línea porque la plantilla se carga en un
 * documento aparte, sin nuestras hojas.
 */
const PLANTILLA_FOLIO = `<div style="width:100%;font-size:7.5pt;color:#6b7280;padding:0 12mm;text-align:right;">Página <span class="pageNumber"></span> de <span class="totalPages"></span></div>`;

export const createPdfRenderer = (options: PdfRendererOptions): PdfRenderer => {
  let browser: Browser | null = null;
  /** Cola: encadena un render detrás del otro sin abrir dos páginas a la vez. */
  let cola: Promise<unknown> = Promise.resolve();

  const launch = async (): Promise<Browser> => {
    if (browser !== null && browser.isConnected()) return browser;
    browser = await chromium.launch({
      headless: true,
      // `--no-sandbox` es lo habitual en un servicio que corre como usuario de sistema en Linux.
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
      ...(options.executablePath === undefined ? {} : { executablePath: options.executablePath }),
    });
    return browser;
  };

  const render = (html: string, paper: PdfPageOptions = {}): Promise<Buffer> => {
    const tarea = async (): Promise<Buffer> => {
      const instance = await launch();
      const page = await instance.newPage();
      try {
        page.setDefaultTimeout(options.timeoutMs);
        // Esquema de color EXPLÍCITO: el PDF es papel, no pantalla.
        await page.emulateMedia({ colorScheme: 'light' });
        await page.setContent(html, { waitUntil: 'load', timeout: options.timeoutMs });
        // El evento `load` NO espera a que las `@font-face` se decodifiquen: sin esperar a
        // `document.fonts.ready`, la factura podía salir con la pila de respaldo.
        await page.evaluate(async () => {
          // En la página (Chromium) existe `document.fonts`; el servicio compila sin la lib DOM.
          const fuentes = (globalThis as { document?: { fonts?: { ready?: Promise<unknown> } } })
            .document?.fonts;
          await fuentes?.ready;
        });
        return await page.pdf({
          format: 'Letter',
          landscape: paper.landscape ?? false,
          printBackground: true,
          // Los folios se piden solo para los informes: la factura es de una página (Art. 33).
          displayHeaderFooter: paper.folios === true,
          ...(paper.folios === true
            ? {
                headerTemplate: '<span></span>',
                footerTemplate: PLANTILLA_FOLIO,
                margin: { top: '12mm', bottom: '16mm', left: '12mm', right: '12mm' },
              }
            : {}),
        });
      } finally {
        await page.close().catch(() => undefined);
      }
    };

    const resultado = cola.then(tarea, tarea);
    // La cola no se rompe porque una factura falle: la siguiente vuelve a intentarlo.
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
