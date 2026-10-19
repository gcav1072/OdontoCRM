import {
  buildPeriodontalChart,
  type PeriodontalArch,
  type PeriodontalTooth,
} from '@odontocrm/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { PeriodontogramArchSvg, type PeriodontogramArchSvgProps } from './PeriodontogramArchSvg';

/**
 * Pruebas del **pintado** de las furcas y de las etiquetas de cara.
 *
 * Existen por dos errores clínicos reales: el grado 0 se dibujaba igual que el grado
 * I (un triángulo vacío), así que una boca en blanco parecía tener lesiones en todas
 * las piezas multirradiculares; y las furcas de 14/24 se pintaban en la cara
 * vestibular, que en esos premolares es una raíz única. Se renderiza a HTML con
 * `renderToStaticMarkup` (sin DOM), como el resto de pruebas de componentes.
 */

/** Triángulos dibujados: los de furca no comparten ningún otro polígono sin datos. */
const triangulos = (markup: string): number => [...markup.matchAll(/<polygon /g)].length;

/** Pistas pasivas del grado 0 (solo en modo edición). */
const pistas = (markup: string): number =>
  [...markup.matchAll(/stroke-dasharray="1\.6 1\.4"/g)].length;

const boca = buildPeriodontalChart();
const maxilar = boca.slice(0, 16);
const mandibula = boca.slice(16);

const render = (
  arch: PeriodontalArch,
  teeth: readonly PeriodontalTooth[],
  props: Partial<PeriodontogramArchSvgProps> = {},
): string => renderToStaticMarkup(createElement(PeriodontogramArchSvg, { arch, teeth, ...props }));

/** Marca una pieza con lesiones de furca concretas. */
const conFurcas = (
  teeth: readonly PeriodontalTooth[],
  fdi: number,
  furcation: PeriodontalTooth['furcation'],
): PeriodontalTooth[] =>
  teeth.map((tooth) => (tooth.fdi === fdi ? { ...tooth, furcation } : tooth));

describe('simbología de las furcas', () => {
  it('el grado 0 no dibuja nada en papel ni en solo lectura', () => {
    const markup = render('maxilar', maxilar, { readOnly: true, paper: true });
    expect(triangulos(markup)).toBe(0);
    expect(pistas(markup)).toBe(0);
  });

  it('en edición el grado 0 deja una pista punteada tenue, no un triángulo vacío', () => {
    const markup = render('maxilar', maxilar);
    // 6 molares × 3 entradas + 14 y 24 × 2 entradas.
    expect(pistas(markup)).toBe(22);
    // La pista no se confunde con una lesión: no hay ningún triángulo sólido.
    expect(triangulos(markup)).toBe(22);
    expect(markup).toContain('opacity="0.45"');
  });

  it('I es vacío, II va medio relleno y III va lleno', () => {
    const markup = render(
      'maxilar',
      conFurcas(maxilar, 16, { vestibular: 1, mesiopalatina: 2, distopalatina: 3 }),
      { readOnly: true, paper: true },
    );
    // I: contorno vacío · II: media mitad + contorno · III: triángulo lleno.
    expect(triangulos(markup)).toBe(4);
    expect(pistas(markup)).toBe(0);
  });
});

describe('paleta clínica del tema', () => {
  const conLesion = conFurcas(maxilar, 16, { vestibular: 1 });

  it('en claro la lesión va en ámbar y en oscuro en un ámbar más luminoso', () => {
    expect(render('maxilar', conLesion, { readOnly: true })).toContain('stroke="#b45309"');
    expect(render('maxilar', conLesion, { readOnly: true, dark: true })).toContain(
      'stroke="#fbbf24"',
    );
  });

  it('el papel no hereda el tema oscuro: imprime con tinta de marca', () => {
    const markup = render('maxilar', conLesion, { readOnly: true, paper: true, dark: true });
    expect(markup).toContain('stroke="var(--brand-ink)"');
  });
});

describe('etiquetas de cara de cada rejilla', () => {
  it('el maxilar rotula vestibular arriba y palatino abajo', () => {
    const markup = render('maxilar', maxilar, { readOnly: true });
    expect(markup).toContain('>VESTIBULAR<');
    expect(markup).toContain('>PALATINO<');
    expect(markup).not.toContain('>LINGUAL<');
  });

  it('la mandíbula rotula lingual arriba y vestibular abajo', () => {
    const markup = render('mandibula', mandibula, { readOnly: true });
    expect(markup).toContain('>LINGUAL<');
    expect(markup).toContain('>VESTIBULAR<');
    expect(markup).not.toContain('>PALATINO<');
  });
});
