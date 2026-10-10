import { chromium, type Browser } from 'playwright';

/**
 * El PDF del récipe, con Chromium ([ADR 0015](../../../docs/adr/0015-recipe-a5-en-pdf.md)).
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

/** Márgenes del papel, en milímetros, cuando los fija el PDF y no la plantilla. */
export interface PdfMarginMm {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/**
 * Cómo se compone el papel.
 *
 * El **récipe** va en **carta apaisada** con `landscape: true`: su `@page` ya lleva el
 * tamaño y los márgenes, y esa es la firma que ya usaban las pruebas. El **dossier**
 * necesita A4, folio en cada página y márgenes que Chromium respete para dejar sitio al
 * folio —y el folio solo existe si el propio PDF lo dibuja (`displayHeaderFooter`);
 * Chromium no soporta `counter(page)` en los márgenes de `@page`, así que no hay forma
 * de hacerlo con CSS.
 */
export interface PdfRenderOptions {
  format?: 'A5' | 'A4' | 'Letter';
  /** `true` gira la hoja (el récipe sale apaisado). */
  landscape?: boolean;
  /** Pie repetido en cada página (HTML; admite `class="pageNumber"` y `"totalPages"`). */
  footerHtml?: string;
  marginMm?: PdfMarginMm;
}

export interface PdfRenderer {
  /** HTML → PDF (A5 por defecto; el récipe pide carta apaisada y el dossier A4 con folio). */
  render: (html: string, options?: PdfRenderOptions) => Promise<Buffer>;
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

  const render = (html: string, opciones?: PdfRenderOptions): Promise<Buffer> => {
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
        // El récipe va en **carta apaisada** (`landscape: true`) con los márgenes de su
        // `@page`. El dossier pide A4 y márgenes explícitos (para que quepa el folio del
        // pie).
        const margen = opciones?.marginMm;
        return await page.pdf({
          format: opciones?.format ?? 'A5',
          landscape: opciones?.landscape ?? false,
          printBackground: true,
          ...(margen === undefined
            ? {}
            : {
                margin: {
                  top: `${String(margen.top)}mm`,
                  bottom: `${String(margen.bottom)}mm`,
                  left: `${String(margen.left)}mm`,
                  right: `${String(margen.right)}mm`,
                },
              }),
          ...(opciones?.footerHtml === undefined
            ? {}
            : {
                displayHeaderFooter: true,
                headerTemplate: '<span></span>',
                footerTemplate: opciones.footerHtml,
              }),
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
