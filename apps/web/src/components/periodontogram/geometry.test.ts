import {
  PERIODONTAL_CHANGE_COLORS,
  comparePeriodontalCharts,
  buildPeriodontalChart,
} from '@odontocrm/contracts';
import { describe, expect, it } from 'vitest';

import {
  ARCH_TOOTH_COUNT,
  ARCH_VIEW_HEIGHT,
  ARCH_VIEW_WIDTH,
  BAND_HEIGHT,
  CORONAL_GUIDE_MM,
  GRID_APICAL_MM,
  TOOTH_CARD_INSET,
  TOOTH_STRIP_HEIGHT,
  archBandOrder,
  archBands,
  bandDepthLimits,
  bandLayout,
  bandPlotBounds,
  changeColor,
  comparisonSiteIndex,
  comparisonSiteOf,
  depthY,
  furcationMarkerPosition,
  nicPolygonPoints,
  periodontalColors,
  polylinePoints,
  previousPdPoints,
  siteDrawing,
  siteCursorBox,
  siteHitbox,
  siteX,
  type PeriodontalColors,
} from './geometry';

/**
 * Pruebas de la geometría del SVG: cada sitio cae en su columna, la PS y la MG
 * crecen hacia el lado correcto y el polígono del NIC une las dos curvas. Un error
 * aquí no rompe la compilación: pinta el gráfico mal, que es peor.
 */

describe('lienzo y columnas', () => {
  it('el ancho cubre las 16 piezas de 40 unidades', () => {
    expect(ARCH_VIEW_WIDTH).toBe(640);
    expect(ARCH_TOOTH_COUNT).toBe(16);
    expect(ARCH_VIEW_HEIGHT).toBe(BAND_HEIGHT * 2 + TOOTH_STRIP_HEIGHT);
  });

  it('los tres sitios de cada columna caen en 7, 20 y 33', () => {
    expect([siteX(0, 0), siteX(0, 1), siteX(0, 2)]).toEqual([7, 20, 33]);
    expect([siteX(15, 0), siteX(15, 1), siteX(15, 2)]).toEqual([607, 620, 633]);
  });

  it('cada pieza tiene tres zonas táctiles contiguas que cubren la columna', () => {
    const primera = siteHitbox(bandLayout('maxilar', 'vestibular'), 0, 0);
    const segunda = siteHitbox(bandLayout('maxilar', 'vestibular'), 0, 1);
    expect(primera.x).toBe(0);
    expect(primera.width).toBeCloseTo(40 / 3, 5);
    expect(segunda.x).toBeCloseTo(40 / 3, 5);
    expect(primera.centerX).toBe(7);
    expect(segunda.centerX).toBe(20);
  });
});

describe('bandas de las arcadas', () => {
  it('en el maxilar la vestibular va arriba y en la mandíbula abajo', () => {
    expect(archBandOrder('maxilar')).toEqual(['vestibular', 'lingual']);
    expect(archBandOrder('mandibula')).toEqual(['lingual', 'vestibular']);
  });

  it('la banda superior crece hacia arriba y la inferior hacia abajo', () => {
    const bandas = archBands('maxilar');
    const arriba = bandas[0];
    const abajo = bandas[1];
    expect(arriba?.direction).toBe('up');
    expect(abajo?.direction).toBe('down');
    expect(depthY(arriba!, 4)).toBeLessThan(depthY(arriba!, 0));
    expect(depthY(abajo!, 4)).toBeGreaterThan(depthY(abajo!, 0));
  });
});

describe('dibujo de un sitio', () => {
  it('sin sondar no hay línea de PS ni NIC (no se inventa un 0)', () => {
    const layout = bandLayout('maxilar', 'vestibular');
    const dibujo = siteDrawing(layout, 0, 0, { pd: null, gm: null });
    expect(dibujo.pdY).toBeNull();
    expect(dibujo.mgY).toBeNull();
    expect(dibujo.cal).toBeNull();
    expect(dibujo.calY).toBeNull();
  });

  it('la PS se mide desde el margen hacia el ápice y el NIC respeta MG = 0', () => {
    const layout = bandLayout('maxilar', 'vestibular');
    const sinMargen = siteDrawing(layout, 0, 1, { pd: 4, gm: null });
    // Con MG sin dato el NIC usa 0 (convención del contrato) y la PS sale del LAC.
    expect(sinMargen.cal).toBe(4);
    expect(sinMargen.pdY).toBe(depthY(layout, 4));

    const conRecesion = siteDrawing(layout, 0, 1, { pd: 4, gm: -2 });
    // Recesión: el margen baja hacia el ápice y el NIC sube a 6 mm.
    expect(conRecesion.cal).toBe(6);
    expect(conRecesion.mgY).toBe(depthY(layout, 2));
    expect(conRecesion.pdY).toBe(depthY(layout, 6));
  });

  it('una PS mayor que el tope dibujado se recorta para no salir del lienzo', () => {
    const layout = bandLayout('mandibula', 'lingual');
    const normal = siteDrawing(layout, 15, 2, { pd: 15, gm: 0 });
    const exagerada = siteDrawing(layout, 15, 2, { pd: 40, gm: 0 });
    expect(exagerada.pdY).toBe(normal.pdY);
  });

  it('una recesión extrema no dibuja el fondo de la bolsa fuera de la banda', () => {
    const layout = bandLayout('maxilar', 'vestibular');
    const limites = bandDepthLimits(layout);
    const extrema = siteDrawing(layout, 0, 0, { pd: 15, gm: -15 });
    // NIC de 30 mm: se recorta a lo que cabe en la banda (nunca sale del gráfico).
    expect(extrema.pdY).toBe(depthY(layout, limites.apical));
    expect(extrema.pdY).toBeGreaterThanOrEqual(layout.top - 1e-9);
  });

  it('el margen máximo del contrato (+10) cabe dentro de la banda', () => {
    const layout = bandLayout('mandibula', 'vestibular');
    const maximo = siteDrawing(layout, 0, 0, { pd: null, gm: 10 });
    expect(maximo.mgY).toBe(depthY(layout, -10));
    expect(maximo.mgY).toBeGreaterThanOrEqual(layout.top);
    // Un valor fuera de contrato tampoco se dibuja fuera de la banda.
    const fuera = siteDrawing(layout, 0, 0, { pd: null, gm: 30 });
    expect(fuera.mgY).toBe(layout.top);
  });
});

describe('marco del gráfico', () => {
  it('el marco del cursor no se sale de la tarjeta y contiene su punto', () => {
    const layout = bandLayout('maxilar', 'vestibular');
    for (const index of [0, 1, 2] as const) {
      const marco = siteCursorBox(layout, 7, index);
      const izquierda = 7 * 40 + TOOTH_CARD_INSET;
      const derecha = 8 * 40 - TOOTH_CARD_INSET;
      expect(marco.x).toBeGreaterThanOrEqual(izquierda);
      expect(marco.x + marco.width).toBeLessThanOrEqual(derecha);
      expect(marco.x).toBeLessThanOrEqual(siteX(7, index));
      expect(marco.x + marco.width).toBeGreaterThanOrEqual(siteX(7, index));
    }
  });
  it('el cursor se ajusta a la rejilla: de 14 mm apicales a +4 coronales', () => {
    const arriba = bandPlotBounds(bandLayout('maxilar', 'vestibular'));
    expect(arriba.top).toBe(depthY(bandLayout('maxilar', 'vestibular'), GRID_APICAL_MM));
    expect(arriba.bottom).toBe(depthY(bandLayout('maxilar', 'vestibular'), -CORONAL_GUIDE_MM));
    const abajo = bandPlotBounds(bandLayout('maxilar', 'lingual'));
    expect(abajo.top).toBe(depthY(bandLayout('maxilar', 'lingual'), -CORONAL_GUIDE_MM));
    expect(abajo.bottom).toBe(depthY(bandLayout('maxilar', 'lingual'), GRID_APICAL_MM));
  });
});

describe('polilíneas y polígono del NIC', () => {
  it('serializa puntos «x,y» y devuelve texto vacío sin puntos', () => {
    expect(
      polylinePoints([
        { x: 1, y: 2 },
        { x: 3, y: 4 },
      ]),
    ).toBe('1,2 3,4');
    expect(polylinePoints([])).toBe('');
  });

  it('el polígono recorre la MG y vuelve por la PS, y necesita dos puntos por lado', () => {
    const mg = [
      { x: 0, y: 10 },
      { x: 1, y: 12 },
    ];
    const pd = [
      { x: 0, y: 20 },
      { x: 1, y: 22 },
    ];
    expect(nicPolygonPoints(mg, pd)).toBe('0,10 1,12 1,22 0,20');
    expect(nicPolygonPoints(mg.slice(0, 1), pd)).toBeNull();
  });
});

describe('comparación sobre el gráfico', () => {
  it('indexa los 192 sitios por pieza, cara e índice', () => {
    const previous = buildPeriodontalChart();
    const current = buildPeriodontalChart();
    const comparison = comparePeriodontalCharts({
      previousExamId: 'a',
      previous,
      currentExamId: 'b',
      current,
    });
    const index = comparisonSiteIndex(comparison);
    expect(index.size).toBe(192);
    const sitio = comparisonSiteOf(index, 18, 'vestibular', 0);
    expect(sitio).not.toBeNull();
    expect(sitio?.change).toBe('sin_dato');
    expect(comparisonSiteOf(index, 49, 'vestibular', 0)).toBeNull();
  });

  it('los colores de cambio son los del contrato (tono, no el único indicador)', () => {
    for (const [change, color] of Object.entries(PERIODONTAL_CHANGE_COLORS)) {
      expect(changeColor(change as keyof typeof PERIODONTAL_CHANGE_COLORS)).toBe(color);
    }
  });

  it('la línea del examen anterior solo trae sitios sondados', () => {
    const layout = bandLayout('maxilar', 'vestibular');
    const points = previousPdPoints(layout, 0, [{ pd: 3, gm: null }, null, { pd: null, gm: null }]);
    expect(points).toHaveLength(1);
    expect(points[0]?.x).toBe(7);
  });
});

describe('posición anatómica de las furcas', () => {
  /** Fila de triángulos pegada a la banda superior y a la inferior. */
  const filaArriba = BAND_HEIGHT - 5;
  const filaAbajo = BAND_HEIGHT + TOOTH_STRIP_HEIGHT + 5;
  /** Centro de la columna de una pieza (18 → 0, 16 → 2, 14 → 4…). */
  const centro = (indice: number): number => indice * 40 + 20;

  it('en el maxilar la vestibular va arriba y las palatinas abajo', () => {
    expect(furcationMarkerPosition('maxilar', 2, 'vestibular')).toEqual({
      x: centro(2),
      y: filaArriba,
    });
    expect(furcationMarkerPosition('maxilar', 2, 'mesiopalatina')).toEqual({
      x: centro(2) - 8,
      y: filaAbajo,
    });
    expect(furcationMarkerPosition('maxilar', 2, 'distopalatina')).toEqual({
      x: centro(2) + 8,
      y: filaAbajo,
    });
  });

  it('en la mandíbula la lingual va arriba y la vestibular abajo', () => {
    expect(furcationMarkerPosition('mandibula', 2, 'lingual')).toEqual({
      x: centro(2),
      y: filaArriba,
    });
    expect(furcationMarkerPosition('mandibula', 2, 'vestibular')).toEqual({
      x: centro(2),
      y: filaAbajo,
    });
  });

  it('14 y 24 llevan sus dos furcas al palatino, no a la cara vestibular', () => {
    for (const indice of [4, 11]) {
      const mesial = furcationMarkerPosition('maxilar', indice, 'mesial');
      const distal = furcationMarkerPosition('maxilar', indice, 'distal');
      // La cara vestibular del premolar es una raíz única: no tiene furca.
      expect(mesial.y).toBe(filaAbajo);
      expect(distal.y).toBe(filaAbajo);
      // Alineadas con las entradas MP/DP de los molares (±8, nunca fuera de la tarjeta).
      expect(mesial.x).toBe(centro(indice) - 8);
      expect(distal.x).toBe(centro(indice) + 8);
    }
  });
});

describe('paleta clínica por tema', () => {
  it('el tema oscuro aclara los tonos que se perderían sobre una superficie oscura', () => {
    const claro = periodontalColors(false);
    const oscuro = periodontalColors(true);
    expect(oscuro).not.toBe(claro);
    expect(oscuro.pd).not.toBe(claro.pd);
    expect(oscuro.mg).not.toBe(claro.mg);
    expect(oscuro.grid).not.toBe(claro.grid);
    expect(oscuro.furca).not.toBe(claro.furca);
    expect(oscuro.furcaHint).not.toBe(claro.furcaHint);
    // Ningún tono puede quedar indefinido: se pintaría negro sobre negro.
    for (const clave of Object.keys(claro) as (keyof PeriodontalColors)[]) {
      expect(claro[clave]).toMatch(/^(#|rgba)/);
      expect(oscuro[clave]).toMatch(/^(#|rgba)/);
    }
  });
});
