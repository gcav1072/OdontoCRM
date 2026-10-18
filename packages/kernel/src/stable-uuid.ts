import { createHash } from 'node:crypto';

/**
 * UUID v5 (SHA-1, determinista) para agregados que **no** tienen identificador propio:
 * el cupo de un día tiene como clave natural la fecha y el consultorio, y la
 * configuración fiscal de la caja es una fila única (`id = 1`, un entero).
 *
 * El sobre de los eventos (`domainEventSchema`) y la carga de auditoría
 * (`domainAuditPayloadSchema`) exigen un `uuid` en `aggregateId`/`entityId`: si se
 * manda otra cosa, `toOutboxInsert` lanza un `ZodError` **dentro de la transacción** y
 * el cambio de datos se revierte entero (fue exactamente el 500 al encender el
 * interruptor del IGTF en `/configuracion`). Derivar el UUID de una clave estable
 * resuelve el contrato sin inventar una tabla de identificadores.
 *
 * Se usa **SHA-1** porque la versión 5 de la RFC 4122 lo manda: no es una firma ni un
 * secreto, solo un identificador reproducible.
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
