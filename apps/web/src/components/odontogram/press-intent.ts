import type { ToothSurface } from '@odontocrm/contracts';

/**
 * Qué hace pulsar una pieza del odontograma, según el modo de captura.
 *
 * - `abrir-hoja`: modo por **toques** (el de por defecto, en PC y en móvil). Pulsar
 *   la pieza abre su hoja de botones; si el toque acertó una cara, entra marcada.
 * - `elegir-pieza` / `marcar-cara`: **modo teclado** (avanzado, opt-in). La pulsación
 *   alimenta la barra de carga rápida: fuera de las caras elige la pieza; sobre una
 *   cara, la marca.
 *
 * Pura: la usa el panel para no repetir el `if` en el manejador del clic y poder
 * probarla aparte.
 */
export type PressIntent = 'abrir-hoja' | 'elegir-pieza' | 'marcar-cara';

export const pressIntent = (modoTeclado: boolean, surface: ToothSurface | null): PressIntent => {
  if (!modoTeclado) return 'abrir-hoja';
  return surface === null ? 'elegir-pieza' : 'marcar-cara';
};
