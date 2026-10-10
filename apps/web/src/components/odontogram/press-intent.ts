import type { ToothSurface } from '@odontocrm/contracts';

/**
 * Qué hace pulsar una pieza del odontograma, según el modo de captura.
 *
 * - `abrir-hoja`: modo por **toques** (el de por defecto, en PC y en móvil). Pulsar
 *   la pieza abre su hoja de botones; si el toque acertó una cara, entra marcada.
 * - `elegir-pieza` / `marcar-cara`: **modo teclado** (avanzado, opt-in). La pulsación
 *   alimenta la barra de carga rápida: fuera de las caras elige la pieza; sobre una
 *   cara, la marca.
 * - `rango-protesis`: **modo prótesis**. La pulsación elige una pieza para el tramo
 *   de una PPR (primera → última) en vez de abrir su hoja.
 *
 * Pura: la usa el panel para no repetir el `if` en el manejador del clic y poder
 * probarla aparte.
 */
export type PressIntent = 'abrir-hoja' | 'elegir-pieza' | 'marcar-cara' | 'rango-protesis';

export const pressIntent = (
  modoTeclado: boolean,
  surface: ToothSurface | null,
  modoProtesis = false,
): PressIntent => {
  if (modoProtesis) return 'rango-protesis';
  if (!modoTeclado) return 'abrir-hoja';
  return surface === null ? 'elegir-pieza' : 'marcar-cara';
};
