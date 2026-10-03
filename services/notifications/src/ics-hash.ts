import { createHash } from 'node:crypto';

/**
 * Huella SHA-256 de un `.ics`: se guarda junto al archivo para poder auditarlo y
 * comprobar que no cambió. Vive aquí (en el servicio) y **no** en los contratos
 * porque esos los comparte el navegador y no tiene `node:crypto`.
 */
export const icsSha256 = (content: string): string =>
  createHash('sha256').update(content, 'utf8').digest('hex');
