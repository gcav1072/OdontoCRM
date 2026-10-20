import type { PeriodontalArch, PeriodontalSide, PeriodontalTooth } from '@odontocrm/contracts';
import { memo } from 'react';

import { archBands, depthY, MM_UNIT, TOOTH_COLUMN_WIDTH, type BandLayout } from './geometry';
import { pieceBounds, pieceFaceOf, pieceMarkup } from '../tooth-art/pieceArt';

/**
 * Pieza del periodontograma: el dibujo ilustrado que va **detrás** de la rejilla.
 *
 * Cada pieza usa el SVG del consultorio (`pieces/<cara>/<FDI>.svg`) y lo calibra
 * contra la rejilla con la misma `depthY(mm)` que las curvas de PS/MG, así que una
 * bolsa de 8 mm sombrea dos tercios de la raíz dibujada. La calibración es por
 * archivo, no global: los dibujos no comparten escala (un canino ocupa 151 unidades
 * de alto y un tercer molar 78), de modo que cada uno se estira hasta la longitud
 * radicular y la corona anatómicas de su arquetipo, y hasta el ancho que le deja la
 * columna. Es el único modo de que la pieza quede alineada al milímetro.
 *
 * El implante no tiene ilustración en el juego, así que se dibuja con el mismo
 * esquema paramétrico de siempre (tornillo roscado). La pieza ausente no dibuja
 * nada: la columna vacía ya dice que falta el diente.
 */

/* ── Arquetipos ────────────────────────────────────────────────────────────── */

/** Silueta que corresponde a una pieza, según arcada, cara e implante. */
export type ToothSilhouetteKind =
  'single' | 'molar-lower' | 'molar-upper' | 'molar-upper-palatal' | 'implant';

/** Medidas con las que se calibra el dibujo, en milímetros clínicos. */
export interface ToothSilhouetteSpec {
  kind: ToothSilhouetteKind;
  /**
   * Semiancho máximo de la corona, en milímetros. El dibujo se estira a `2 ×` esta
   * medida: es el ancho que ocupa la pieza dentro de la columna de 40 unidades.
   */
  halfWidth: number;
  /**
   * Altura de la corona clínica desde el LAC, en milímetros. Es la proporción que
   * hace que la pieza se lea como un diente y no como un pincho: la corona ocupa
   * alrededor de un tercio de la altura total, como en la boca.
   */
  crownDepthMm: number;
  /** Longitud de la raíz principal desde el LAC, en milímetros. */
  rootDepthMm: number;
}

/** Semiancho de la corona de un molar: 5,2 mm, el mayor de la arcada. */
const MOLAR_HALF_WIDTH = 5.2;

/**
 * Arquetipo de una pieza. El molar superior palatino solo existe en la cara interna
 * del maxilar: `PeriodontalSide` llama `lingual` a esa cara, pero la etiqueta del
 * gráfico es PALATINO. La mandíbula nunca usa ese arquetipo.
 */
export const toothSilhouetteSpec = (
  fdi: number,
  arch: PeriodontalArch,
  side: PeriodontalSide,
  implant = false,
): ToothSilhouetteSpec => {
  if (implant) {
    return { kind: 'implant', halfWidth: 6, crownDepthMm: 0.8, rootDepthMm: 10 };
  }

  const posicion = fdi % 10;
  if (posicion >= 6) {
    if (arch === 'mandibula') {
      return {
        kind: 'molar-lower',
        halfWidth: MOLAR_HALF_WIDTH,
        crownDepthMm: 6.6,
        rootDepthMm: 12,
      };
    }
    return side === 'lingual'
      ? {
          kind: 'molar-upper-palatal',
          halfWidth: MOLAR_HALF_WIDTH,
          crownDepthMm: 6.6,
          rootDepthMm: 14,
        }
      : { kind: 'molar-upper', halfWidth: MOLAR_HALF_WIDTH, crownDepthMm: 6.6, rootDepthMm: 12 };
  }

  // Incisivos (1, 2), canino (3) y premolares (4, 5). El canino es el más largo de
  // la boca y el incisivo el más estrecho; el gráfico lo enseña sin leer una cifra.
  if (posicion === 3) {
    return { kind: 'single', halfWidth: 3.8, crownDepthMm: 8.4, rootDepthMm: 14 };
  }
  if (posicion <= 2) {
    return { kind: 'single', halfWidth: 4.2, crownDepthMm: 7.4, rootDepthMm: 12 };
  }
  return { kind: 'single', halfWidth: 3.6, crownDepthMm: 6.9, rootDepthMm: 12 };
};

/* ── Tonos ─────────────────────────────────────────────────────────────────── */

/** Colores del implante y opacidad del dibujo. Van en atributos SVG, no en CSS. */
export interface ToothSilhouetteTones {
  variant: 'light' | 'paper' | 'dark';
  /** Opacidad del grupo: evita que el dibujo compita con la rejilla y con PS/MG. */
  opacity: number;
  implant: string;
  implantLine: string;
  /** Reflejo de las roscas del implante. */
  highlight: string;
}

/**
 * Tonos por soporte. Los dibujos traen sus propios grises, así que aquí solo se
 * ajusta la opacidad: en pantalla clara se bajan bastante para que la rejilla y las
 * curvas de PS/MG manden; en papel también se atenúan un poco, porque el dibujo es
 * una referencia anatómica y no el dato del examen; en oscuro se bajan aún más para
 * que los claros del dibujo no deslumbren. Los tres valores son el mando único: si
 * hay que subir o bajar las piezas, se toca solo aquí.
 */
const PAPER_TONES: ToothSilhouetteTones = {
  variant: 'paper',
  opacity: 0.85,
  implant: '#e2e8f0',
  implantLine: '#94a3b8',
  highlight: '#ffffff',
};

const LIGHT_TONES: ToothSilhouetteTones = {
  variant: 'light',
  opacity: 0.62,
  implant: '#cbd5e1',
  implantLine: '#64748b',
  highlight: '#ffffff',
};

const DARK_TONES: ToothSilhouetteTones = {
  variant: 'dark',
  opacity: 0.45,
  implant: '#334155',
  implantLine: '#94a3b8',
  highlight: '#cbd5e1',
};

/** Tonos según el soporte: el papel siempre es claro, aunque la pantalla esté en oscuro. */
export const toothSilhouetteTones = (paper: boolean, dark: boolean): ToothSilhouetteTones =>
  paper ? PAPER_TONES : dark ? DARK_TONES : LIGHT_TONES;

/* ── Calibración ───────────────────────────────────────────────────────────── */

/** Redondeo corto: los caminos del SVG no necesitan más de dos decimales. */
const n = (value: number): string => String(Math.round(value * 100) / 100);

/**
 * Calibración del dibujo a la columna. Devuelve los factores y el desplazamiento
 * (en unidades del `viewBox`) con los que se compone el `transform`.
 *
 * El borde "de la corona" en el archivo depende de la orientación de la banda: en
 * las bandas que crecen hacia arriba la corona está abajo y la raíz arriba, y al
 * revés en las que crecen hacia abajo (la corona mira siempre a la franja central).
 * En la rejilla, en cambio, el lado coronal es siempre el de los milímetros
 * **negativos**: `depthY(layout, -mm)` es la corona y `depthY(layout, +mm)` la raíz.
 */
export interface PieceCalibration {
  scaleX: number;
  scaleY: number;
  /** Traslación final hasta el centro de la columna y el borde coronal. */
  tx: number;
  ty: number;
  /** Centro X del dibujo y borde coronal, en el sistema del archivo. */
  sourceCenterX: number;
  sourceCrownY: number;
}

export const pieceCalibration = (
  layout: BandLayout,
  xCenter: number,
  spec: ToothSilhouetteSpec,
  bounds: readonly [number, number, number, number],
): PieceCalibration => {
  const [bx, by, bw, bh] = bounds;
  const crownAtTop = layout.direction === 'down';
  const sourceCrownY = crownAtTop ? by : by + bh;
  const sourceApexY = crownAtTop ? by + bh : by;
  const targetCrownY = depthY(layout, -spec.crownDepthMm);
  const targetApexY = depthY(layout, spec.rootDepthMm);
  return {
    scaleX: (2 * spec.halfWidth * MM_UNIT) / bw,
    scaleY: (targetApexY - targetCrownY) / (sourceApexY - sourceCrownY),
    tx: xCenter,
    ty: targetCrownY,
    sourceCenterX: bx + bw / 2,
    sourceCrownY,
  };
};

/** `transform` que lleva el dibujo de su caja original (63 × 156) a la columna. */
export const pieceTransform = (
  layout: BandLayout,
  xCenter: number,
  spec: ToothSilhouetteSpec,
  bounds: readonly [number, number, number, number],
): string => {
  const { scaleX, scaleY, tx, ty, sourceCenterX, sourceCrownY } = pieceCalibration(
    layout,
    xCenter,
    spec,
    bounds,
  );
  return [
    `translate(${n(tx)} ${n(ty)})`,
    `scale(${n(scaleX)} ${n(scaleY)})`,
    `translate(${n(-sourceCenterX)} ${n(-sourceCrownY)})`,
  ].join(' ');
};

/* ── Dibujo ────────────────────────────────────────────────────────────────── */

interface ToothSilhouetteProps {
  fdi: number;
  /** Posición visual de la pieza dentro de su arcada (0..15). */
  toothIndex: number;
  arch: PeriodontalArch;
  layout: BandLayout;
  missing: boolean;
  implant: boolean;
  tones: ToothSilhouetteTones;
}

/** Semiancho del cuerpo del implante a una profundidad dada (se afila hacia el ápice). */
const implantHalfAt = (mm: number): number => {
  const t = Math.min(1, Math.max(0, (mm - 0.8) / 8.4));
  return 5.8 - 1.2 * t;
};

/** Milímetros de las roscas del implante. */
const IMPLANT_THREADS: readonly number[] = [1.3, 2.35, 3.4, 4.45, 5.5, 6.55, 7.6, 8.65];

/** Tornillo del implante: plataforma, cuerpo que se afila y roscas en relieve. */
const ImplantScrew = ({
  x,
  y,
  tones,
}: {
  x: number;
  y: (mm: number) => number;
  tones: ToothSilhouetteTones;
}) => (
  <>
    <rect
      x={n(x - 6.4)}
      y={n(Math.min(y(-0.4), y(0.55)))}
      width={12.8}
      height={n(Math.abs(y(0.55) - y(-0.4)))}
      rx={0.9}
      fill={tones.implant}
    />
    <path
      d={[
        `M ${n(x - implantHalfAt(0.55))} ${n(y(0.55))}`,
        `L ${n(x - implantHalfAt(8.6))} ${n(y(8.6))}`,
        `Q ${n(x - 4.35)} ${n(y(9.85))} ${n(x - 3.5)} ${n(y(9.85))}`,
        `Q ${n(x - 2.4)} ${n(y(10.3))} ${n(x - 1.2)} ${n(y(9.95))}`,
        `L ${n(x + 1.2)} ${n(y(9.95))}`,
        `Q ${n(x + 2.4)} ${n(y(10.3))} ${n(x + 3.5)} ${n(y(9.85))}`,
        `Q ${n(x + 4.35)} ${n(y(9.85))} ${n(x + implantHalfAt(8.6))} ${n(y(8.6))}`,
        `L ${n(x + implantHalfAt(0.55))} ${n(y(0.55))}`,
        'Z',
      ].join(' ')}
      fill={tones.implant}
    />
    {IMPLANT_THREADS.map((mm) => {
      const half = implantHalfAt(mm) + 0.4;
      return (
        <g key={`rosca-${String(mm)}`}>
          <path
            d={`M ${n(x - half)} ${n(y(mm))} Q ${n(x)} ${n(y(mm + 0.5))} ${n(x + half)} ${n(y(mm))}`}
            fill="none"
            stroke={tones.implantLine}
            strokeWidth={0.6}
            strokeLinecap="round"
          />
          <path
            d={`M ${n(x - half + 0.5)} ${n(y(mm + 0.42))} Q ${n(x)} ${n(y(mm + 0.78))} ${n(x + half - 0.5)} ${n(y(mm + 0.42))}`}
            fill="none"
            stroke={tones.highlight}
            strokeWidth={0.3}
            strokeLinecap="round"
            opacity={0.5}
          />
        </g>
      );
    })}
  </>
);

/**
 * Silueta de una pieza dentro de su banda. Es puramente decorativa (`aria-hidden`,
 * sin eventos): por encima de ella van la rejilla, el LAC, las curvas de PS/MG y las
 * marcas clínicas, de modo que se lee como una radiografía milimetrada.
 */
export const ToothSilhouette = ({
  fdi,
  toothIndex,
  arch,
  layout,
  missing,
  implant,
  tones,
}: ToothSilhouetteProps) => {
  if (missing) return null;

  const spec = toothSilhouetteSpec(fdi, arch, layout.side, implant);
  const xCenter = toothIndex * TOOTH_COLUMN_WIDTH + TOOTH_COLUMN_WIDTH / 2;
  const y = (mm: number): number => depthY(layout, mm);
  const face = pieceFaceOf(arch, layout.side);
  const bounds = pieceBounds(face, fdi);
  const inner = implant ? null : pieceMarkup(face, fdi);
  // Sin archivo no se inventa un dibujo: la pieza se queda sin silueta, como si el
  // interruptor estuviera apagado para esa columna.
  if (!implant && (inner === null || bounds === null)) return null;

  return (
    <g
      data-silhouette={spec.kind}
      data-fdi={fdi}
      data-face={layout.side}
      data-direction={layout.direction}
      aria-hidden="true"
      focusable="false"
      pointerEvents="none"
      opacity={tones.opacity}
    >
      {implant ? (
        <ImplantScrew x={xCenter} y={y} tones={tones} />
      ) : (
        <g
          data-piece={`${face}/${String(fdi)}`}
          transform={pieceTransform(
            layout,
            xCenter,
            spec,
            bounds as readonly [number, number, number, number],
          )}
          // El dibujo es una constante del paquete (no hay datos de usuario): se
          // inserta como marcado para no re-crear cientos de nodos por pieza.
          dangerouslySetInnerHTML={{ __html: inner as string }}
        />
      )}
    </g>
  );
};

/* ── Capa de fondo ─────────────────────────────────────────────────────────── */

/**
 * Firma del estado que dibuja el fondo: pieza, ausente e implante. Las mediciones
 * (PS, MG, BOP…) no cambian el dibujo, así que no entran: sondar un sitio no puede
 * rehacer las 640 rutas de las dos arcadas en cada toque del pad.
 */
export const silhouetteSignature = (teeth: readonly PeriodontalTooth[]): string =>
  teeth
    .map((tooth) => `${String(tooth.fdi)}${tooth.missing ? 'm' : ''}${tooth.implant ? 'i' : ''}`)
    .join('|');

interface ToothSilhouetteLayerProps {
  arch: PeriodontalArch;
  /** Las 16 piezas de la arcada, en orden visual. */
  teeth: readonly PeriodontalTooth[];
  /** Resultado de `silhouetteSignature`: decide si hay que repintar la capa. */
  signature: string;
  paper: boolean;
  dark: boolean;
}

const ToothSilhouetteLayerBase = ({ arch, teeth, paper, dark }: ToothSilhouetteLayerProps) => {
  const tones = toothSilhouetteTones(paper, dark);
  return (
    <g aria-hidden="true" pointerEvents="none">
      {archBands(arch).map((layout) => (
        <g key={layout.side} data-cara={layout.side}>
          {teeth.map((tooth, toothIndex) => (
            <ToothSilhouette
              key={`silueta-${String(tooth.fdi)}-${layout.side}`}
              fdi={tooth.fdi}
              toothIndex={toothIndex}
              arch={arch}
              layout={layout}
              missing={tooth.missing}
              implant={tooth.implant}
              tones={tones}
            />
          ))}
        </g>
      ))}
    </g>
  );
};

/**
 * Capa de piezas de una arcada, memoizada. Va **antes** de las bandas en el SVG: así
 * queda debajo de la rejilla, del LAC y de las curvas de PS/MG, y el orden entre las
 * dos caras da igual porque cada una ocupa su mitad del lienzo.
 */
export const ToothSilhouetteLayer = memo(
  ToothSilhouetteLayerBase,
  (prev, next) =>
    prev.signature === next.signature &&
    prev.arch === next.arch &&
    prev.paper === next.paper &&
    prev.dark === next.dark,
);
