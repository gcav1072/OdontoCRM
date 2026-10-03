import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * Parámetros de scrypt (ADR 0023). N=2^15 con r=8 necesita más memoria que el
 * límite por defecto de Node (32 MB), de ahí `maxmem`.
 */
export const SCRYPT_PARAMS = {
  N: 2 ** 15,
  r: 8,
  p: 1,
  keyLength: 64,
  saltBytes: 16,
  maxmem: 96 * 1024 * 1024,
} as const;

const ALGORITHM = 'scrypt';
const SEPARATOR = '$';

const derive = async (password: string, salt: Buffer): Promise<Buffer> =>
  scryptAsync(password.normalize('NFKC'), salt, SCRYPT_PARAMS.keyLength, {
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
    maxmem: SCRYPT_PARAMS.maxmem,
  });

/**
 * Deriva la contraseña y devuelve el hash con sus parámetros embebidos:
 * `scrypt$N$r$p$sal$hash`. Guardar los parámetros permite subirlos en el futuro
 * sin invalidar las contraseñas existentes.
 */
export const hashPassword = async (password: string): Promise<string> => {
  const salt = randomBytes(SCRYPT_PARAMS.saltBytes);
  const hash = await derive(password, salt);
  return [
    ALGORITHM,
    SCRYPT_PARAMS.N,
    SCRYPT_PARAMS.r,
    SCRYPT_PARAMS.p,
    salt.toString('base64url'),
    hash.toString('base64url'),
  ].join(SEPARATOR);
};

interface ParsedHash {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}

const parseHash = (stored: string): ParsedHash | null => {
  const parts = stored.split(SEPARATOR);
  if (parts.length !== 6) return null;
  const [algorithm, n, r, p, salt, hash] = parts;
  if (algorithm !== ALGORITHM || !n || !r || !p || !salt || !hash) return null;

  const parsed: ParsedHash = {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    salt: Buffer.from(salt, 'base64url'),
    hash: Buffer.from(hash, 'base64url'),
  };

  if (![parsed.N, parsed.r, parsed.p].every((value) => Number.isInteger(value) && value > 0)) {
    return null;
  }
  if (parsed.salt.length === 0 || parsed.hash.length === 0) return null;
  return parsed;
};

/**
 * Verifica una contraseña en tiempo constante. Nunca lanza: si el hash guardado
 * está corrupto, devuelve `false` (y el intento cuenta como fallido).
 */
export const verifyPassword = async (password: string, stored: string): Promise<boolean> => {
  const parsed = parseHash(stored);
  if (parsed === null) return false;

  try {
    const candidate = await scryptAsync(password.normalize('NFKC'), parsed.salt, parsed.hash.length, {
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
      maxmem: SCRYPT_PARAMS.maxmem,
    });
    return timingSafeEqual(candidate, parsed.hash);
  } catch {
    return false;
  }
};

/** Marca de que hace falta re-hashear (parámetros distintos a los actuales). */
export const needsRehash = (stored: string): boolean => {
  const parsed = parseHash(stored);
  if (parsed === null) return true;
  return (
    parsed.N !== SCRYPT_PARAMS.N || parsed.r !== SCRYPT_PARAMS.r || parsed.p !== SCRYPT_PARAMS.p
  );
};

/** Contraseña temporal legible para dictar por teléfono (sin caracteres ambiguos). */
export const generateTemporaryPassword = (length = 14): string => {
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(length);
  let password = '';
  for (const byte of bytes) {
    password += alphabet[byte % alphabet.length];
  }
  return password;
};
