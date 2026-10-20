import { archOfTooth, TOOTH_CANVAS } from '@odontocrm/contracts';

import { pieceBounds, pieceFaceOf, pieceMarkup } from '../tooth-art/pieceArt';

/**
 * Pieza de fondo del odontograma.
 *
 * El odontograma es un **esquema oclusal**: cada pieza es un cuadro de 100×100 con
 * cinco caras (vestibular arriba, lingual abajo, mesial/distal a los lados, oclusal
 * al centro). Los dibujos del consultorio son **frontales** —corona y raíz—, así que
 * aquí funcionan como una imagen de fondo: se encajan completos, centrados y sin
 * deformarse dentro del cuadro, y las cinco caras del esquema siguen siendo las que
 * mandan (y las que reciben el toque).
 *
 * No es una vista anatómica: es una textura opt-in (el interruptor nace apagado) para
 * que el esquema se reconozca como un diente. Las piezas **temporales** no tienen
 * dibujo y se quedan con el esquema, sin hueco ni salto.
 *
 * La orientación de cada arcada sale gratis: en `maxilar-vestibular` la corona está
 * en el borde inferior de la caja y en `mandibula-vestibular` en el superior, de modo
 * que las dos arcadas quedan con las coronas mirándose.
 */

/** Opacidad del fondo en pantalla; en papel sube para que la impresora lo saque. */
export const BACKDROP_OPACITY = { screen: 0.32, paper: 0.45 } as const;

/** Redondeo corto: el `transform` no necesita más de dos decimales. */
const n = (value: number): string => String(Math.round(value * 100) / 100);

/** Carpeta del dibujo que usa el odontograma para una pieza (siempre la vestibular). */
export const backdropFaceOf = (toothNumber: number) => {
  const arch = archOfTooth(toothNumber);
  return arch === null ? null : pieceFaceOf(arch, 'vestibular');
};

/**
 * Encaje del dibujo dentro del cuadro de la pieza.
 *
 * Se escala con el **menor** de los dos factores (ancho y alto) para no deformarlo;
 * lo que sobra queda como margen, que es el aire que deja leer las caras del esquema
 * sin tapar el número.
 */
export interface BackdropWindow {
  scale: number;
  /** Traslación hasta dejar el dibujo centrado en el cuadro. */
  tx: number;
  ty: number;
}

export const backdropWindow = (
  bounds: readonly [number, number, number, number],
): BackdropWindow => {
  const [bx, by, bw, bh] = bounds;
  const scale = Math.min(TOOTH_CANVAS / bw, TOOTH_CANVAS / bh);
  return {
    scale,
    tx: TOOTH_CANVAS / 2 - (bx + bw / 2) * scale,
    ty: TOOTH_CANVAS / 2 - (by + bh / 2) * scale,
  };
};

/** `transform` que lleva el dibujo de su caja original al centro del cuadro. */
export const backdropTransform = (bounds: readonly [number, number, number, number]): string => {
  const { scale, tx, ty } = backdropWindow(bounds);
  return `translate(${n(tx)} ${n(ty)}) scale(${n(scale)})`;
};

export interface ToothBackdropProps {
  toothNumber: number;
  /** En papel sube la opacidad: lo que se imprime pierde contraste. */
  paper?: boolean;
}

/**
 * Fondo de una pieza. Devuelve `null` cuando no hay dibujo —las piezas temporales no
 * están en el juego— y entonces la columna se queda con el esquema de siempre.
 */
export const ToothBackdrop = ({ toothNumber, paper = false }: ToothBackdropProps) => {
  const face = backdropFaceOf(toothNumber);
  if (face === null) return null;
  const bounds = pieceBounds(face, toothNumber);
  const inner = pieceMarkup(face, toothNumber);
  if (bounds === null || inner === null) return null;

  return (
    <g
      data-pieza-fondo={toothNumber}
      aria-hidden="true"
      focusable="false"
      pointerEvents="none"
      opacity={paper ? BACKDROP_OPACITY.paper : BACKDROP_OPACITY.screen}
    >
      {/*
        El dibujo es una constante del paquete (no hay datos de usuario), así que se
        inserta como marcado: recrear cientos de nodos por pieza en cada cambio de
        hallazgo se nota en una tablet.
      */}
      <g
        data-pieza={toothNumber}
        transform={backdropTransform(bounds)}
        dangerouslySetInnerHTML={{ __html: inner }}
      />
    </g>
  );
};
