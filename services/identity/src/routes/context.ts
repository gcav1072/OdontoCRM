import { REFRESH_COOKIE_NAME, REFRESH_TOKEN_TTL_SECONDS } from '@odontocrm/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type { IdentityConfig } from '../config.js';
import type { SessionContext } from '../security/session.js';

/**
 * La cookie de refresco solo se envía a los endpoints de autenticación: si el
 * navegador no la manda a ningún otro sitio, el riesgo de CSRF baja al mínimo.
 */
export const REFRESH_COOKIE_PATH = '/api/v1/auth';

export interface RequestContext extends SessionContext {
  requestId: string | null;
}

export const requestContext = (request: FastifyRequest): RequestContext => ({
  ip: request.ip ?? null,
  userAgent:
    typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
  requestId: request.id,
});

export const setRefreshCookie = (
  reply: FastifyReply,
  config: IdentityConfig,
  token: string,
  expiresAt: Date,
): void => {
  reply.setCookie(REFRESH_COOKIE_NAME, token, {
    path: REFRESH_COOKIE_PATH,
    httpOnly: true,
    sameSite: 'lax',
    secure: config.COOKIE_SECURE,
    maxAge: Math.max(1, Math.floor((expiresAt.getTime() - Date.now()) / 1000)),
    ...(config.COOKIE_DOMAIN === undefined ? {} : { domain: config.COOKIE_DOMAIN }),
  });
};

export const clearRefreshCookie = (reply: FastifyReply, config: IdentityConfig): void => {
  reply.clearCookie(REFRESH_COOKIE_NAME, {
    path: REFRESH_COOKIE_PATH,
    httpOnly: true,
    sameSite: 'lax',
    secure: config.COOKIE_SECURE,
    ...(config.COOKIE_DOMAIN === undefined ? {} : { domain: config.COOKIE_DOMAIN }),
  });
};

export const readRefreshCookie = (request: FastifyRequest): string | null => {
  const cookies = request.cookies as Record<string, string | undefined> | undefined;
  const token = cookies?.[REFRESH_COOKIE_NAME];
  return token === undefined || token === '' ? null : token;
};

export const secondsUntil = (date: Date): number =>
  Math.max(1, Math.floor((date.getTime() - Date.now()) / 1000));

export const refreshCookieMaxAge = REFRESH_TOKEN_TTL_SECONDS;
