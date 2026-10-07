import { createHash } from 'node:crypto';

import { TEST_MODE_SEED } from '@odontocrm/contracts';

/**
 * Identificadores y huellas del mundo de prueba.
 *
 * Los UUID **no** son aleatorios: se derivan de la semilla y de una clave estable
 * (`patient:<documento>`, `appointment:<clave>`…). Así cada servicio calcula los
 * mismos identificadores sin coordinarse —`patients` inserta al paciente y
 * `clinical` se refiere a él por el mismo UUID— y `seed:reset` puede borrar
 * exactamente lo ficticio en todas las bases.
 *
 * Cambiar la semilla o el algoritmo cambia **todos** los identificadores e
 * invalida las comparaciones históricas de `seed:verify` (ADR 0020).
 */
export const deterministicUuid = (scope: string, key: string): string => {
  const digest = createHash('sha256').update(`${TEST_MODE_SEED}:${scope}:${key}`).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  // Marca de versión 4 y variante RFC 4122: es un UUID legítimo, solo que derivado.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
};

/**
 * Rango reservado de consecutivos ficticios (tickets, récipes, facturas, recibos y
 * notas de crédito). Los reales usan de 1 a 899.999; a partir de 900.000 es «dato de
 * prueba», igual que las cédulas de 90.000.000+. El seed deja cada secuencia
 * apuntando al último consecutivo real.
 */
export const FICTITIOUS_SEQUENCE_MIN = 900_000;

/** JSON con las claves ordenadas: la base de una huella estable. */
export const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));

  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
};

/**
 * Huella corta de un dato del mundo: lo que `seed:verify` compara entre lo
 * generado y lo que hay en las bases. Es un SHA-256 en hexadecimal recortado,
 * suficiente para detectar cualquier diferencia y legible en una consola.
 */
export const fingerprint = (value: unknown, length = 16): string =>
  createHash('sha256').update(canonicalJson(value)).digest('hex').slice(0, length);
