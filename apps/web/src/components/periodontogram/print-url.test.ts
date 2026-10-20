import { describe, expect, it } from 'vitest';

import { withSilhouettesParam } from './print-url';

/**
 * Pruebas del enlace a la impresión. El panel y la página de impresión se comunican
 * solo por la URL: si el parámetro se pierde, el papel sale distinto de lo que se
 * estaba viendo en pantalla.
 */

const RUTA = '/consultorio/paciente-1/periodontograma/imprimir';

describe('withSilhouettesParam', () => {
  it('añade el parámetro a una URL sin query', () => {
    expect(withSilhouettesParam(RUTA, true)).toBe(`${RUTA}?siluetas=1`);
    expect(withSilhouettesParam(RUTA, false)).toBe(`${RUTA}?siluetas=0`);
  });

  it('conserva el examen y la comparación que ya viajaban', () => {
    const url = `${RUTA}?examen=e1&comparacion=e0`;
    expect(withSilhouettesParam(url, false)).toBe(`${RUTA}?examen=e1&comparacion=e0&siluetas=0`);
  });

  it('reemplaza un valor anterior en vez de duplicarlo', () => {
    expect(withSilhouettesParam(`${RUTA}?siluetas=1`, false)).toBe(`${RUTA}?siluetas=0`);
  });

  it('respeta el fragmento', () => {
    expect(withSilhouettesParam(`${RUTA}#hoja-2`, false)).toBe(`${RUTA}?siluetas=0#hoja-2`);
  });
});
