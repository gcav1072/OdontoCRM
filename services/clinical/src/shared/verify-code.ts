/**
 * Código de verificación de los documentos que salen del consultorio (el récipe y el
 * dossier del expediente).
 *
 * Vive aparte porque lo usan **dos** documentos con ciclos distintos —el récipe se
 * emite por sesión, el dossier cuando se pide el historial— y tienen que compartir el
 * formato: el alfabeto, el guion que parte el código en dos y la normalización al
 * buscarlo son los mismos, o un código no encontraría su documento.
 *
 * El alfabeto excluye las letras y los números que se confunden al dictarlos por
 * teléfono o al copiarlos de un papel (0/O, 1/I/L).
 */

/** Sin `0`, `O`, `1`, `I` ni `L`: es lo que se dicta y lo que se lee en un QR. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** Diez caracteres aleatorios: ~1.300 billones de combinaciones. */
export const VERIFY_CODE_LENGTH = 10;

/** Código nuevo, con aleatoriedad criptográfica (`crypto.getRandomValues`). */
export const buildVerifyCode = (): string => {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(VERIFY_CODE_LENGTH));
  return [...bytes].map((byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length] ?? 'A').join('');
};

/** El código se muestra y se busca con guion: `ABCDE-FGHJK`. */
export const formatVerifyCode = (code: string): string =>
  code.length === VERIFY_CODE_LENGTH ? `${code.slice(0, 5)}-${code.slice(5)}` : code;

/** Lo que teclea una persona (con guion, en minúsculas, con espacios) → el código guardado. */
export const normalizeVerifyCode = (code: string): string =>
  code.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
