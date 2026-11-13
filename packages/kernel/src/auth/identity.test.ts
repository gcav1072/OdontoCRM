import { describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';

import { ForbiddenError, UnauthorizedError } from '../errors.js';
import {
  hasPermission,
  parseIdentityHeaders,
  requireAnyPermission,
  requireIdentity,
  requirePermission,
  type RequestIdentity,
} from './identity.js';

const headers = (
  overrides: Partial<
    Record<'id' | 'username' | 'roles' | 'permissions' | 'must' | 'sid', string>
  > = {},
): Record<string, string | undefined> => ({
  'x-user-id': overrides.id ?? globalThis.crypto.randomUUID(),
  'x-user-username': overrides.username ?? 'admin',
  'x-user-roles': overrides.roles ?? 'admin',
  'x-user-permissions': overrides.permissions ?? 'users:manage',
  'x-user-must-change-password': overrides.must ?? 'false',
  'x-session-id': overrides.sid ?? globalThis.crypto.randomUUID(),
});

const fakeRequest = (value: Record<string, string | undefined>): FastifyRequest =>
  ({ headers: value }) as unknown as FastifyRequest;

describe('lectura de la identidad publicada por el gateway', () => {
  it('devuelve nulo cuando faltan las cabeceras mínimas', () => {
    expect(parseIdentityHeaders({})).toBeNull();
    expect(parseIdentityHeaders({ 'x-user-id': 'algo' })).toBeNull();
  });

  it('interpreta roles, permisos, sesión y la marca de cambio de contraseña', () => {
    const identity = parseIdentityHeaders(
      headers({
        username: 'recepcion',
        roles: 'secretario,odontologo',
        permissions: 'patients:read, scheduling:write',
        must: 'true',
      }),
    ) as RequestIdentity;

    expect(identity.username).toBe('recepcion');
    expect(identity.roles).toEqual(['secretario', 'odontologo']);
    expect(identity.permissions).toEqual(['patients:read', 'scheduling:write']);
    expect(identity.mustChangePassword).toBe(true);
    expect(identity.sessionId).toBeDefined();
  });

  it('descarta roles o permisos inventados', () => {
    const identity = parseIdentityHeaders(
      headers({ roles: 'admin,superadmin', permissions: 'users:manage,inventado' }),
    ) as RequestIdentity;

    expect(identity.roles).toEqual(['admin']);
    expect(identity.permissions).toEqual(['users:manage']);
  });
});

describe('guardias de permiso', () => {
  it('devuelve una promesa: un preHandler síncrono colgaría la petición en Fastify', async () => {
    const guard = requirePermission('users:manage');
    const result = guard(fakeRequest(headers()));

    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toBeUndefined();
  });

  it('lanza 401 si no hay identidad', async () => {
    await expect(requirePermission('users:manage')(fakeRequest({}))).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });

  it('lanza 403 si falta el permiso', async () => {
    const request = fakeRequest(headers({ roles: 'secretario', permissions: 'patients:read' }));
    await expect(requirePermission('users:manage')(request)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('bloquea cualquier permiso mientras la contraseña esté pendiente de cambiar', async () => {
    const request = fakeRequest(headers({ must: 'true' }));
    await expect(requirePermission('users:manage')(request)).rejects.toThrowError(/contraseña/);
  });

  it('requireAnyPermission acepta una de la lista y el rol admin no sustituye al permiso', async () => {
    // Un token real de admin lleva los permisos del rol (ROLE_PERMISSIONS.admin es el catálogo
    // completo): no hay atajo por rol. En modo consulta el token viene recortado a lectura.
    const request = fakeRequest(
      headers({ roles: 'admin', permissions: 'audit:read,users:manage' }),
    );
    await expect(requirePermission('audit:read')(request)).resolves.toBeUndefined();
    await expect(
      requireAnyPermission(['users:manage', 'audit:read'])(request),
    ).resolves.toBeUndefined();

    const adminRecortado = fakeRequest(headers({ roles: 'admin', permissions: 'patients:read' }));
    await expect(requirePermission('audit:read')(adminRecortado)).rejects.toBeInstanceOf(
      ForbiddenError,
    );

    const secretario = fakeRequest(headers({ roles: 'secretario', permissions: 'patients:read' }));
    await expect(
      requireAnyPermission(['users:manage', 'audit:read'])(secretario),
    ).rejects.toThrow();
  });

  it('hasPermission manda por los permisos del token, no por el rol (modo consulta)', () => {
    const identity = requireIdentity(
      fakeRequest(headers({ roles: 'odontologo', permissions: '' })),
    );
    expect(identity.roles).toEqual(['odontologo']);
    expect(hasPermission(identity, 'clinical:write')).toBe(false);

    // Un admin normal lleva todos los permisos en el token: sigue pudiendo todo.
    expect(
      hasPermission(
        { ...identity, roles: ['admin'], permissions: ['clinical:write'] },
        'clinical:write',
      ),
    ).toBe(true);

    // Con la licencia vencida el token se recorta aunque el rol siga siendo `admin`:
    // ningún atajo por rol puede devolverle la escritura.
    expect(
      hasPermission(
        { ...identity, roles: ['admin'], permissions: ['clinical:read'] },
        'clinical:write',
      ),
    ).toBe(false);
  });
});
