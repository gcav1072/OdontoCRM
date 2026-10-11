import { describe, expect, it, vi } from 'vitest';

import { FIT_SAFETY_MM, MIN_FIT_SCALE, fitScale, fitToAvailable, mmToPx } from './fit-to-page.js';

/**
 * El encaje a una hoja.
 *
 * La cuenta es aritmética pura y aquí se prueba sin navegador: el navegador solo mide y
 * aplica. Es lo que hace que el récipe salga en una sola hoja sin encoger la letra más de
 * lo justo (el fallo reportado: letra pequeña **y** segunda hoja en blanco).
 */

/** Un navegador de mentira: el alto del bloque es proporcional a la escala. */
const medidor = (altoBase: number) => {
  const llamadas: number[] = [];
  return {
    llamadas,
    medir: async (escala: number): Promise<number> => {
      llamadas.push(escala);
      return altoBase * escala;
    },
  };
};

describe('la escala de encaje', () => {
  it('si el documento ya cabe, la escala es 1: nunca agranda un récipe corto', () => {
    expect(fitScale(600, 700)).toBe(1);
    expect(fitScale(700, 700)).toBe(1);
  });

  it('si no cabe, la escala es la proporción que sobra', () => {
    // 800 px de documento en 700 px de hoja: 700/800 = 0,875 (justo lo que sobra, sin más).
    expect(fitScale(800, 700)).toBeCloseTo(0.875, 5);
    // El récipe normal no paga el bucle: 185 mm de hoja en 190 mm útiles no encoge nada.
    expect(fitScale(mmToPx(185), mmToPx(190))).toBe(1);
  });

  it('no baja del tope: por debajo, el texto dejaría de leerse', () => {
    expect(fitScale(5000, 700)).toBe(MIN_FIT_SCALE);
    expect(fitScale(5000, 700, 0.5)).toBe(0.5);
  });

  it('sin alto disponible no encoge (no se inventa una hoja de 0 mm)', () => {
    expect(fitScale(800, 0)).toBe(1);
  });
});

describe('el encaje medido', () => {
  it('a escala 1 ya cabe: no mide nada (el récipe normal no paga el encaje)', async () => {
    const { medir, llamadas } = medidor(600);
    await expect(fitToAvailable(medir, 600, 700)).resolves.toBe(1);
    expect(llamadas).toHaveLength(0);
  });

  it('aprieta lo justo y lo comprueba midiendo', async () => {
    const { medir, llamadas } = medidor(800);
    await expect(fitToAvailable(medir, 800, 700)).resolves.toBeCloseTo(0.875, 3);
    // Una sola comprobación: la primera escala calculada ya cabe (800 × 0,875 = 700).
    expect(llamadas).toHaveLength(1);
  });

  it('si lo medido sigue sin caber, aprieta otra vez', async () => {
    // Un documento que no encoge en proporción (la tabla no refluye igual): con la primera
    // escala sigue midiendo 760 y con la segunda ya cabe.
    const altos = [760, 690];
    let i = 0;
    const medir = async (): Promise<number> => altos[i++] ?? 0;
    const escala = await fitToAvailable(medir, 900, 700);
    // Dos medidas y una escala más apretada que la primera cuenta (700/900 = 0,778).
    expect(i).toBe(2);
    expect(escala).toBeLessThan(700 / 900);
    expect(escala).toBeGreaterThanOrEqual(MIN_FIT_SCALE);
  });

  it('al llegar al tope deja de medir: no insiste con una escala que ya no puede bajar', async () => {
    const medir = vi.fn(async (): Promise<number> => 5000);
    await expect(fitToAvailable(medir, 5000, 700)).resolves.toBe(MIN_FIT_SCALE);
    expect(medir.mock.calls).toHaveLength(1);
  });
});

describe('las medidas del encaje', () => {
  it('convierte milímetros a los píxeles CSS del navegador', () => {
    expect(mmToPx(25.4)).toBeCloseTo(96, 5);
    // El margen de seguridad deja sitio a los redondeos entre lo medido y lo paginado.
    expect(FIT_SAFETY_MM).toBeGreaterThan(0);
  });
});
