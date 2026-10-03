import { createHash } from 'node:crypto';

/**
 * UUID v5 (SHA-1, determinista) para agregados que **no** tienen identificador
 * propio, como el cupo de un día: su clave natural es la fecha.
 *
 * El sobre de los eventos y la auditoría exigen un UUID, y así el mismo día
 * produce siempre el mismo identificador (los eventos de un día se agrupan y se
 * pueden buscar en la auditoría). No se usa para entidades con id propio.
 */
const NAMESPACE = '6f9619ff-8b86-d011-b42d-00cf4fc964ff';

export const stableUuid = (key: string): string => {
  const bytes = createHash('sha1').update(`${NAMESPACE}:${key}`).digest().subarray(0, 16);
  // Versión 5 y variante RFC 4122, como manda la especificación.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
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

/** Identificador estable del cupo de un día. */
export const dayCapacityId = (date: string): string => stableUuid(`day_capacity:${date}`);
