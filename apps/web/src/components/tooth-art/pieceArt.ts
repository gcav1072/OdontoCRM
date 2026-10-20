import type { PeriodontalArch, PeriodontalSide } from '@odontocrm/contracts';

/**
 * Piezas ilustradas del periodontograma.
 *
 * Son 64 SVG (16 piezas × 2 caras × 2 arcadas), aportados por el consultorio: un
 * dibujo con volumen por pieza, en la misma orientación que la rejilla (la corona
 * mira siempre a la franja central). Se cargan como **texto** (`?raw`) y se insertan
 * en línea dentro del `<g>` de la pieza, no como `<img>`: así el documento
 * imprimible y el PDF no dependen de que el navegador cargue 64 archivos, y el SVG
 * conserva su escala exacta con la rejilla.
 *
 * Cada archivo mide 63 × 156 en su propio sistema de coordenadas y no está
 * calibrado en milímetros: el contenido de una pieza ocupa una caja distinta según
 * el diente (un canino es más largo que un tercer molar). Por eso cada pieza lleva
 * su **caja vectorial** medida (`PIECE_BOUNDS`), y el componente la estira hasta la
 * longitud y el ancho anatómicos de `toothSilhouetteSpec`.
 */

/** Cara y arcada de una pieza, en la misma nomenclatura que la carpeta de la pieza. */
export type PieceFace =
  'maxilar-vestibular' | 'maxilar-palatino' | 'mandibula-vestibular' | 'mandibula-lingual';

/**
 * Caja del dibujo de cada pieza dentro de su `viewBox` de 63 × 156, medida con
 * `getBBox()` sobre el SVG: `[x, y, ancho, alto]`.
 *
 * Son datos, no una estimación: la calibración del componente depende de ellos. Si
 * se sustituye un archivo por otro dibujo, hay que volver a medirlo.
 */
const PIECE_BOUNDS: Readonly<
  Record<PieceFace, Readonly<Record<string, readonly [number, number, number, number]>>>
> = {
  'maxilar-vestibular': {
    '11': [6.98, 10.97, 49.95, 137.05],
    '12': [12.22, 11.98, 39.44, 129.44],
    '13': [10.04, 2.43, 43.83, 151.45],
    '14': [9.2, 5.32, 43.54, 132.23],
    '15': [9.53, 13.67, 42.79, 124.08],
    '16': [7.52, 27.88, 48.92, 99.51],
    '17': [6.73, 32.43, 50.13, 92.46],
    '18': [7.15, 41.03, 49.66, 82.13],
    '21': [6.95, 11.5, 49.93, 137.4],
    '22': [12.17, 6.78, 39.43, 134.51],
    '23': [10.04, 3.11, 43.79, 150.91],
    '24': [10.18, 5.03, 43.67, 132.66],
    '25': [10.51, 13.21, 42.84, 124.61],
    '26': [7.46, 26.7, 48.83, 101.75],
    '27': [6.97, 30.19, 49.97, 95.15],
    '28': [7.1, 35.72, 49.54, 84.6],
  },
  'maxilar-palatino': {
    '11': [7.04, 8.22, 49.85, 137.62],
    '12': [12.25, 13.12, 39.37, 129.16],
    '13': [10.05, 1.11, 43.83, 151.22],
    '14': [9.2, 17.64, 43.54, 132.36],
    '15': [12.51, 19.69, 42.83, 124.14],
    '16': [7.03, 31.77, 49.79, 95.05],
    '17': [6.88, 31.28, 50.17, 93.04],
    '18': [6.95, 35.91, 49.77, 82.19],
    '21': [7.04, 8.11, 49.87, 137.38],
    '22': [12.11, 12.86, 39.5, 134.4],
    '23': [9.99, 1.66, 43.84, 151.11],
    '24': [10.23, 17.47, 43.65, 132.52],
    '25': [10.5, 19.68, 42.86, 124.25],
    '26': [7.06, 29.69, 49.85, 101.66],
    '27': [6.9, 30.33, 50.13, 97.98],
    '28': [7.1, 34.92, 49.55, 84.38],
  },
  'mandibula-vestibular': {
    '31': [15.61, 10.22, 32.65, 121.36],
    '32': [14.44, 9.01, 34.82, 123.02],
    '33': [12.38, 4.1, 38.91, 132.21],
    '34': [10.43, 13.26, 42.95, 127.67],
    '35': [12.4, 21.24, 38.95, 106.69],
    '36': [6.65, 25.54, 50.61, 95.17],
    '37': [6.75, 25.97, 50.44, 91.49],
    '38': [8.14, 29.21, 47.78, 78.56],
    '41': [15.7, 9.26, 32.61, 121.68],
    '42': [14.51, 9.24, 34.77, 123.15],
    '43': [12.4, 5.33, 38.88, 132.46],
    '44': [10.73, 13.68, 42.5, 126.66],
    '45': [12.44, 22.15, 38.87, 106.41],
    '46': [6.61, 18.05, 50.72, 95.01],
    '47': [6.68, 25.02, 50.45, 91.48],
    '48': [8.01, 28.79, 47.84, 78.12],
  },
  'mandibula-lingual': {
    '31': [15.62, 14.97, 32.65, 121.21],
    '32': [14.37, 14.92, 34.9, 123.03],
    '33': [12.48, 8.67, 38.86, 132.18],
    '34': [10.4, 8.76, 42.89, 127.51],
    '35': [12.45, 17.02, 38.83, 106.41],
    '36': [6.69, 26.24, 50.57, 95.2],
    '37': [6.77, 29.78, 50.4, 91.74],
    '38': [8.18, 42.33, 47.79, 77.95],
    '41': [15.68, 15.1, 32.62, 121.11],
    '42': [14.49, 14.96, 34.78, 122.9],
    '43': [12.44, 8.7, 38.9, 132.34],
    '44': [10.47, 8.81, 42.9, 127.41],
    '45': [12.44, 17.06, 38.89, 106.34],
    '46': [6.67, 26.16, 50.62, 95.29],
    '47': [6.72, 29.91, 50.39, 91.46],
    '48': [8.08, 42.15, 47.78, 78.1],
  },
};

/** Carpeta de piezas según la arcada y la cara. */
export const pieceFaceOf = (arch: PeriodontalArch, side: PeriodontalSide): PieceFace =>
  arch === 'maxilar'
    ? side === 'vestibular'
      ? 'maxilar-vestibular'
      : 'maxilar-palatino'
    : side === 'vestibular'
      ? 'mandibula-vestibular'
      : 'mandibula-lingual';

/** Los 64 archivos, embebidos como texto en el paquete (sin peticiones en tiempo de uso). */
const FILES = import.meta.glob('./pieces/*/*.svg', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

/** Contenido interior de un SVG: el `<svg>` no se anida, se inserta su dibujo. */
const innerOf = (markup: string): string => {
  const inicio = markup.indexOf('>', markup.indexOf('<svg'));
  const fin = markup.lastIndexOf('</svg>');
  if (inicio === -1 || fin === -1) return '';
  return markup.slice(inicio + 1, fin).trim();
};

/** Dibujo de una pieza (`null` si no hay archivo para esa cara y FDI). */
export const pieceMarkup = (face: PieceFace, fdi: number): string | null => {
  const clave = `./pieces/${face}/${String(fdi)}.svg`;
  const archivo = FILES[clave];
  if (archivo === undefined) return null;
  const inner = innerOf(archivo);
  return inner === '' ? null : inner;
};

/** Caja del dibujo (`null` si la pieza no está registrada). */
export const pieceBounds = (
  face: PieceFace,
  fdi: number,
): readonly [number, number, number, number] | null => PIECE_BOUNDS[face][String(fdi)] ?? null;
