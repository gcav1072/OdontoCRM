import { ACCESS_TOKEN_TTL_SECONDS, accessTokenClaimsSchema, type AccessTokenClaims } from '@odontocrm/contracts';
import { SignJWT, jwtVerify } from 'jose';

import { ALGORITHM, type PrivateKey, type PublicKey } from './keys.js';

export const TOKEN_ISSUER = 'odontocrm';
export const TOKEN_AUDIENCE = 'odontocrm-api';

export type AccessTokenInput = Omit<AccessTokenClaims, 'iss' | 'aud' | 'iat' | 'exp'>;

export interface SignAccessTokenOptions {
  privateKey: PrivateKey;
  ttlSeconds?: number;
  /** Se inyecta en las pruebas para obtener tokens reproducibles. */
  now?: Date;
}

/** Firma el JWT de acceso (15 minutos por defecto, EdDSA). */
export const signAccessToken = async (
  input: AccessTokenInput,
  options: SignAccessTokenOptions,
): Promise<string> => {
  const now = Math.floor((options.now ?? new Date()).getTime() / 1000);
  const ttl = options.ttlSeconds ?? ACCESS_TOKEN_TTL_SECONDS;

  return new SignJWT({ ...input })
    .setProtectedHeader({ alg: ALGORITHM, typ: 'JWT' })
    .setIssuer(TOKEN_ISSUER)
    .setAudience(TOKEN_AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + ttl)
    .sign(options.privateKey);
};

/**
 * Verifica firma, emisor, audiencia y caducidad. Devuelve `null` si el token no
 * sirve, sin filtrar el motivo (el gateway responde 401 genérico).
 */
export const verifyAccessToken = async (
  token: string,
  publicKey: PublicKey,
): Promise<AccessTokenClaims | null> => {
  try {
    const { payload } = await jwtVerify(token, publicKey, {
      issuer: TOKEN_ISSUER,
      audience: TOKEN_AUDIENCE,
    });
    const parsed = accessTokenClaimsSchema.safeParse(payload);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

/** Extrae el token de la cabecera `Authorization: Bearer <token>`. */
export const readBearerToken = (header: string | undefined): string | null => {
  if (header === undefined) return null;
  const match = /^Bearer\s+(?<token>.+)$/i.exec(header.trim());
  return match?.groups?.['token'] ?? null;
};
