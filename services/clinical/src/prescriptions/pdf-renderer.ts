import { chromium, type Browser, type Page } from 'playwright';

import { MIN_FIT_SCALE, fitToAvailable, mmToPx } from './fit-to-page.js';

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
 * **Encaje a una sola hoja.** El bloque `selector` se mide dentro del navegador con la
 * escala en 1 y, si no cabe en el alto útil de la hoja, se reduce la escala escrita en la
 * variable CSS `scaleVariable` hasta que cabe. Es lo que garantiza que el récipe salga en
 * **una hoja** —sin la segunda hoja en blanco que deja el desborde— mida lo que mida el
 * membrete o traiga los medicamentos que traiga, y sin encoger la letra más de lo justo
 * ([ADR 0065](../../../docs/adr/0065-el-recipe-cabe-en-el-papel-de-la-clinica.md)).
 *
 * La escala **nunca** sube de 1 (no agranda un récipe corto) ni baja de `minScale`.
 */
export interface PdfFitToPage {
  /** Selector del bloque que tiene que caber en la hoja (el `.sheet` del récipe). */
  selector: string;
  /** Variable CSS de la escala, sin los guiones (`rx-fit`); se escribe en `<html>`. */
  scaleVariable: string;
  /** Alto útil de la hoja, en milímetros: el del papel menos sus márgenes. */
  availableHeightMm: number;
  /**
   * Ancho útil de la hoja, en milímetros (el del papel menos sus márgenes). Se usa para
   * **medir con el ancho del papel**: el navegador mide contra su ventana, y en una
   * ventana más ancha que la hoja el texto se pliega en menos renglones.
   */
  availableWidthMm: number;
  /** Tope inferior de la escala; por defecto `MIN_FIT_SCALE`. */
  minScale?: number | undefined;  /**
   * Hojas máximas que admite el documento; por defecto **1**. Tras medir, el encaje se
   * **comprueba** contando las hojas del PDF ya compuesto: si el documento se pasa (una
   * marca —membrete o velo— más alta, por ejemplo), se aprieta la escala y se vuelve a
   * componer. Es el blindaje contra la segunda hoja. `0` desactiva la comprobación.
   */
  maxPages?: number | undefined;}

/**
 * Cómo se compone el papel.
 *
 * El **récipe** va **apaisado** (`landscape: true`): su `@page` lleva el tamaño del papel
 * que elige la marca y sus márgenes. El **dossier** necesita carta, folio en cada página y
 * márgenes que Chromium respete para dejar sitio al folio —y el folio solo existe si el
 * propio PDF lo dibuja (`displayHeaderFooter`); Chromium no soporta `counter(page)` en los
 * márgenes de `@page`, así que no hay forma de hacerlo con CSS.
 */
export interface PdfRenderOptions {
  format?: 'A5' | 'A4' | 'Letter';
  /** `true` gira la hoja (el récipe sale apaisado). */
  landscape?: boolean;
  /** Pie repetido en cada página (HTML; admite `class="pageNumber"` y `"totalPages"`). */
  footerHtml?: string;
  marginMm?: PdfMarginMm;
  /** Encaje medido a una sola hoja (el récipe lo pide). */
  fitToPage?: PdfFitToPage;
}

export interface PdfRenderer {
  /** HTML → PDF (A5 por defecto; el récipe pide su papel apaisado y el dossier carta con folio). */
  render: (html: string, options?: PdfRenderOptions) => Promise<Buffer>;
  /** Cierra el navegador (lo llama el apagado del servicio). */
  close: () => Promise<void>;
  /** `true` cuando el navegador ya está levantado (diagnóstico y pruebas). */
  isRunning: () => boolean;
}

/** Lo mínimo del DOM que necesita el encaje: el servicio compila sin la librería DOM. */
interface EncajeDom {
  documentElement: { style: { setProperty: (nombre: string, valor: string) => void } };
  querySelector: (selector: string) => { getBoundingClientRect: () => { height: number } } | null;
}

/**
 * Cuenta las hojas de un PDF (`/Type /Page`; `/Type /Pages` es el nodo raíz del árbol).
 * Es la comprobación **real**: lo que el navegador paginó, no lo que la caja midió.
 */
const countPdfPages = (pdf: Buffer): number =>
  (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;

/** Intentos del blindaje de una sola hoja: aprieta la escala y vuelve a componer. */
const MAX_FIT_ATTEMPTS = 6;

/** Cuánto se aprieta la escala en cada intento (un pelo menos para no oscilar). */
const FIT_STEP = 0.94;

/** El alto (px) del bloque que tiene que caber; `0` si la plantilla no lo trae. */
const medirBloque = async (page: Page, selector: string): Promise<number> =>
  await page.evaluate((sel) => {
    const doc = (globalThis as { document?: EncajeDom }).document;
    return doc?.querySelector(sel)?.getBoundingClientRect().height ?? 0;
  }, selector);

/** Escribe la escala en `<html>`: los `calc()` del documento la leen por herencia. */
const aplicarEscala = async (page: Page, variable: string, escala: number): Promise<void> => {
  await page.evaluate(
    ({ nombre, valor }) => {
      const doc = (globalThis as { document?: EncajeDom }).document;
      doc?.documentElement.style.setProperty(`--${nombre}`, String(valor));
    },
    { nombre: variable, valor: escala },
  );
};

/**
 * Deja el documento **encajado en la hoja**: pone la ventana con el tamaño del área
 * imprimible (para medir con el **ancho del papel**, que es como pagina el PDF), mide el
 * bloque con la escala en 1, calcula la escala que lo hace caber (nunca agranda) y la
 * comprueba midiendo otra vez. Devuelve la escala que dejó aplicada, para que quien llame
 * pueda apretarla si la comprobación real de hojas (en {@link createPdfRenderer}) no bastó.
 */
const encajarEnLaHoja = async (page: Page, fit: PdfFitToPage): Promise<number> => {
  // Sin esto la medida sale **corta**: el navegador mide contra su ventana (1 280 px, más
  // ancha que el papel) y el texto se pliega en menos renglones de los que tendrá en el
  // PDF, así que la hoja «cabía» en la cuenta y seguía partiéndose al imprimir.
  await page.setViewportSize({
    width: Math.floor(mmToPx(fit.availableWidthMm)),
    height: Math.floor(mmToPx(fit.availableHeightMm)),
  });
  await aplicarEscala(page, fit.scaleVariable, 1);
  const requerido = await medirBloque(page, fit.selector);
  const escala = await fitToAvailable(
    async (valor) => {
      await aplicarEscala(page, fit.scaleVariable, valor);
      return await medirBloque(page, fit.selector);
    },
    requerido,
    mmToPx(fit.availableHeightMm),
    fit.minScale ?? MIN_FIT_SCALE,
  );
  await aplicarEscala(page, fit.scaleVariable, escala);
  return escala;
};

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
        // El evento `load` NO espera a que las `@font-face` se decodifiquen: sin esperar a
        // `document.fonts.ready`, un récipe podía salir con la pila de respaldo (sans del
        // sistema) si la fuente aún no había resuelto —el membrete con la letra equivocada—.
        await page.evaluate(async () => {
          // En la página (Chromium) existe `document.fonts`; el servicio compila sin la lib DOM.
          const fuentes = (globalThis as { document?: { fonts?: { ready?: Promise<unknown> } } })
            .document?.fonts;
          await fuentes?.ready;
        });
        // El encaje se mide **después** de las fuentes: la misma tipografía con la que se
        // va a componer el PDF es la que decide cuánto ocupa el documento.
        const fit = opciones?.fitToPage;
        // El récipe va en **carta apaisada** (`landscape: true`) con los márgenes de su
        // `@page`. El dossier pide carta y márgenes explícitos (para que quepa el folio del
        // pie).
        const margen = opciones?.marginMm;
        const parametros = {
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
        } satisfies Parameters<Page['pdf']>[0];

        // Sin encaje, una sola composición: los demás documentos (dossier, cobros) no pagan
        // ni la medición ni la comprobación.
        if (fit === undefined) return await page.pdf(parametros);

        const escalaMedida = await encajarEnLaHoja(page, fit);
        let pdf = await page.pdf(parametros);

        // **Blindaje**: la medida del navegador es una estimación —mide cajas, y Chromium
        // pagina el flujo (una marca con `transform`, un elemento fuera de flujo, un
        // membrete alto…)—. Lo que de verdad decide las hojas es el PDF compuesto, así que
        // se **cuenta** y, si se pasa de `maxPages`, se aprieta la escala y se recompone
        // hasta que quepa o hasta el tope de legibilidad. Así una marca modificada no puede
        // dejar una segunda hoja.
        let escala = escalaMedida;
        const maxPaginas = fit.maxPages ?? 1;
        const minimo = fit.minScale ?? MIN_FIT_SCALE;
        for (
          let intento = 0;
          intento < MAX_FIT_ATTEMPTS && maxPaginas > 0 && countPdfPages(pdf) > maxPaginas;
          intento += 1
        ) {
          if (escala <= minimo) break;
          escala = Math.max(minimo, escala * FIT_STEP);
          await aplicarEscala(page, fit.scaleVariable, escala);
          pdf = await page.pdf(parametros);
        }
        return pdf;
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
