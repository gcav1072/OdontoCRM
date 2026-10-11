/**
 * El **encaje a una hoja** del récipe.
 *
 * El récipe es **una sola hoja** partida en dos mitades (farmacia y paciente): el
 * membrete, los medicamentos y la firma tienen que caber en ella. Antes se probaban
 * escalas a ciegas (1 → 0,94 → … → 0,7) contando las hojas del PDF ya compuesto: cuando
 * el documento era más alto que el área imprimible, la escala mínima no bastaba, la hoja
 * seguía partiéndose —a una segunda hoja en blanco— y el récipe salía con la letra
 * encogida *y* con la hoja de más.
 *
 * Ahora se **mide**. El bloque que tiene que caber se mide en el propio navegador con la
 * escala en 1, se calcula la escala que lo hace caber y se comprueba midiendo otra vez.
 * La cuenta es aritmética pura —y por eso se prueba sin navegador—: el navegador solo
 * mide y aplica.
 */

/**
 * Tope inferior de la escala. Por debajo, el texto del récipe deja de leerse: mejor un
 * récipe apretado que un récipe ilegible.
 */
export const MIN_FIT_SCALE = 0.7;

/**
 * Margen de seguridad que se le deja a la hoja, en milímetros: redondeos del navegador
 * entre lo medido y lo paginado. Con la altura mínima holgada de la hoja no se nota.
 */
export const FIT_SAFETY_MM = 4;

/** De milímetros a los píxeles CSS con que mide el navegador (96 px por pulgada). */
export const mmToPx = (mm: number): number => (mm * 96) / 25.4;

/**
 * La escala que hace caber `requiredPx` en `availablePx`: **1** si ya cabe (nunca
 * agranda) y, si no, la proporción que sobra, sin bajar del tope `min`.
 */
export const fitScale = (
  requiredPx: number,
  availablePx: number,
  min: number = MIN_FIT_SCALE,
): number => {
  if (!(availablePx > 0) || requiredPx <= availablePx) return 1;
  return Math.max(min, availablePx / requiredPx);
};

/** Cuántas veces se aprieta la escala si, aun así, lo medido no cabe. */
const MAX_TRIES = 4;

/**
 * La escala definitiva: parte de {@link fitScale} y la aprieta lo justo hasta que lo
 * **medido** cabe en el alto disponible.
 *
 * `medir` es el navegador —aplica la escala y devuelve el alto que ocupa el bloque—; se
 * inyecta para poder probar el bucle sin navegador.
 */
export const fitToAvailable = async (
  medir: (escala: number) => Promise<number>,
  requiredPx: number,
  availablePx: number,
  min: number = MIN_FIT_SCALE,
): Promise<number> => {
  let escala = fitScale(requiredPx, availablePx, min);
  // Si a escala 1 ya cabe, no hay nada que medir: el récipe normal no paga el encaje.
  if (escala === 1) return 1;

  for (let intento = 0; intento < MAX_TRIES; intento += 1) {
    const alto = await medir(escala);
    if (!(alto > availablePx) || escala <= min) return escala;
    // Se aprieta por la proporción que sobra, con un pelo menos para no oscilar.
    escala = Math.max(min, ((escala * availablePx) / alto) * 0.998);
  }
  return escala;
};
