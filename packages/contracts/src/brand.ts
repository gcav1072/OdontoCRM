/**
 * Identidad de **marca** del consultorio: la única fuente de la paleta, las
 * tipografías y el logo que comparten la interfaz y los documentos impresos
 * (récipe A5, reporte A4, dossier del expediente, factura y recibo).
 *
 * **¿Por qué aquí y no en un CSS suelto?** Porque hay **dos** consumidores que no
 * comparten forma de cargar hojas de estilo:
 *  - la **SPA** importa un `.css` (`packages/ui/src/styles/marca.css`, generado
 *    desde este archivo con `npm run marca:css`);
 *  - las **plantillas HTML del servidor** (récipe, reporte, dossier, factura) se
 *    arman en Node y se le pasan a Chromium como cadena: no pueden `@import` un
 *    archivo del repositorio, así que incrustan `brandStyles()` en su `<style>`.
 *
 * Con los valores en TypeScript, los dos salen del **mismo** sitio: cambiar el
 * color de los títulos aquí y regenerar `marca.css` los mueve en pantalla y en
 * papel a la vez. Si vivieran sueltos, el membrete del PDF y la interfaz
 * acabarían con dos paletas a la primera de cambio.
 *
 * **Qué NO es.** No es el tema de la interfaz (`packages/ui/src/styles/tokens.css`):
 * aquel son los tokens de Tailwind para el *cromo* de la aplicación (fondos,
 * botones, estados, tema claro/oscuro). Este es la identidad **impresa** y de
 * membrete, que siempre va sobre papel blanco —por eso no tiene variante oscura—.
 * Los pocos nombres que coinciden (color del texto, tipografía base) se declaran
 * también aquí porque el papel no puede depender del tema del navegador.
 */

/** Familias tipográficas y tamaños base de los documentos impresos (en pt). */
export interface BrandTypography {
  /** Pila de la interfaz en pantalla. La misma que `--font-sans` de los tokens. */
  uiSans: string;
  /** Pila monoespaciada (códigos, números de documento). */
  uiMono: string;
  /** Pila de los documentos del servidor (récipe, reporte, dossier, factura). */
  documentSans: string;
  /** Cuerpo del documento; «13pt» es el título y «7,5pt» lo menudo (pie, notas). */
  documentTitlePt: number;
  documentBodyPt: number;
  documentSmallPt: number;
}

/** Colores de la marca sobre papel (una sola variante: el papel no es oscuro). */
export interface BrandPalette {
  /** Color principal: títulos, encabezados de documento. */
  primary: string;
  /** Texto sobre `primary` (rellenos sólidos). */
  primaryInk: string;
  /** Acento: reglas finas y subrayados del membrete. */
  accent: string;
  /** Texto de cuerpo. */
  ink: string;
  /** Texto de detalle (el «dato secundario» de una fila). */
  inkStrong: string;
  /** Texto secundario: direcciones, metadatos del documento. */
  inkMuted: string;
  /** Texto menudo: notas al pie, pistas. */
  inkSubtle: string;
  /** Borde de tabla y separadores. */
  line: string;
  /** Línea suave entre filas. */
  lineSoft: string;
  /** Fondo de los encabezados de tabla. */
  tableHeadBg: string;
  /** Semánticos del papel (tonos apagados, legibles impresos). */
  good: string;
  warn: string;
  bad: string;
}

/** Medidas del membrete y la marca de agua. */
export interface BrandLetterhead {
  /** Alto del logo en el membrete (mm). */
  logoHeightMm: number;
  /** Ancho de la marca de agua centrada (mm). */
  watermarkWidthMm: number;
  /** Opacidad de la marca de agua (0–1): tiene que leerse el documento detrás. */
  watermarkOpacity: number;
}

export interface Brand {
  palette: BrandPalette;
  typography: BrandTypography;
  letterhead: BrandLetterhead;
  /**
   * Logo del membrete: ruta **relativa a la raíz del repositorio**. Si el archivo
   * no existe, el membrete sale sin logo (y `letterheadMissingFields` avisa).
   */
  logoPath: string;
  /** Marca de agua de los imprimibles; casi siempre el mismo logo. */
  watermarkPath: string;
}

/* ══════════════════════════════════════════════════════════════════════════════
   ▼▼▼  EDITA AQUÍ  ▼▼▼  Tras cambiarlo: `npm run marca:css`.
   ══════════════════════════════════════════════════════════════════════════════ */

export const BRAND: Brand = {
  palette: {
    primary: '#14504d',
    primaryInk: '#ffffff',
    accent: '#1f6f6b',
    ink: '#17202a',
    inkStrong: '#46535f',
    inkMuted: '#4a5560',
    inkSubtle: '#6b7680',
    line: '#cfdedd',
    lineSoft: '#e3e9ea',
    tableHeadBg: '#eef5f4',
    good: '#14663f',
    warn: '#8a5a00',
    bad: '#97231f',
  },
  typography: {
    uiSans:
      "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Noto Sans', sans-serif",
    uiMono: "ui-monospace, 'Cascadia Mono', Consolas, 'Liberation Mono', monospace",
    documentSans: "'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
    documentTitlePt: 13,
    documentBodyPt: 9,
    documentSmallPt: 7.5,
  },
  letterhead: {
    logoHeightMm: 18,
    watermarkWidthMm: 90,
    /** Opacidad de la marca de agua (0.1 es un velo suave que deja leer el texto encima). */
    watermarkOpacity: 0.1,
  },
  logoPath: 'assets/clinic/logo.svg',
  watermarkPath: 'assets/clinic/logo.svg',
};

/* ══════════════════════════════════════════════════════════════════════════════
   ▲▲▲  FIN DE LA SECCIÓN EDITABLE  ▲▲▲  Debajo solo hay ayudas de lectura.
   ══════════════════════════════════════════════════════════════════════════════ */

/** Extensiones que el membrete sabe incrustar como data URI y su tipo MIME. */
const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

/**
 * Tipo MIME de una imagen por su extensión.
 *
 * Lo usan las plantillas para incrustar el logo como `data:` URI (el PDF no
 * depende de rutas al abrirse). Un `.svg` sale como `image/svg+xml`; lo que no
 * se reconoce cae en `image/png`, que es lo que había antes de soportar SVG.
 */
export const logoMimeType = (path: string): string => {
  const extension = /\.(?<ext>[A-Za-z0-9]{2,5})$/.exec(path.trim())?.groups?.['ext'];
  return (
    (extension === undefined ? undefined : MIME_BY_EXTENSION[extension.toLowerCase()]) ??
    'image/png'
  );
};

/**
 * Variables CSS de marca (`--brand-*`), una por línea y ya indentadas.
 *
 * Es el cuerpo de un bloque `:root { … }`: lo envuelve `brandRootBlock()` para
 * los documentos y lo escribe tal cual el generador de `marca.css`.
 */
export const brandCssVariables = (brand: Brand = BRAND): string => {
  const { palette, typography, letterhead } = brand;
  const variables: [string, string | number][] = [
    ['primary', palette.primary],
    ['primary-ink', palette.primaryInk],
    ['accent', palette.accent],
    ['ink', palette.ink],
    ['ink-strong', palette.inkStrong],
    ['ink-muted', palette.inkMuted],
    ['ink-subtle', palette.inkSubtle],
    ['line', palette.line],
    ['line-soft', palette.lineSoft],
    ['table-head-bg', palette.tableHeadBg],
    ['good', palette.good],
    ['warn', palette.warn],
    ['bad', palette.bad],
    ['font-ui', typography.uiSans],
    ['font-ui-mono', typography.uiMono],
    ['font-doc', typography.documentSans],
    ['doc-title-pt', `${String(typography.documentTitlePt)}pt`],
    ['doc-body-pt', `${String(typography.documentBodyPt)}pt`],
    ['doc-small-pt', `${String(typography.documentSmallPt)}pt`],
    ['logo-height-mm', `${String(letterhead.logoHeightMm)}mm`],
    ['watermark-width-mm', `${String(letterhead.watermarkWidthMm)}mm`],
    ['watermark-opacity', String(letterhead.watermarkOpacity)],
  ];

  return variables.map(([nombre, valor]) => `  --brand-${nombre}: ${String(valor)};`).join('\n');
};

/** El bloque `:root { … }` completo, listo para incrustar en un `<style>`. */
export const brandRootBlock = (brand: Brand = BRAND): string =>
  `:root {\n${brandCssVariables(brand)}\n}`;

/**
 * Estilos base de los documentos del servidor: las variables de marca y el
 * `body` que las usa. Las plantillas lo incrustan al principio de su `<style>` y
 * después declaran sus clases, que pueden leer `var(--brand-*)`.
 *
 * El margen del papel (`@page`) **no** va aquí: lo decide cada plantilla (A5 el
 * récipe, A4 el reporte y el dossier) y `var()` dentro de un descriptor de
 * `@page` no es fiable en Chromium.
 */
export const brandStyles = (brand: Brand = BRAND): string =>
  `${brandRootBlock(brand)}

body {
  font-family: var(--brand-font-doc);
  color: var(--brand-ink);
  margin: 0;
}

/* Fuente única de las líneas de tabla: th y td comparten separador. */
.brand-table-head {
  background: var(--brand-table-head-bg);
  color: var(--brand-primary);
}`;

/**
 * CSS de la **marca de agua**: el logo del consultorio, centrado y translúcido,
 * detrás del contenido del documento.
 *
 * `position: fixed` es lo que hace que la marca **se repita en todas las hojas**:
 * Chromium la vuelve a pintar en cada página al convertir el HTML en PDF, y el
 * navegador hace lo mismo al imprimir. Las medidas salen de la marca
 * (`--brand-watermark-width-mm` y `--brand-watermark-opacity`), así que se cambian
 * en `brand.ts` y se mueven en papel.
 *
 * El contenido del documento tiene que ir dentro de un contenedor `.brand-doc`
 * (`position: relative; z-index: 1`) para quedar **encima** del velo; sin él, la
 * marca de agua taparía el texto.
 */
export const brandWatermarkCss = (): string => `
.brand-watermark {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: var(--brand-watermark-width-mm);
  max-height: 82%;
  opacity: var(--brand-watermark-opacity);
  z-index: 0;
  pointer-events: none;
}
.brand-doc {
  position: relative;
  z-index: 1;
}`;

/**
 * La marca de agua como `<img>`, lista para poner al principio del `<body>`, o
 * **cadena vacía** si no hay logo que poner (el documento sale sin marca de agua,
 * igual que sale sin logo si falta el archivo).
 *
 * La imagen va ya como `data:` URI: un documento compuesto a PDF no puede depender
 * de una ruta del sistema al abrirse.
 */
export const brandWatermarkHtml = (dataUri: string | null): string =>
  dataUri === null || dataUri.trim() === ''
    ? ''
    : `<img class="brand-watermark" src="${dataUri}" alt="" aria-hidden="true">`;
