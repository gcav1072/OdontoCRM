import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { MIDLINE_GAP, TOOTH_STRIDE, archLayout } from '@odontocrm/contracts';

import { OdontogramChart } from './OdontogramChart';
import { TOOTH_CANVAS, TOOTH_LABEL_BASELINE } from './GeometricTooth';

/**
 * Pruebas del **pintado** del gráfico: posiciones, no solo contenido.
 *
 * Existe por un fallo real: las 16 piezas de cada arcada se dibujaban **todas en la
 * misma x**, así que los números se superponían en un amasijo y pulsar una pieza
 * parecía no cambiar nada (siempre se seleccionaba la misma). La geometría del
 * contrato era correcta; lo que faltaba era una prueba que mirara las coordenadas.
 * Se renderiza a HTML con `renderToStaticMarkup` (sin DOM) y se leen los
 * `transform` de cada pieza.
 */

const html = renderToStaticMarkup(createElement(OdontogramChart, { detail: null, readOnly: true }));

/** x de cada pieza, en el orden en que se pinta: los `translate` de primer nivel. */
const posiciones = (markup: string): number[] =>
  [...markup.matchAll(/<g transform="translate\((\d+(?:\.\d+)?),0\)"/g)].map((match) =>
    Number(match[1]),
  );

describe('el gráfico coloca cada pieza en su sitio', () => {
  it('dibuja las 16 piezas de cada arcada, separadas por el paso del contrato', () => {
    const xs = posiciones(html);
    expect(xs).toHaveLength(32);

    const esperado = archLayout('permanente').upper.map((tooth) => tooth.x);
    // Las dos arcadas usan las mismas x: la superior y la inferior cuadran.
    expect(xs.slice(0, 16)).toEqual(esperado);
    expect(xs.slice(16)).toEqual(esperado);
    // Dentro de cada cuadrante el paso es fijo, y en la línea media hay hueco extra.
    expect(esperado.slice(0, 8)).toEqual([0, 1, 2, 3, 4, 5, 6, 7].map((i) => i * TOOTH_STRIDE));
    expect((esperado[8] ?? 0) - (esperado[7] ?? 0)).toBe(TOOTH_STRIDE + MIDLINE_GAP);
  });

  it('ninguna pieza comparte x con otra: los números no pueden superponerse', () => {
    const xs = posiciones(html).slice(0, 16);
    expect(new Set(xs).size).toBe(xs.length);
  });

  it('el lienzo es tan ancho como la arcada, no más', () => {
    const ancho = archLayout('permanente').width;
    expect(html).toContain(`viewBox="-6 -6 ${String(ancho + 12)} `);
  });

  it('cada pieza lleva su número, una sola vez, en su propio grupo', () => {
    const numeros = [...html.matchAll(/>(\d{2})<\/text>/g)].map((match) => Number(match[1]));
    expect(numeros).toHaveLength(32);
    expect(numeros.slice(0, 16)).toEqual([
      18, 17, 16, 15, 14, 13, 12, 11, 21, 22, 23, 24, 25, 26, 27, 28,
    ]);
    expect(numeros.slice(16)).toEqual([
      48, 47, 46, 45, 44, 43, 42, 41, 31, 32, 33, 34, 35, 36, 37, 38,
    ]);
  });

  it('el número de pieza queda separado del cuadro y no se recorta', () => {
    // El aire entre el borde del cuadro y la línea base: con menos de 30 unidades
    // (las cifras miden 26–30 de alto) el número se veía pegado al cuadro.
    expect(TOOTH_LABEL_BASELINE - TOOTH_CANVAS).toBeGreaterThanOrEqual(30);
    expect(html).toContain(`y="${String(TOOTH_LABEL_BASELINE)}"`);

    // Y la arcada tiene alto de sobra para que el número entre entero.
    const alto = Number(/viewBox="-6 -6 [\d.]+ ([\d.]+)"/.exec(html)?.[1]);
    expect(alto).toBeGreaterThanOrEqual(TOOTH_LABEL_BASELINE + 8);
  });

  it('la pieza activa se marca en **su** grupo, no siempre en el primero', () => {
    const conActiva = renderToStaticMarkup(
      createElement(OdontogramChart, { detail: null, readOnly: true, activeTooth: 26 }),
    );
    const grupos = conActiva.split('<g transform="translate(');
    // El resalte (`fill-primary/10`) tiene que caer en el grupo de la 26, que es el
    // sexto de la arcada superior (18, 17, 16, 15, 14, 13, 12, 11, 21, … 26).
    const indice = grupos.findIndex((grupo) => grupo.includes('fill-primary/10'));
    expect(indice).toBeGreaterThan(0);
    expect(grupos[indice]).toContain('>26</text>');

    // Y en la boca sana sin pieza activa no hay resalte ninguno.
    expect(html).not.toContain('fill-primary/10');
  });
});
