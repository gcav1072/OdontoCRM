import { TOOTH_CANVAS, archLayout } from '@odontocrm/contracts';
import type { OdontogramDetail } from '@odontocrm/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { pieceBounds } from '../tooth-art/pieceArt';
import { OdontogramChart } from './OdontogramChart';
import { OdontogramStaticChart } from './OdontogramStaticChart';
import {
  BACKDROP_OPACITY,
  backdropFaceOf,
  backdropTransform,
  backdropWindow,
} from './ToothBackdrop';

/**
 * Pruebas de la corona de fondo del odontograma.
 *
 * Lo que se fija aquí es lo que se rompe sin avisar: que el interruptor esté
 * **apagado de fábrica**, que las piezas temporales no dibujen nada (no hay archivo
 * para ellas) y que el recorte deje la corona centrada en el cuadro de la pieza, que
 * es lo que evita que el dibujo se salga de su columna.
 */

const renderChart = (showPieces: boolean, dentition?: 'permanente' | 'temporal' | 'mixta') =>
  renderToStaticMarkup(
    createElement(OdontogramChart, { detail: null, readOnly: true, showPieces, dentition }),
  );

/** Piezas con corona de fondo, en el orden en que se pintan. */
const fondos = (markup: string): number[] =>
  [...markup.matchAll(/data-pieza-fondo="(\d+)"/g)].map((match) => Number(match[1]));

describe('interruptor', () => {
  it('apagado de fábrica: el gráfico no dibuja ninguna corona', () => {
    expect(fondos(renderChart(false))).toHaveLength(0);
    expect(
      renderToStaticMarkup(createElement(OdontogramChart, { detail: null, readOnly: true })),
    ).toContain('<svg');
  });

  it('encendido dibuja una corona por pieza permanente, y solo detrás', () => {
    const markup = renderChart(true);
    const piezas = fondos(markup);
    expect(piezas).toHaveLength(32);
    expect(piezas.slice(0, 3)).toEqual([18, 17, 16]);
    expect(piezas.slice(16, 19)).toEqual([48, 47, 46]);
    // Es decorativa: ni foco ni toque, y con la opacidad de pantalla.
    expect(markup).toContain('pointer-events="none"');
    expect(markup).toContain(`opacity="${String(BACKDROP_OPACITY.screen)}"`);
  });

  it('las piezas de leche se quedan con el esquema: no hay dibujo para ellas', () => {
    expect(fondos(renderChart(true, 'temporal'))).toHaveLength(0);
    // En la boca mixta solo las permanentes llevan corona (32), no las 20 de leche.
    expect(fondos(renderChart(true, 'mixta'))).toHaveLength(32);
  });

  it('en papel sube la opacidad, porque la impresión pierde contraste', () => {
    const papel = renderToStaticMarkup(
      createElement(OdontogramStaticChart, { detail: null, showPieces: true }),
    );
    expect(fondos(papel)).toHaveLength(32);
    expect(papel).toContain(`opacity="${String(BACKDROP_OPACITY.paper)}"`);
    expect(BACKDROP_OPACITY.paper).toBeGreaterThan(BACKDROP_OPACITY.screen);
    // Sin la prop, el papel sigue siendo el esquema de siempre.
    const sinPiezas = renderToStaticMarkup(createElement(OdontogramStaticChart, { detail: null }));
    expect(fondos(sinPiezas)).toHaveLength(0);
  });

  it('con la corona encendida el hallazgo deja pasar el dibujo', () => {
    const conHallazgo = {
      id: 'odonto-1',
      patientId: 'paciente-1',
      findings: {
        16: [
          {
            id: 'f1',
            toothNumber: 16,
            condition: 'caries' as const,
            surface: 'occlusal' as const,
            state: 'pendiente' as const,
            notes: null,
            recordedByUsername: null,
            recordedAt: '2026-10-19T10:00:00.000Z',
            updatedAt: '2026-10-19T10:00:00.000Z',
            sessionId: null,
            resolvedAt: null,
          },
        ],
      },
      dentition: 'permanente' as const,
      prostheses: [],
      affectedTeeth: [16],
      empty: false,
      recordedByUsername: null,
      recordedAt: '2026-10-19T10:00:00.000Z',
      updatedAt: '2026-10-19T10:00:00.000Z',
      lastPrintedAt: null,
      printCount: 0,
      patient: null,
    } satisfies OdontogramDetail;
    const markup = renderToStaticMarkup(
      createElement(OdontogramChart, { detail: conHallazgo, readOnly: true, showPieces: true }),
    );
    expect(markup).toContain('fill-opacity="0.6"');
  });
});

describe('encaje en el cuadro', () => {
  it('la cara sale de la arcada y las temporales no tienen', () => {
    expect(backdropFaceOf(16)).toBe('maxilar-vestibular');
    expect(backdropFaceOf(26)).toBe('maxilar-vestibular');
    expect(backdropFaceOf(46)).toBe('mandibula-vestibular');
    expect(backdropFaceOf(36)).toBe('mandibula-vestibular');
    expect(backdropFaceOf(55)).toBeNull();
  });

  it('la pieza queda centrada en el cuadro y sin deformarse', () => {
    const bounds = pieceBounds('maxilar-vestibular', 11);
    expect(bounds).not.toBeNull();
    if (bounds === null) return;
    const [bx, by, bw, bh] = bounds;
    const ventana = backdropWindow(bounds);
    const transform = backdropTransform(bounds);

    // Un solo factor para los dos ejes: el dibujo no se estira.
    expect(transform).toContain(`scale(${String(Math.round(ventana.scale * 100) / 100)})`);
    expect(ventana.scale).toBeCloseTo(Math.min(TOOTH_CANVAS / bw, TOOTH_CANVAS / bh), 5);

    // Y cabe dentro del cuadro, centrado.
    const ancho = bw * ventana.scale;
    const alto = bh * ventana.scale;
    expect(ancho).toBeLessThanOrEqual(TOOTH_CANVAS + 0.01);
    expect(alto).toBeLessThanOrEqual(TOOTH_CANVAS + 0.01);
    expect(ventana.tx + (bx + bw / 2) * ventana.scale).toBeCloseTo(TOOTH_CANVAS / 2, 5);
    expect(ventana.ty + (by + bh / 2) * ventana.scale).toBeCloseTo(TOOTH_CANVAS / 2, 5);
    expect(ancho / 2).toBeLessThanOrEqual(TOOTH_CANVAS / 2 + 0.01);
    expect(alto / 2).toBeLessThanOrEqual(TOOTH_CANVAS / 2 + 0.01);
  });

  it('el encaje usa el cuadro de la pieza, no el ancho de la arcada', () => {
    const layout = archLayout('permanente');
    const bounds = pieceBounds('maxilar-vestibular', 11) as [number, number, number, number];
    expect(layout.width).toBeGreaterThan(TOOTH_CANVAS);
    // El centrado es siempre 50: el dibujo se coloca dentro de sus 100, no en la fila.
    expect(backdropWindow(bounds).tx).toBeCloseTo(
      TOOTH_CANVAS / 2 - (bounds[0] + bounds[2] / 2) * backdropWindow(bounds).scale,
      5,
    );
  });
});
