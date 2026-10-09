import {
  IDENTITY_HEADERS,
  type Permission,
  type Role,
  ROLES,
  PERMISSIONS,
} from '@odontocrm/contracts';
import type { FastifyRequest } from 'fastify';

import { ForbiddenError, UnauthorizedError } from '../errors.js';

/**
 * Identidad de la petición tal como la dejó el gateway después de validar el
 * token. Los servicios **no** validan JWT: confían en estas cabeceras porque solo
 * son alcanzables desde el gateway (escuchan en 127.0.0.1) y el gateway borra
 * cualquier cabecera `x-user-*` que venga del cliente.
 */
export interface RequestIdentity {
  userId: string;
  username: string;
  roles: Role[];
  permissions: Permission[];
  mustChangePassword: boolean;
  /**
   * Un odontólogo que todavía no completó su perfil: igual que la contraseña temporal,
   * no tiene permisos hasta rellenarlo (solo puede usar las rutas de onboarding).
   */
  needsProfile: boolean;
  /** Sesión actual (familia de tokens de refresco). */
  sessionId?: string;
  /** Presente cuando la petición viene de una pantalla kiosko. */
  deviceId?: string;
}

type HeaderValue = string | string[] | undefined;

const readHeader = (value: HeaderValue): string | undefined => {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
};

const parseList = <T extends string>(value: string | undefined, allowed: readonly T[]): T[] => {
  if (value === undefined || value.trim() === '') return [];
  const parts = value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
  return parts.filter((item): item is T => (allowed as readonly string[]).includes(item));
};

export const parseIdentityHeaders = (
  headers: Record<string, HeaderValue>,
): RequestIdentity | null => {
  const userId = readHeader(headers[IDENTITY_HEADERS.userId]);
  const username = readHeader(headers[IDENTITY_HEADERS.username]);
  if (userId === undefined || userId === '' || username === undefined || username === '') {
    return null;
  }

  const deviceId = readHeader(headers[IDENTITY_HEADERS.deviceId]);
  const sessionId = readHeader(headers[IDENTITY_HEADERS.sessionId]);

  return {
    userId,
    username,
    roles: parseList(readHeader(headers[IDENTITY_HEADERS.roles]), ROLES),
    permissions: parseList(readHeader(headers[IDENTITY_HEADERS.permissions]), PERMISSIONS),
    mustChangePassword: readHeader(headers[IDENTITY_HEADERS.mustChangePassword]) === 'true',
    needsProfile: readHeader(headers[IDENTITY_HEADERS.needsProfile]) === 'true',
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(deviceId === undefined ? {} : { deviceId }),
  };
};

/** Devuelve la identidad o lanza 401. Usar en `preHandler`. */
export const requireIdentity = (request: FastifyRequest): RequestIdentity => {
  const identity = parseIdentityHeaders(request.headers);
  if (identity === null) {
    throw new UnauthorizedError('Necesitas iniciar sesión para realizar esta acción');
  }
  return identity;
};

export const hasPermission = (identity: RequestIdentity, permission: Permission): boolean =>
  identity.roles.includes('admin') || identity.permissions.includes(permission);

/**
 * Exige un permiso concreto. Mientras el usuario deba cambiar su contraseña
 * (`mustChangePassword`) **ningún** permiso queda habilitado: la contraseña
 * temporal solo sirve para cambiarla (la ruta de cambio no usa este guardia).
 *
 * Lo mismo con `needsProfile`: un odontólogo que aún no completó su perfil solo
 * puede usar las rutas de onboarding; cualquier otra cosa queda fuera.
 *
 * ⚠️ La guardia es `async` a propósito: Fastify cuelga la petición si un
 * `preHandler` síncrono de un solo parámetro no llama a `done()`. Al devolver una
 * promesa, Fastify espera su resolución. Hay una prueba que lo vigila.
 */
export const requirePermission =
  (permission: Permission) =>
  async (request: FastifyRequest): Promise<void> => {
    const identity = requireIdentity(request);
    if (identity.mustChangePassword) {
      throw new ForbiddenError('Debes cambiar tu contraseña antes de continuar');
    }
    if (identity.needsProfile) {
      throw new ForbiddenError('Completa tu perfil profesional antes de continuar');
    }
    if (!hasPermission(identity, permission)) {
      throw new ForbiddenError('No tienes permiso para realizar esta acción');
    }
  };

export const requireAnyPermission =
  (permissions: readonly Permission[]) =>
  async (request: FastifyRequest): Promise<void> => {
    const identity = requireIdentity(request);
    if (identity.needsProfile) {
      throw new ForbiddenError('Completa tu perfil profesional antes de continuar');
    }
    if (!permissions.some((permission) => hasPermission(identity, permission))) {
      throw new ForbiddenError('No tienes permiso para realizar esta acción');
    }
  };
