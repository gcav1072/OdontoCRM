/**
 * Generador pseudoaleatorio **determinista** (algoritmo mulberry32).
 *
 * Es la base del «modo test»: con la misma semilla se obtienen exactamente los
 * mismos pacientes, horas y tickets en cualquier máquina y en cualquier
 * ejecución, así que las pruebas y las demostraciones son reproducibles.
 */
export const TEST_MODE_SEED = 'odontocrm-2026';

/** Hash FNV-1a de 32 bits: convierte una semilla de texto en un entero estable. */
export const hashSeed = (seed: string): number => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
};

export class SeededRandom {
  #state: number;

  constructor(seed: string | number) {
    this.#state = typeof seed === 'number' ? seed >>> 0 : hashSeed(seed);
    if (this.#state === 0) this.#state = 0x9e3779b9;
  }

  /** Número real en [0, 1). */
  next(): number {
    this.#state = (this.#state + 0x6d2b79f5) >>> 0;
    let t = this.#state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  }

  /** Entero entre `min` y `max`, ambos incluidos. */
  int(min: number, max: number): number {
    if (max < min) throw new RangeError(`Rango inválido: ${String(min)}..${String(max)}`);
    return min + Math.floor(this.next() * (max - min + 1));
  }

  bool(probability = 0.5): boolean {
    return this.next() < probability;
  }

  /** Elemento aleatorio de una lista no vacía. */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new RangeError('No se puede elegir de una lista vacía');
    const item = items[this.int(0, items.length - 1)];
    if (item === undefined) throw new RangeError('Índice fuera de la lista');
    return item;
  }

  /** Elemento aleatorio según pesos relativos (los pesos negativos se ignoran). */
  weighted<T>(entries: readonly { value: T; weight: number }[]): T {
    const usable = entries.filter((entry) => entry.weight > 0);
    if (usable.length === 0) throw new RangeError('No hay opciones con peso positivo');

    const total = usable.reduce((sum, entry) => sum + entry.weight, 0);
    let threshold = this.next() * total;
    for (const entry of usable) {
      threshold -= entry.weight;
      if (threshold <= 0) return entry.value;
    }
    const last = usable[usable.length - 1];
    if (last === undefined) throw new RangeError('No hay opciones con peso positivo');
    return last.value;
  }

  /** Copia mezclada de una lista (Fisher-Yates). */
  shuffle<T>(items: readonly T[]): T[] {
    const copy = [...items];
    for (let index = copy.length - 1; index > 0; index -= 1) {
      const swapWith = this.int(0, index);
      const current = copy[index];
      const other = copy[swapWith];
      if (current === undefined || other === undefined) continue;
      copy[index] = other;
      copy[swapWith] = current;
    }
    return copy;
  }

  /** Fecha aleatoria dentro de un rango, con la hora en punto o media hora. */
  dateBetween(from: Date, to: Date): Date {
    const start = from.getTime();
    const end = to.getTime();
    if (end < start) throw new RangeError('El rango de fechas está invertido');
    return new Date(this.int(start, end));
  }
}

export const createRng = (seed: string | number = TEST_MODE_SEED): SeededRandom =>
  new SeededRandom(seed);
