import type { HealthReport } from '@odontocrm/contracts';
import type pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';

import { ConfigError } from '@odontocrm/kernel';

import { loadIdentityConfig } from './config.js';
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

const openServers: Array<ReturnType<typeof createIdentityServer>> = [];

const buildServerWith = (
  behaviour: 'ok' | 'fail',
  env: Record<string, string> = {},
): ReturnType<typeof createIdentityServer> => {
  const config = loadIdentityConfig({ ...baseEnv, ...env });
  const app = createIdentityServer({ config, pool: fakePool(behaviour) });
  openServers.push(app);
  return app;
};

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((app) => app.close()));
});

describe('configuración de identity', () => {
  it('aplica puerto y host por defecto del servicio', () => {
    const config = loadIdentityConfig(baseEnv);
    expect(config.IDENTITY_PORT).toBe(4001);
    expect(config.IDENTITY_HOST).toBe('127.0.0.1');
    expect(config.DATABASE_POOL_MAX).toBe(10);
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
    const response = await buildServerWith('ok').inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ service: 'identity', version: '0.1.0', status: 'ok' });
  });

  it('/ready confirma la conexión a PostgreSQL', async () => {
    const response = await buildServerWith('ok').inject({ method: 'GET', url: '/ready' });
    const report = response.json<HealthReport>();

    expect(response.statusCode).toBe(200);
    expect(report.checks).toEqual([expect.objectContaining({ name: 'database', status: 'ok' })]);
  });

  it('/ready devuelve 503 si la base no responde, sin filtrar credenciales', async () => {
    const response = await buildServerWith('fail', { NODE_ENV: 'production' }).inject({
      method: 'GET',
      url: '/ready',
    });
    const report = response.json<HealthReport>();

    expect(response.statusCode).toBe(503);
    expect(report.status).toBe('error');
    expect(response.body).not.toContain('password authentication failed');
    expect(response.body).toContain('Dependencia no disponible');
  });
});
