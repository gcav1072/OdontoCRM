import { describe, expect, it } from 'vitest';

import { aplicarTemaClaro, restaurarTema, type RaizConTema } from './impresion';

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
