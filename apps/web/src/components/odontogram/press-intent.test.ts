import { describe, expect, it } from 'vitest';

import { pressIntent } from './press-intent';

/**
 * El gesto del odontograma ya no depende del puntero: en todos los dispositivos
 * pulsar una pieza **abre su hoja**. El único corte es el modo teclado (avanzado),
 * que reengancha la pulsación a la barra de carga rápida.
 */
describe('qué hace pulsar una pieza del odontograma', () => {
  it('por defecto abre la hoja de botones, acierte o no una cara', () => {
    expect(pressIntent(false, 'occlusal')).toBe('abrir-hoja');
    expect(pressIntent(false, null)).toBe('abrir-hoja');
  });

  it('en modo teclado alimenta la barra: fuera de las caras elige, sobre una la marca', () => {
    expect(pressIntent(true, null)).toBe('elegir-pieza');
    expect(pressIntent(true, 'vestibular')).toBe('marcar-cara');
  });
});
