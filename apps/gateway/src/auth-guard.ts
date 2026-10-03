import {
  IDENTITY_HEADERS,
  IDENTITY_HEADER_NAMES,
  type AccessTokenClaims,
} from '@odontocrm/contracts';
import {
  UnauthorizedError,
  readBearerToken,
  verifyAccessToken,
  type PublicKey,
} from '@odontocrm/kernel';
import type { FastifyInstance } from 'fastify';

/**
 * Rutas que no exigen token: salud y el ciclo de autenticación. `logout` es
 * público a propósito: un usuario con el token de acceso caducado debe poder
 * cerrar sesión con su cookie.
 */
export const PUBLIC_PATHS: readonly string[] = [
  '/health',
  '/ready',
  '/api/v1/auth/login',
  '/api/v1/auth/refresh',
  '/api/v1/auth/logout',
  '/api/v1/auth/health',
];

/**
 * Prefijos públicos. El **webhook de los canales** que empujan (WhatsApp Cloud
 * API) es público porque Meta no manda JWT: la seguridad la da la firma
 * (`x-hub-signature-256` con el `app_secret`), que el adaptador verifica antes de
 * procesar nada. El canal va en la ruta (`/webhook/whatsapp`).
 */
export const PUBLIC_PREFIXES: readonly string[] = ['/api/v1/notifications/webhook/'];

export const isPublicPath = (path: string): boolean =>
  PUBLIC_PATHS.includes(path) || PUBLIC_PREFIXES.some((prefix) => path.startsWith(prefix));

/** Ruta sin la cadena de consulta. */
export const pathOf = (url: string): string => {
  const index = url.indexOf('?');
  return index === -1 ? url : url.slice(0, index);
};

const stripIdentityHeaders = (headers: Record<string, unknown>): void => {
  for (const header of IDENTITY_HEADER_NAMES) delete headers[header];
};

const applyIdentityHeaders = (
  headers: Record<string, unknown>,
  claims: AccessTokenClaims,
): void => {
  headers[IDENTITY_HEADERS.userId] = claims.sub;
  headers[IDENTITY_HEADERS.username] = claims.username;
  headers[IDENTITY_HEADERS.roles] = claims.roles.join(',');
  headers[IDENTITY_HEADERS.permissions] = claims.permissions.join(',');
  headers[IDENTITY_HEADERS.mustChangePassword] = String(claims.mustChangePassword);
  headers[IDENTITY_HEADERS.sessionId] = claims.sid;
};

/**
 * Guardia del gateway:
 *  1. borra cualquier cabecera `x-user-*` que venga del cliente (si no, cualquiera
 *     podría inventarse un administrador);
 *  2. deja pasar las rutas públicas;
 *  3. verifica la firma, el emisor, la audiencia y la caducidad del JWT;
 *  4. publica la identidad en cabeceras que los servicios internos ya confían,
 *     porque solo son alcanzables desde aquí (escuchan en 127.0.0.1).
 */
export const registerAuthGuard = (app: FastifyInstance, publicKey: PublicKey): void => {
  app.addHook('onRequest', async (request) => {
    stripIdentityHeaders(request.headers);

    /**
     * `Expect: 100-continue` lo envían clientes como PowerShell
     * (`Invoke-WebRequest`), curl con cuerpos grandes o algunos proxies. undici
     * —el cliente HTTP del proxy— no lo soporta y devolvería 500, así que se
     * elimina: es una optimización de la espera, no un requisito del protocolo.
     */
    delete request.headers.expect;

    const path = pathOf(request.url);
    if (isPublicPath(path)) return;

    const token = readBearerToken(request.headers.authorization);
    if (token === null) {
      throw new UnauthorizedError('Necesitas iniciar sesión para continuar');
    }

    const claims = await verifyAccessToken(token, publicKey);
    if (claims === null) {
      throw new UnauthorizedError('Tu sesión expiró o el token no es válido');
    }

    applyIdentityHeaders(request.headers, claims);
    request.log.debug(
      { userId: claims.sub, roles: claims.roles, path },
      'Identidad verificada y publicada al servicio interno',
    );
  });
};
