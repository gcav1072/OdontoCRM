import {
  buildPeriodontalChart,
  PERIODONTAL_LOWER_TEETH,
  PERIODONTAL_UPPER_TEETH,
  type PeriodontalArch,
  type PeriodontalTooth,
} from '@odontocrm/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { MM_UNIT, archBands } from './geometry';
import { PeriodontogramArchSvg, type PeriodontogramArchSvgProps } from './PeriodontogramArchSvg';
import { pieceBounds, pieceFaceOf, pieceMarkup } from '../tooth-art/pieceArt';
import { pieceCalibration, toothSilhouetteSpec, toothSilhouetteTones } from './ToothSilhouette';

/**
 * Pruebas de las piezas ilustradas del periodontograma.
 *
 * Lo que se fija aquí es lo que se rompe sin avisar: que las 64 piezas estén en el
 * paquete y en la carpeta correcta (cara y arcada), que la pieza ausente no dibuje
 * nada, que el implante siga teniendo su tornillo y que la calibración lleve la
 * corona y el ápice a las cotas exactas de la rejilla. Las piezas no llevan
 * polígonos: `archSvg.test.ts` cuenta `<polygon>` para validar las furcas de Hamp.
 */

const boca = buildPeriodontalChart();
const maxilar = boca.slice(0, 16);
const mandibula = boca.slice(16);

const render = (
  arch: PeriodontalArch,
  teeth: readonly PeriodontalTooth[],
  props: Partial<PeriodontogramArchSvgProps> = {},
): string => renderToStaticMarkup(createElement(PeriodontogramArchSvg, { arch, teeth, ...props }));

/** Piezas dibujadas: cada grupo de pieza lleva `data-silhouette`. */
const siluetas = (markup: string): number => [...markup.matchAll(/data-silhouette="/g)].length;

/** Piezas con ilustración (el implante no lleva `data-piece`). */
const ilustraciones = (markup: string): number => [...markup.matchAll(/data-piece="/g)].length;

const deTipo = (markup: string, kind: string): number =>
  [...markup.matchAll(new RegExp(`data-silhouette="${kind}"`, 'g'))].length;

const conEstado = (
  teeth: readonly PeriodontalTooth[],
  fdi: number,
  cambio: Partial<PeriodontalTooth>,
): PeriodontalTooth[] =>
  teeth.map((tooth) => (tooth.fdi === fdi ? { ...tooth, ...cambio } : tooth));

describe('carpeta de la pieza', () => {
  it('cada arcada y cara tiene su carpeta, y la mandíbula nunca usa el palatino', () => {
    expect(pieceFaceOf('maxilar', 'vestibular')).toBe('maxilar-vestibular');
    expect(pieceFaceOf('maxilar', 'lingual')).toBe('maxilar-palatino');
    expect(pieceFaceOf('mandibula', 'vestibular')).toBe('mandibula-vestibular');
    expect(pieceFaceOf('mandibula', 'lingual')).toBe('mandibula-lingual');
  });

  it('las 64 piezas están en el paquete, con su caja medida', () => {
    const caras = [
      ['maxilar', PERIODONTAL_UPPER_TEETH],
      ['mandibula', PERIODONTAL_LOWER_TEETH],
    ] as const;
    let total = 0;
    for (const [arch, piezas] of caras) {
      for (const fdi of piezas) {
        for (const side of ['vestibular', 'lingual'] as const) {
          const face = pieceFaceOf(arch, side);
          expect(pieceMarkup(face, fdi), `${face}/${String(fdi)}`).not.toBeNull();
          expect(pieceBounds(face, fdi), `${face}/${String(fdi)}`).not.toBeNull();
          total += 1;
        }
      }
    }
    expect(total).toBe(64);
  });

  it('el dibujo es vectorial y no trae recursos externos', () => {
    const dibujo = pieceMarkup('maxilar-vestibular', 16) ?? '';
    expect(dibujo.startsWith('<path')).toBe(true);
    expect(dibujo).not.toContain('<image');
    expect(dibujo).not.toContain('<use');
    expect(dibujo).not.toContain('url(');
    expect(dibujo).not.toContain('<polygon');
  });
});

describe('arquetipos y calibración', () => {
  it('las piezas unirradiculares son más cortas que el canino', () => {
    expect(toothSilhouetteSpec(11, 'maxilar', 'vestibular')).toMatchObject({
      kind: 'single',
      rootDepthMm: 12,
    });
    expect(toothSilhouetteSpec(13, 'maxilar', 'vestibular').rootDepthMm).toBe(14);
    expect(toothSilhouetteSpec(45, 'mandibula', 'vestibular').kind).toBe('single');
  });

  it('los molares cambian de arquetipo según la arcada y la cara', () => {
    expect(toothSilhouetteSpec(46, 'mandibula', 'vestibular').kind).toBe('molar-lower');
    expect(toothSilhouetteSpec(16, 'maxilar', 'vestibular').kind).toBe('molar-upper');
    expect(toothSilhouetteSpec(16, 'maxilar', 'lingual')).toMatchObject({
      kind: 'molar-upper-palatal',
      rootDepthMm: 14,
    });
  });

  it('el implante manda sobre la anatomía de la pieza', () => {
    expect(toothSilhouetteSpec(16, 'maxilar', 'vestibular', true)).toMatchObject({
      kind: 'implant',
      rootDepthMm: 10,
    });
  });

  it('la corona queda en el lado coronal y el ápice en su cota, en las dos bandas', () => {
    const spec = toothSilhouetteSpec(11, 'maxilar', 'vestibular');
    const bounds = pieceBounds('maxilar-vestibular', 11) as readonly [
      number,
      number,
      number,
      number,
    ];
    for (const layout of archBands('maxilar')) {
      const calibracion = pieceCalibration(layout, 20, spec, bounds);
      const crownAtTop = layout.direction === 'down';
      const sourceApex = crownAtTop ? bounds[1] + bounds[3] : bounds[1];
      const mappedApex =
        calibracion.ty + (sourceApex - calibracion.sourceCrownY) * calibracion.scaleY;
      // La corona nace en el borde coronal (milímetros negativos) y el ápice en su
      // cota radicular: la pieza comparte la escala de la rejilla de 2 mm.
      expect(calibracion.ty).toBeCloseTo(
        layout.direction === 'up'
          ? layout.lacY + spec.crownDepthMm * MM_UNIT
          : layout.lacY - spec.crownDepthMm * MM_UNIT,
        5,
      );
      expect(mappedApex).toBeCloseTo(
        layout.direction === 'up'
          ? layout.lacY - spec.rootDepthMm * MM_UNIT
          : layout.lacY + spec.rootDepthMm * MM_UNIT,
        5,
      );
    }
  });

  it('la calibración estira el dibujo a la longitud radicular y al ancho anatómico', () => {
    const layout = archBands('maxilar')[0];
    expect(layout).toBeDefined();
    if (layout === undefined) return;
    const spec = toothSilhouetteSpec(11, 'maxilar', layout.side);
    const [bx, by, bw, bh] = pieceBounds('maxilar-vestibular', 11) as readonly [
      number,
      number,
      number,
      number,
    ];
    const calibracion = pieceCalibration(layout, 20, spec, [bx, by, bw, bh]);
    // Ancho: 2 × 4,2 mm llevados a unidades del lienzo.
    expect(calibracion.scaleX * bw).toBeCloseTo(2 * spec.halfWidth * MM_UNIT, 5);
    // Alto: corona + raíz en unidades del lienzo (el signo depende de la banda).
    expect(Math.abs(calibracion.scaleY) * bh).toBeCloseTo(
      (spec.crownDepthMm + spec.rootDepthMm) * MM_UNIT,
      5,
    );
    expect(calibracion.tx).toBe(20);
    expect(calibracion.sourceCenterX).toBeCloseTo(bx + bw / 2, 5);
  });
});

describe('pintado en la arcada', () => {
  it('dibuja una pieza ilustrada por diente y banda', () => {
    const markup = render('maxilar', maxilar, { readOnly: true });
    expect(siluetas(markup)).toBe(32);
    expect(ilustraciones(markup)).toBe(32);
    expect([...markup.matchAll(/data-direction="up"/g)]).toHaveLength(16);
    expect([...markup.matchAll(/data-direction="down"/g)]).toHaveLength(16);
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain('pointer-events="none"');
  });

  it('cada cara usa su carpeta de dibujos', () => {
    const markup = render('maxilar', maxilar, { readOnly: true });
    expect(markup).toContain('data-piece="maxilar-vestibular/16"');
    expect(markup).toContain('data-piece="maxilar-palatino/16"');
    const inferior = render('mandibula', mandibula, { readOnly: true });
    expect(inferior).toContain('data-piece="mandibula-lingual/36"');
    expect(inferior).toContain('data-piece="mandibula-vestibular/36"');
  });

  it('no añade polígonos: la simbología de furcas sigue contando lo suyo', () => {
    const markup = render('maxilar', maxilar, { readOnly: true, paper: true });
    expect(markup).not.toContain('<polygon');
  });

  it('la pieza ausente deja la columna vacía', () => {
    const markup = render('maxilar', conEstado(maxilar, 18, { missing: true }), { readOnly: true });
    expect(siluetas(markup)).toBe(30);
    expect(markup).not.toContain('data-fdi="18"');
  });

  it('el implante se dibuja como tornillo, sin ilustración', () => {
    const markup = render('maxilar', conEstado(maxilar, 16, { implant: true }), { readOnly: true });
    expect(deTipo(markup, 'implant')).toBe(2);
    expect(ilustraciones(markup)).toBe(30);
    expect(markup).not.toContain('data-piece="maxilar-vestibular/16"');
  });

  it('el interruptor las apaga por completo', () => {
    const markup = render('maxilar', maxilar, { readOnly: true, showSilhouettes: false });
    expect(siluetas(markup)).toBe(0);
  });

  it('el papel imprime el dibujo completo y la pantalla lo atenúa', () => {
    expect(toothSilhouetteTones(true, false)).toMatchObject({ variant: 'paper', opacity: 0.85 });
    expect(toothSilhouetteTones(false, false).opacity).toBeLessThan(1);
    expect(toothSilhouetteTones(false, true).variant).toBe('dark');
    const papel = render('maxilar', maxilar, { readOnly: true, paper: true, dark: true });
    expect(papel).toContain('opacity="0.85"');
    const pantalla = render('maxilar', maxilar, { readOnly: true });
    expect(pantalla).toContain('opacity="0.62"');
  });
});
