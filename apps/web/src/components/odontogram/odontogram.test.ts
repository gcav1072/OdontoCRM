import type { OdontogramDetail, ToothFindingRecord } from '@odontocrm/contracts';
import { describe, expect, it } from 'vitest';

import {
  findingsForTooth,
  surfaceFill,
  surfaceFinding,
  toothState,
} from '../../lib/odontogram-api';
import { markerSlots, pointToSurface, toothAriaLabel } from './GeometricTooth';

/**
 * Pruebas de la vista del odontograma: lo que no se ve a simple vista.
 *
 * El entorno de pruebas es Node (sin DOM), así que lo que se prueba aquí es la
 * **lógica**: la lectura del patrón por excepción y, sobre todo, la conversión de
 * coordenadas, que es donde se registra la cara contraria si el volteo de la
 * mandíbula se aplica al revés.
 */

const hallazgo = (parcial: Partial<ToothFindingRecord>): ToothFindingRecord => ({
  id: '00000000-0000-4000-8000-000000000001',
  toothNumber: 16,
  surface: 'occlusal',
  condition: 'caries',
  state: 'pendiente',
  notes: null,
  recordedByUsername: 'prueba',
  recordedAt: '2026-10-05T14:00:00.000Z',
  updatedAt: '2026-10-05T14:00:00.000Z',
  sessionId: null,
  resolvedAt: null,
  ...parcial,
});

const detalle = (
  findings: Record<string, ToothFindingRecord[]>,
): Pick<OdontogramDetail, 'findings'> => ({ findings });

describe('lectura del odontograma (captura por excepción)', () => {
  it('la pieza que no tiene fila está sana', () => {
    expect(findingsForTooth(detalle({}), 16)).toEqual([]);
    expect(findingsForTooth(null, 16)).toEqual([]);
    expect(toothState(detalle({}), 16)).toBeNull();
  });

  it('devuelve los hallazgos de la pieza pedida y solo los suyos', () => {
    const caries = hallazgo({ surface: 'occlusal', condition: 'caries' });
    const corona = hallazgo({
      surface: null,
      condition: 'corona',
      state: 'completado',
      toothNumber: 26,
    });
    const vista = detalle({ '16': [caries], '26': [corona] });

    expect(findingsForTooth(vista, 16)).toEqual([caries]);
    expect(findingsForTooth(vista, 26)).toEqual([corona]);
    expect(findingsForTooth(vista, 17)).toEqual([]);
    expect(surfaceFinding(vista, 16, 'occlusal')).toEqual(caries);
    expect(surfaceFinding(vista, 16, 'vestibular')).toBeNull();
  });

  it('el estado dominante es pendiente: una boca con trabajo por hacer va en rojo', () => {
    const vista = detalle({
      '16': [
        hallazgo({ surface: 'occlusal', condition: 'caries', state: 'pendiente' }),
        hallazgo({ surface: 'vestibular', condition: 'restauracion', state: 'completado' }),
      ],
      '26': [hallazgo({ surface: 'occlusal', condition: 'restauracion', state: 'completado' })],
    });

    expect(toothState(vista, 16)).toBe('pendiente');
    expect(toothState(vista, 26)).toBe('completado');
  });

  it('el relleno sigue el doc §7.2: rojo pendiente, azul completado, sano sin relleno', () => {
    const vista = detalle({
      '16': [
        hallazgo({ surface: 'occlusal', condition: 'caries', state: 'pendiente' }),
        hallazgo({ surface: 'vestibular', condition: 'restauracion', state: 'completado' }),
      ],
    });

    expect(surfaceFill(vista, 16, 'occlusal')).toBe('#ef4444');
    expect(surfaceFill(vista, 16, 'vestibular')).toBe('#3b82f6');
    expect(surfaceFill(vista, 16, 'lingual')).toBeUndefined();
  });
});

describe('coordenadas del gráfico (cara bajo el puntero)', () => {
  it('en una pieza superior, la parte de arriba es la vestibular', () => {
    expect(pointToSurface(50, 12, false)).toBe('vestibular');
    expect(pointToSurface(50, 50, false)).toBe('occlusal');
    expect(pointToSurface(50, 88, false)).toBe('lingual');
    expect(pointToSurface(12, 50, false)).toBe('mesial');
    expect(pointToSurface(88, 50, false)).toBe('distal');
  });

  it('en una pieza volteada (mandíbula), el punto visual de arriba es la lingual', () => {
    // El grupo se dibuja con `scale(1,-1) translate(0,-100)`: lo que se ve arriba
    // es el `y = 100 - 12` del lienzo del contrato.
    expect(pointToSurface(50, 12, true)).toBe('lingual');
    expect(pointToSurface(50, 50, true)).toBe('occlusal');
    expect(pointToSurface(50, 88, true)).toBe('vestibular');
    // Las caras proximales no cambian con un volteo vertical.
    expect(pointToSurface(12, 50, true)).toBe('mesial');
    expect(pointToSurface(88, 50, true)).toBe('distal');
  });

  it('fuera del lienzo no hay cara: esa pulsación elige la pieza entera', () => {
    expect(pointToSurface(-4, 50, false)).toBeNull();
    expect(pointToSurface(104, 50, false)).toBeNull();
    expect(pointToSurface(50, 126, false)).toBeNull();
    expect(pointToSurface(50, -4, true)).toBeNull();
  });

  /**
   * La comprobación que pidió el odontólogo: que el clic corresponda a lo que se ve.
   *
   * La arcada se dibuja como dos filas con la línea media en el centro, así que en
   * las piezas de la **derecha del paciente** la cara mesial mira a la derecha de la
   * pantalla (hacia la línea media) y en las de la izquierda, a la izquierda. Si el
   * clic no deshace el espejo, la caries se registra en el vecino equivocado.
   */
  it('la cara que se pulsa es la que se ve, también con el espejo de la derecha', () => {
    // Pieza 16 (maxilar, derecha del paciente): mesial a la derecha de la pantalla.
    expect(pointToSurface(50, 12, false, true)).toBe('vestibular');
    expect(pointToSurface(50, 88, false, true)).toBe('lingual');
    expect(pointToSurface(88, 50, false, true)).toBe('mesial');
    expect(pointToSurface(12, 50, false, true)).toBe('distal');

    // Pieza 26 (maxilar, izquierda): sin espejo, la mesial queda a la izquierda.
    expect(pointToSurface(12, 50, false, false)).toBe('mesial');
    expect(pointToSurface(88, 50, false, false)).toBe('distal');

    // Pieza 46 (mandíbula, derecha): las dos transformaciones a la vez —vestibular
    // abajo y mesial a la derecha—, así que el punto se devuelve por la esquina opuesta.
    expect(pointToSurface(50, 90, true, true)).toBe('vestibular');
    expect(pointToSurface(50, 10, true, true)).toBe('lingual');
    expect(pointToSurface(95, 50, true, true)).toBe('mesial');
    expect(pointToSurface(5, 50, true, true)).toBe('distal');

    // Pieza 36 (mandíbula, izquierda): solo el volteo vertical.
    expect(pointToSurface(50, 90, true, false)).toBe('vestibular');
    expect(pointToSurface(12, 50, true, false)).toBe('mesial');
  });
});

describe('etiqueta accesible de la pieza', () => {
  it('la pieza sana se anuncia como sana', () => {
    expect(toothAriaLabel(16, [])).toBe('Pieza 16 sana');
  });

  it('nombra la condición, la cara y el estado', () => {
    expect(toothAriaLabel(16, [hallazgo({})])).toBe('Pieza 16, caries oclusal pendiente');
    expect(
      toothAriaLabel(16, [
        hallazgo({ surface: 'vestibular', condition: 'restauracion', state: 'completado' }),
      ]),
    ).toBe('Pieza 16, obturación vestibular completado');
  });

  it('las condiciones de pieza completa se anuncian como tales', () => {
    expect(toothAriaLabel(18, [hallazgo({ surface: null, condition: 'ausente' })])).toBe(
      'Pieza 18, ausente (pieza completa) pendiente',
    );
    expect(
      toothAriaLabel(16, [
        hallazgo({}),
        hallazgo({ surface: null, condition: 'corona', state: 'completado' }),
      ]),
    ).toBe('Pieza 16, caries oclusal pendiente, corona (pieza completa) completado');
  });
});

describe('marcadores de pieza completa en el dibujo (capas, spec §6)', () => {
  const corona = hallazgo({
    id: 'corona-1',
    surface: null,
    condition: 'corona',
    state: 'completado',
  });
  const conducto = hallazgo({ id: 'endo-1', surface: null, condition: 'endodoncia' });

  it('la pieza sana no lleva marcador', () => {
    expect(markerSlots([])).toEqual([]);
    expect(markerSlots([hallazgo({})])).toEqual([]);
  });

  it('con un solo tratamiento ocupa la pieza entera', () => {
    const [slot] = markerSlots([corona]);
    expect(slot).toMatchObject({
      condition: 'corona',
      layer: 'periferia',
      cx: 50,
      cy: 50,
      scale: 1,
    });
  });

  /**
   * La composición es por **capas**, no en fila: la corona rodea la casilla y el
   * conducto va en el centro, encogido para caber dentro del círculo. Antes se
   * repartían el hueco en horizontal y el triángulo quedaba deformado.
   */
  it('corona y conducto conviven: el círculo rodea y el triángulo va al centro', () => {
    const slots = markerSlots([corona, conducto]);
    expect(slots.map((slot) => slot.condition)).toEqual(['corona', 'endodoncia']);
    expect(slots.map((slot) => slot.layer)).toEqual(['periferia', 'centro']);
    expect(slots.map((slot) => slot.cx)).toEqual([50, 50]);
    expect(slots.map((slot) => slot.scale)).toEqual([1, 0.62]);
  });

  it('los marcadores se ordenan por capa, no por orden de llegada', () => {
    const slots = markerSlots([
      conducto,
      corona,
      hallazgo({ id: 'ausente-1', surface: null, condition: 'ausente' }),
    ]);
    expect(slots.map((slot) => slot.condition)).toEqual(['ausente', 'corona', 'endodoncia']);
    expect(slots.map((slot) => slot.layer)).toEqual(['aspa', 'periferia', 'centro']);
  });

  it('la extracción indicada va en la capa overlay, por encima de todo', () => {
    const slots = markerSlots([
      hallazgo({ id: 'extraccion-1', surface: null, condition: 'extraccion_indicada' }),
      corona,
    ]);
    expect(slots.map((slot) => slot.layer)).toEqual(['periferia', 'overlay']);
    expect(slots[slots.length - 1]?.condition).toBe('extraccion_indicada');
  });

  it('el implante comparte el centro con su corona sin deformarse', () => {
    const implante = hallazgo({ id: 'implante-1', surface: null, condition: 'implante' });
    const slots = markerSlots([corona, implante]);
    expect(slots.map((slot) => slot.layer)).toEqual(['periferia', 'centro']);
    // El tornillo se encoge para caber dentro del círculo de la corona.
    expect(slots.map((slot) => slot.scale)).toEqual([1, 0.62]);
  });

  /**
   * El servidor admite `ausente` + `implante` (fase quirúrgica: sin corona natural y
   * con implante). En el dibujo manda el tornillo: el aspa encima sería ruido.
   */
  it('con implante presente, el aspa de la pieza ausente no se dibuja', () => {
    const implante = hallazgo({ id: 'implante-2', surface: null, condition: 'implante' });
    const ausente = hallazgo({ id: 'ausente-2', surface: null, condition: 'ausente' });

    expect(markerSlots([ausente]).map((slot) => slot.condition)).toEqual(['ausente']);
    expect(markerSlots([implante, ausente]).map((slot) => slot.condition)).toEqual(['implante']);
    // Y al quedarse solo, ocupa la pieza entera otra vez.
    expect(markerSlots([implante, ausente])[0]?.scale).toBe(1);
    // Una caries de cara no tiene nada que ver con esto.
    expect(
      markerSlots([ausente, hallazgo({ surface: 'occlusal' })]).map((s) => s.condition),
    ).toEqual(['ausente']);
  });
});
