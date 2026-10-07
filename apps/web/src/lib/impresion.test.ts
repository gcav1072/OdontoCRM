import { describe, expect, it } from 'vitest';

import {
  aplicarTemaClaro,
  cssDePagina,
  MARGEN_MAX_MM,
  MARGEN_MIN_MM,
  MARGEN_POR_DEFECTO_MM,
  normalizarMargen,
  restaurarTema,
  type RaizConTema,
} from './impresion';

/**
 * El tema oscuro se activa con la clase `dark` en `<html>`. Las páginas imprimibles
 * la quitan mientras están montadas para que el papel salga con la paleta clara: en
 * modo oscuro, el odontograma impreso salía con las líneas claras sobre blanco y los
 * dibujos casi invisibles.
 */
const raizFalsa = (teniaOscuro: boolean): RaizConTema & { clases: Set<string> } => {
  const clases = new Set<string>(teniaOscuro ? ['dark'] : []);
  return {
    clases,
    classList: {
      contains: (clase) => clases.has(clase),
      add: (clase) => void clases.add(clase),
      remove: (clase) => void clases.delete(clase),
    },
  };
};

describe('tema claro para imprimir', () => {
  it('quita el tema oscuro y recuerda que estaba puesto', () => {
    const raiz = raizFalsa(true);

    const estabaOscuro = aplicarTemaClaro(raiz);

    expect(estabaOscuro).toBe(true);
    expect(raiz.clases.has('dark')).toBe(false);
  });

  it('al salir devuelve el tema oscuro que tenía el usuario', () => {
    const raiz = raizFalsa(true);
    const estabaOscuro = aplicarTemaClaro(raiz);

    restaurarTema(raiz, estabaOscuro);

    expect(raiz.clases.has('dark')).toBe(true);
  });

  it('si el usuario estaba en tema claro, no se le activa el oscuro al salir', () => {
    const raiz = raizFalsa(false);

    const estabaOscuro = aplicarTemaClaro(raiz);
    restaurarTema(raiz, estabaOscuro);

    expect(raiz.clases.has('dark')).toBe(false);
  });

  it('no toca otras clases del documento', () => {
    const raiz = raizFalsa(true);
    raiz.classList.add('otra-clase');

    aplicarTemaClaro(raiz);
    restaurarTema(raiz, true);

    expect(raiz.clases.has('otra-clase')).toBe(true);
    expect(raiz.clases.has('dark')).toBe(true);
  });
});

/**
 * El margen del papel: se ajusta desde la vista de impresión y tiene que quedar siempre
 * dentro de lo imprimible. Una tecla de más no puede dejar el documento sin margen ni
 * empujarlo fuera de la hoja.
 */
describe('el margen de impresión', () => {
  it('acepta un margen válido, venga como número o como lo tecleado', () => {
    expect(normalizarMargen(20)).toBe(20);
    expect(normalizarMargen('12')).toBe(12);
  });

  it('recorta lo que se sale de los límites', () => {
    expect(normalizarMargen(0)).toBe(MARGEN_MIN_MM);
    expect(normalizarMargen(999)).toBe(MARGEN_MAX_MM);
    expect(normalizarMargen('-4')).toBe(MARGEN_MIN_MM);
  });

  it('un campo vacío o sin número vuelve al margen por defecto', () => {
    expect(normalizarMargen('')).toBe(MARGEN_POR_DEFECTO_MM);
    expect(normalizarMargen('abc')).toBe(MARGEN_POR_DEFECTO_MM);
    expect(normalizarMargen(Number.NaN)).toBe(MARGEN_POR_DEFECTO_MM);
  });

  it('la hoja es carta y lleva el margen elegido', () => {
    expect(cssDePagina(18)).toBe('@page { size: letter; margin: 18mm; }');
  });

  it('la regla también normaliza: nunca sale sin margen ni fuera de rango', () => {
    expect(cssDePagina(0)).toBe(`@page { size: letter; margin: ${String(MARGEN_MIN_MM)}mm; }`);
    expect(cssDePagina(999)).toBe(`@page { size: letter; margin: ${String(MARGEN_MAX_MM)}mm; }`);
  });
});
