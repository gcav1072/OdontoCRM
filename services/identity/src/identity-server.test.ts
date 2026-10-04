import type { HealthReport } from '@odontocrm/contracts';
import {
  ConfigError,
  generateKeyPairPem,
  importPrivateKeyPem,
  type PrivateKey,
} from '@odontocrm/kernel';
import type pg from 'pg';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { loadIdentityConfig } from './config.js';
import type { IdentityDatabaseHandle } from './db/client.js';
import { createIdentityServer } from './server.js';

const baseEnv = {
  DATABASE_URL: 'postgres://odonto_identity:clave@127.0.0.1:5432/odonto_identity',
  IDENTITY_PORT: '4001',
  LOG_LEVEL: 'silent',
};

const fakePool = (behaviour: 'ok' | 'fail'): pg.Pool =>
  ({
    query: () =>
      behaviour === 'ok'
        ? Promise.resolve({ rows: [{ ok: 1 }] })
        : Promise.reject(new Error('password authentication failed for user "odonto_identity"')),
  }) as unknown as pg.Pool;

/** Base de datos simulada: las pruebas de salud no tocan las rutas que la usan. */
const fakeDatabase = (behaviour: 'ok' | 'fail'): IdentityDatabaseHandle =>
  ({
    db: {},
    pool: fakePool(behaviour),
    close: () => Promise.resolve(),
  }) as unknown as IdentityDatabaseHandle;

/**
 * Base simulada **sin usuarios**: `select … from users … limit 1` devuelve vacío (para
 * el login) y la escritura de auditoría revienta, que es justo lo que el servicio
 * tolera (la registra en el log y sigue). Sirve para comprobar el mensaje del login
 * en una base recién creada, sin borrar los usuarios de la base de verdad.
 */
const fakeDatabaseSinUsuarios = (): IdentityDatabaseHandle =>
  ({
    db: {
      select: () => ({
        from: () => ({
          where: () => ({ limit: async () => [] }),
          limit: async () => [],
        }),
      }),
      insert: () => ({
        values: () => Promise.reject(new Error('sin auditoría en la base simulada')),
      }),
    },
    pool: fakePool('ok'),
    close: () => Promise.resolve(),
  }) as unknown as IdentityDatabaseHandle;

/** Cabeceras que en producción inyecta el gateway tras validar el JWT. */
const identityHeaders = (
  overrides: Partial<
    Record<'roles' | 'permissions' | 'mustChangePassword' | 'username', string>
  > = {},
): Record<string, string> => ({
  'x-user-id': globalThis.crypto.randomUUID(),
  'x-user-username': overrides.username ?? 'admin',
  'x-user-roles': overrides.roles ?? 'admin',
  'x-user-permissions': overrides.permissions ?? 'users:manage,audit:read',
  'x-user-must-change-password': overrides.mustChangePassword ?? 'false',
  'x-session-id': globalThis.crypto.randomUUID(),
});

let privateKey: PrivateKey;

beforeAll(async () => {
  const pair = await generateKeyPairPem();
  privateKey = await importPrivateKeyPem(pair.privatePem);
});

const openServers: Awaited<ReturnType<typeof createIdentityServer>>[] = [];

const buildServerWith = async (
  behaviour: 'ok' | 'fail',
  env: Record<string, string> = {},
): Promise<Awaited<ReturnType<typeof createIdentityServer>>> => {
  const config = loadIdentityConfig({ ...baseEnv, ...env });
  const app = await createIdentityServer({
    config,
    database: fakeDatabase(behaviour),
    privateKey,
  });
  openServers.push(app);
  return app;
};

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((app) => app.close()));
});

describe('configuración de identity', () => {
  it('aplica puerto, host y rutas de claves por defecto', () => {
    const config = loadIdentityConfig(baseEnv);
    expect(config.IDENTITY_PORT).toBe(4001);
    expect(config.IDENTITY_HOST).toBe('127.0.0.1');
    expect(config.DATABASE_POOL_MAX).toBe(10);
    expect(config.JWT_PRIVATE_KEY_PATH).toContain('jwt-private.pem');
    expect(config.COOKIE_SECURE).toBe(false);
  });

  it('exige DATABASE_URL con un mensaje claro', () => {
    try {
      loadIdentityConfig({ IDENTITY_PORT: '4001' });
      expect.unreachable('debía lanzar ConfigError');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).missing).toContain('DATABASE_URL');
    }
  });
});

describe('servidor de identity', () => {
  it('/health responde con el nombre y la versión del servicio', async () => {
    const app = await buildServerWith('ok');
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ service: 'identity', version: '0.1.0', status: 'ok' });
  });

  it('/ready confirma la conexión a PostgreSQL', async () => {
    const app = await buildServerWith('ok');
    const response = await app.inject({ method: 'GET', url: '/ready' });
    const report = response.json<HealthReport>();

    expect(response.statusCode).toBe(200);
    expect(report.checks).toEqual([expect.objectContaining({ name: 'database', status: 'ok' })]);
  });

  it('/ready devuelve 503 si la base no responde, sin filtrar credenciales', async () => {
    const app = await buildServerWith('fail', { NODE_ENV: 'production' });
    const response = await app.inject({ method: 'GET', url: '/ready' });

    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain('password authentication failed');
    expect(response.body).toContain('Dependencia no disponible');
  });

  it('/api/v1/auth/health es el alias público que usa el gateway', async () => {
    const app = await buildServerWith('ok');
    const response = await app.inject({ method: 'GET', url: '/api/v1/auth/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ service: 'identity', status: 'ok' });
  });
});

describe('login sin usuarios', () => {
  it('lo dice en vez de culpar a la contraseña (base recién creada o --sin-sembrar)', async () => {
    const config = loadIdentityConfig(baseEnv);
    const app = await createIdentityServer({
      config,
      database: fakeDatabaseSinUsuarios(),
      privateKey,
    });
    openServers.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'admin', password: 'admin-odontocrm-2026' },
    });

    expect(response.statusCode).toBe(401);
    // El código viaja en el `type` del problema (RFC 7807), como en el resto del API.
    const cuerpo = response.json<{ type: string; detail: string }>();
    expect(cuerpo.type).toContain('/errors/no_users');
    expect(cuerpo.detail).toContain('npm run seed:users');
  });
});

describe('autorización de las rutas', () => {
  it('exige identidad: sin cabeceras del gateway responde 401 en problem+json', async () => {
    const app = await buildServerWith('ok');

    const users = await app.inject({ method: 'GET', url: '/api/v1/users' });
    expect(users.statusCode).toBe(401);
    expect(users.headers['content-type']).toContain('application/problem+json');

    const audit = await app.inject({ method: 'GET', url: '/api/v1/audit/events' });
    expect(audit.statusCode).toBe(401);
  });

  it('responde 403 cuando el rol no tiene el permiso', async () => {
    const app = await buildServerWith('ok');
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/users',
      headers: identityHeaders({
        username: 'recepcion',
        roles: 'secretario',
        permissions: 'patients:read,patients:write',
      }),
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ status: 403, title: 'Acceso denegado' });
  });

  it('bloquea todo mientras el usuario deba cambiar su contraseña', async () => {
    const app = await buildServerWith('ok');
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/users',
      headers: identityHeaders({ mustChangePassword: 'true' }),
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ detail: expect.stringContaining('contraseña') });
  });

  it('el endpoint de roles responde el catálogo completo a un administrador', async () => {
    const app = await buildServerWith('ok');
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/users/roles',
      headers: identityHeaders(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ roles: Array<{ name: string; permissions: string[] }> }>();
    expect(body.roles.map((role) => role.name)).toEqual([
      'admin',
      'secretario',
      'odontologo',
      'pantalla',
    ]);
  });

  it('la lista de usuarios valida los filtros antes de tocar la base', async () => {
    const app = await buildServerWith('ok');
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/users?pageSize=9999',
      headers: identityHeaders(),
    });

    // Con la base simulada no se llega a consultar: el filtro inválido corta antes.
    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain('application/problem+json');
  });
});
