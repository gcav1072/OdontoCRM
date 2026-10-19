import {
  PERIODONTAL_CHANGE_COLORS,
  type PeriodontalArch,
  type PeriodontalComparison,
  type PeriodontalSide,
  type PeriodontalSite,
  type PeriodontalSiteChange,
  type PeriodontalSiteDiff,
  type PeriodontalSiteIndex,
} from '@odontocrm/contracts';

/**
 * Geometría del gráfico del periodontograma (SVG). Pura y sin React: las pruebas
 * comprueban que cada sitio cae donde debe y que las líneas de PS/MG se dibujan con
 * la misma convención que usa el dominio para calcular el NIC.
 *
 * Sistema de coordenadas fijo (`viewBox 0 0 640 198`):
 * - 16 columnas de pieza de 40 unidades; los 3 sitios, en `x = columna·40 + [7, 20, 33]`.
 * - Dos bandas por arcada (una por cara) y una franja central con el número FDI. La
 *   banda superior crece hacia arriba (el fondo de la bolsa queda arriba) y la
 *   inferior hacia abajo, así que las dos arcadas se leen «hacia fuera» de la boca.
 * - `LAC` (0 mm) está a `LAC_OFFSET` del borde interior de la banda y cada milímetro
 *   son `MM_UNIT` unidades: MG se dibuja a un lado del LAC y PS al otro, con lo que
 *   el polígono entre las dos curvas **es** el NIC del sitio.
 */

/** Ancho del `viewBox`: 16 piezas × 40 unidades. */
export const ARCH_VIEW_WIDTH = 640;

/** Columnas de pieza que dibuja cada arcada (siempre las 16 permanentes). */
export const ARCH_TOOTH_COUNT = 16;

/** Ancho de una columna de pieza, en unidades del `viewBox`. */
export const TOOTH_COLUMN_WIDTH = ARCH_VIEW_WIDTH / ARCH_TOOTH_COUNT;

/** Posición visual de los 3 sitios dentro de la columna (izquierda, centro, derecha). */
export const SITE_OFFSETS: readonly [number, number, number] = [7, 20, 33];

/** Margen interior de la tarjeta de pieza dentro de su columna de 40 unidades. */
export const TOOTH_CARD_INSET = 3;

/** Alto de cada banda (una cara), en unidades del `viewBox`. */
export const BAND_HEIGHT = 84;

/** Franja central con el número FDI, la movilidad y las furcas. */
export const TOOTH_STRIP_HEIGHT = 30;

/** Alto total del `viewBox` de una arcada. */
export const ARCH_VIEW_HEIGHT = BAND_HEIGHT * 2 + TOOTH_STRIP_HEIGHT;

/** Cuánto se separa el LAC del borde interior de la banda (deja sitio para la MG). */
export const LAC_OFFSET = 38;

/** Milímetros reales que representa una unidad vertical. */
export const MM_UNIT = 2.6;

/** Profundidad máxima que se dibuja (el contrato admite 15 mm). */
export const PD_DRAW_MAX = 15;

/** Cotas milimetradas que se pintan de fondo. */
export const GRID_MM: readonly number[] = [0, 2, 4, 6, 8, 10, 12, 14];

/** Última cota apical de la rejilla (lo que se numera hacia la raíz). */
export const GRID_APICAL_MM = 14;

/**
 * Zona coronal que se sombrea y se guía (MG positiva = hiperplasia). No es el tope
 * dibujable: la banda admite hasta `lacY / MM_UNIT` en el lado coronal, así que un
 * margen mayor sigue dibujándose dentro del gráfico.
 */
export const CORONAL_GUIDE_MM = 4;

/** Guías coronales (+2, +4) que se pintan para leer la hiperplasia. */
export const CORONAL_GRID_MM: readonly number[] = [2, 4];

/** Profundidad (mm) a la que el gráfico pinta la línea de alerta. */
export const ALERT_DEPTH_MM = 4;

/** Colores clínicos del gráfico (los toma también la leyenda y el documento). */
export const PERIODONTAL_COLORS = {
  pd: '#dc2626',
  mg: '#2563eb',
  nic: 'rgba(220, 38, 38, 0.18)',
  bop: '#dc2626',
  plaque: '#0f766e',
  suppuration: '#b45309',
  selection: '#7c3aed',
  tooth: '#475569',
  /** Línea del LAC (0 mm): es la frontera entre raíz y corona, no una cota más. */
  lac: '#475569',
  /** Zona coronal (MG > 0), sombreada para que no parezca fuera del gráfico. */
  coronal: 'rgba(71, 85, 105, 0.06)',
  grid: '#cbd5e1',
  alert: 'rgba(220, 38, 38, 0.35)',
  previous: '#64748b',
} as const;

/** Dirección en la que crece la profundidad dentro de una banda. */
export type BandDirection = 'up' | 'down';

/** Colocación de una banda de cara dentro del `viewBox`. */
export interface BandLayout {
  side: PeriodontalSide;
  direction: BandDirection;
  /** Borde superior de la banda. */
  top: number;
  /** Coordenada Y del LAC (0 mm). */
  lacY: number;
}

/**
 * Orden de las bandas de una arcada. La cara **vestibular** se dibuja hacia fuera:
 * arriba en el maxilar y abajo en la mandíbula, como en un odontograma en cruz.
 */
export const archBandOrder = (arch: PeriodontalArch): readonly PeriodontalSide[] =>
  arch === 'maxilar' ? ['vestibular', 'lingual'] : ['lingual', 'vestibular'];

/** Coordenada Y del LAC de una banda según su dirección. */
const lacYOf = (top: number, direction: BandDirection): number =>
  direction === 'up' ? top + BAND_HEIGHT - LAC_OFFSET : top + LAC_OFFSET;

/** Colocación de las dos bandas de una arcada. */
export const archBands = (arch: PeriodontalArch): readonly BandLayout[] =>
  archBandOrder(arch).map((side, position) => {
    const top = position === 0 ? 0 : BAND_HEIGHT + TOOTH_STRIP_HEIGHT;
    const direction: BandDirection = position === 0 ? 'up' : 'down';
    return { side, direction, top, lacY: lacYOf(top, direction) };
  });

/** Colocación de la banda de una cara concreta. */
export const bandLayout = (arch: PeriodontalArch, side: PeriodontalSide): BandLayout => {
  const bandas = archBands(arch);
  const banda = bandas.find((item) => item.side === side);
  // Las dos caras siempre existen en `archBandOrder`; el respaldo mantiene el tipo
  // sin `!` y sin ramas imposibles.
  return banda ?? { side, direction: 'up', top: 0, lacY: lacYOf(0, 'up') };
};

/** Franja central donde viven el número de pieza, la movilidad y las furcas. */
export const toothStripTop = (): number => BAND_HEIGHT;

/** `x` del sitio dentro del lienzo. */
export const siteX = (toothIndex: number, siteIndex: PeriodontalSiteIndex): number =>
  toothIndex * TOOTH_COLUMN_WIDTH + SITE_OFFSETS[siteIndex];

/** `y` de una cota de milímetros respecto al LAC de la banda. */
export const depthY = (layout: BandLayout, millimeters: number): number =>
  layout.direction === 'up'
    ? layout.lacY - millimeters * MM_UNIT
    : layout.lacY + millimeters * MM_UNIT;

/** Milímetros que caben a cada lado del LAC dentro de una banda. */
export const bandDepthLimits = (layout: BandLayout): { apical: number; coronal: number } => ({
  apical:
    (layout.direction === 'up'
      ? layout.lacY - layout.top
      : layout.top + BAND_HEIGHT - layout.lacY) / MM_UNIT,
  coronal:
    (layout.direction === 'up'
      ? layout.top + BAND_HEIGHT - layout.lacY
      : layout.lacY - layout.top) / MM_UNIT,
});

/**
 * Rectángulo dibujado de la banda: de la cota apical de la rejilla a la guía coronal.
 * Lo usa el cursor para no sobresalir por encima de la rejilla ni colgar por debajo.
 */
export const bandPlotBounds = (layout: BandLayout): { top: number; bottom: number } => {
  const apical = depthY(layout, GRID_APICAL_MM);
  const coronal = depthY(layout, -CORONAL_GUIDE_MM);
  return { top: Math.min(apical, coronal), bottom: Math.max(apical, coronal) };
};

/** Mantiene una profundidad dentro de la banda (evita dibujar fuera de la arcada). */
const clampDrawnDepth = (layout: BandLayout, depth: number): number => {
  const { apical, coronal } = bandDepthLimits(layout);
  return Math.max(-coronal, Math.min(apical, depth));
};

/**
 * Posición de un sitio en el lienzo. El margen se sitúa respecto al LAC: positivo
 * (hiperplasia) hacia la corona y negativo (recesión) hacia el ápice. La PS se mide
 * desde el margen **hacia el ápice**, que es la convención clínica.
 *
 * Devuelve `null` en las coordenadas que no se pueden dibujar: la línea de PS solo
 * existe si el sitio se sondó; la de MG, solo si el margen se registró.
 */
export interface SiteDrawing {
  x: number;
  /** Y del margen gingival (`null` si no se registró). */
  mgY: number | null;
  /** Y del fondo de la bolsa (`null` si el sitio no se sondó). */
  pdY: number | null;
  /** Y del NIC (solo si hay PS). */
  calY: number | null;
  /** NIC del sitio, con la convención del contrato (`MG = 0` si no se registró). */
  cal: number | null;
}

/** Calcula el dibujo de un sitio; `gm` sin dato asume 0 para dibujar, como el NIC. */
export const siteDrawing = (
  layout: BandLayout,
  toothIndex: number,
  siteIndex: PeriodontalSiteIndex,
  site: Pick<PeriodontalSite, 'pd' | 'gm'>,
): SiteDrawing => {
  const x = siteX(toothIndex, siteIndex);
  const gm = site.gm;
  const mgY = gm === null ? null : depthY(layout, clampDrawnDepth(layout, -gm));
  const pdY =
    site.pd === null
      ? null
      : depthY(layout, clampDrawnDepth(layout, Math.min(site.pd, PD_DRAW_MAX) - (gm ?? 0)));
  const cal = site.pd === null ? null : Math.max(0, site.pd - (gm ?? 0));
  return { x, mgY, pdY, cal, calY: cal === null ? null : depthY(layout, cal) };
};

/** Puntos «x,y» de una polilínea SVG; vacío si no hay puntos. */
export const polylinePoints = (points: readonly { x: number; y: number }[]): string =>
  points.map((point) => `${String(point.x)},${String(point.y)}`).join(' ');

/**
 * Puntos del polígono entre la curva de MG y la de PS (el NIC pintado). Se recorre
 * una curva y se vuelve por la otra; con menos de dos puntos por lado no hay área.
 */
export const nicPolygonPoints = (
  mgPoints: readonly { x: number; y: number }[],
  pdPoints: readonly { x: number; y: number }[],
): string | null => {
  if (mgPoints.length < 2 || pdPoints.length < 2) return null;
  return polylinePoints([...mgPoints, ...[...pdPoints].reverse()]);
};

/** Zona táctil de un sitio: franja vertical de ancho `column/3` que cruza la banda. */
export interface SiteHitbox {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Coordenada X del centro del sitio (punto de la curva). */
  centerX: number;
}

/** Rectángulo táctil de un sitio dentro de su banda. */
export const siteHitbox = (
  layout: BandLayout,
  toothIndex: number,
  siteIndex: PeriodontalSiteIndex,
): SiteHitbox => {
  const width = TOOTH_COLUMN_WIDTH / 3;
  const x = toothIndex * TOOTH_COLUMN_WIDTH + siteIndex * width;
  return {
    x,
    y: layout.top + 2,
    width,
    height: BAND_HEIGHT - 4,
    centerX: siteX(toothIndex, siteIndex),
  };
};

/**
 * Marco del sitio activo: centrado en el punto del sitio y **recortado a la tarjeta
 * de la pieza** (la tarjeta va de +3 a +37 y la zona táctil cubre los 40 de la
 * columna, así que sin recortar el marco se salía de la tarjeta en DV y MV).
 */
export const siteCursorBox = (
  layout: BandLayout,
  toothIndex: number,
  siteIndex: PeriodontalSiteIndex,
): { x: number; width: number; top: number; height: number } => {
  const cardLeft = toothIndex * TOOTH_COLUMN_WIDTH + TOOTH_CARD_INSET;
  const cardRight = (toothIndex + 1) * TOOTH_COLUMN_WIDTH - TOOTH_CARD_INSET;
  const center = siteX(toothIndex, siteIndex);
  const half = (TOOTH_COLUMN_WIDTH / 3 - 2) / 2;
  const left = Math.max(cardLeft, center - half);
  const right = Math.min(cardRight, center + half);
  const bounds = bandPlotBounds(layout);
  return { x: left, width: right - left, top: bounds.top, height: bounds.bottom - bounds.top };
};

/* ── Comparación longitudinal sobre el gráfico ─────────────────────────────── */

/** Clave estable de un sitio para cruzar el gráfico, la tabla y la comparación. */
export const comparisonSiteKey = (
  fdi: number,
  side: PeriodontalSide,
  index: PeriodontalSiteIndex,
): string => `${String(fdi)}:${side}:${String(index)}`;

/** Índice de la comparación por sitio, para no recorrer el arreglo en cada píxel. */
export const comparisonSiteIndex = (
  comparison: PeriodontalComparison | null | undefined,
): ReadonlyMap<string, PeriodontalSiteDiff> => {
  const index = new Map<string, PeriodontalSiteDiff>();
  if (comparison === null || comparison === undefined) return index;
  for (const diff of comparison.sites) {
    index.set(comparisonSiteKey(diff.fdi, diff.side, diff.index), diff);
  }
  return index;
};

/** Diferencia de un sitio concreto en la comparación, si existe. */
export const comparisonSiteOf = (
  index: ReadonlyMap<string, PeriodontalSiteDiff>,
  fdi: number,
  side: PeriodontalSide,
  siteIndex: PeriodontalSiteIndex,
): PeriodontalSiteDiff | null => index.get(comparisonSiteKey(fdi, side, siteIndex)) ?? null;

/** Color del cambio de un sitio (los mismos del contrato, accesibles por tono y forma). */
export const changeColor = (change: PeriodontalSiteChange): string =>
  PERIODONTAL_CHANGE_COLORS[change];

/**
 * Puntos de la polilínea del examen **anterior** para superponerla en el gráfico:
 * solo los sitios con PS medida del examen previo.
 */
export const previousPdPoints = (
  layout: BandLayout,
  toothIndex: number,
  previousSites: readonly (Pick<PeriodontalSite, 'pd' | 'gm'> | null)[],
): { x: number; y: number }[] => {
  const points: { x: number; y: number }[] = [];
  for (const siteIndex of [0, 1, 2] as const) {
    const site = previousSites[siteIndex];
    if (site === null || site === undefined || site.pd === null) continue;
    points.push({
      x: siteX(toothIndex, siteIndex),
      y: depthY(layout, Math.min(site.pd, PD_DRAW_MAX) - (site.gm ?? 0)),
    });
  }
  return points;
};
