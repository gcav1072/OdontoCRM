import type { HealthReport } from '@odontocrm/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { buildServer } from './server.js';

const build = (checks: Parameters<typeof buildServer>[0]['checks'] = []) =>
  buildServer({
    service: 'prueba',
    version: '0.1.0',
    logLevel: 'silent',
    checks,
  });

const servers: Array<ReturnType<typeof build>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('endpoints de salud', () => {
  it('/health responde 200 aunque una dependencia falle (el proceso está vivo)', async () => {
    const app = build([{ name: 'database', run: () => Promise.reject(new Error('sin conexión')) }]);
    servers.push(app);

    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ service: 'prueba', status: 'ok' });
  });

  it('/ready responde 200 y lista las verificaciones cuando todo está bien', async () => {
    const app = build([{ name: 'database', run: () => undefined }]);
    servers.push(app);

    const response = await app.inject({ method: 'GET', url: '/ready' });
    const report = response.json<HealthReport>();

    expect(response.statusCode).toBe(200);
    expect(report.status).toBe('ok');
    expect(report.checks).toHaveLength(1);
    expect(report.checks[0]).toMatchObject({ name: 'database', status: 'ok' });
  });

  it('/ready responde 503 cuando una dependencia falla', async () => {
    const app = build([{ name: 'database', run: () => Promise.reject(new Error('sin conexión')) }]);
    servers.push(app);

    const response = await app.inject({ method: 'GET', url: '/ready' });
    const report = response.json<HealthReport>();

    expect(response.statusCode).toBe(503);
    expect(report.status).toBe('error');
    expect(report.checks[0]?.status).toBe('error');
  });

  it('/ready en producción no revela el detalle interno del fallo', async () => {
    const app = buildServer({
      service: 'prueba',
      version: '0.1.0',
      logLevel: 'silent',
      production: true,
      checks: [
        {
          name: 'database',
          run: () => Promise.reject(new Error('password authentication failed for user "odonto"')),
        },
      ],
    });
    servers.push(app);

    const response = await app.inject({ method: 'GET', url: '/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain('password authentication failed');
    expect(response.body).toContain('Dependencia no disponible');
  });

  it('corta una verificación que se queda colgada', async () => {
    const app = build([
      {
        name: 'database',
        timeoutMs: 20,
        run: () => new Promise((resolve) => setTimeout(resolve, 500)),
      },
    ]);
    servers.push(app);

    const response = await app.inject({ method: 'GET', url: '/ready' });
    expect(response.statusCode).toBe(503);
  });
});

describe('manejo de errores', () => {
  it('devuelve 404 en formato problem+json', async () => {
    const app = build();
    servers.push(app);

    const response = await app.inject({ method: 'GET', url: '/no-existe' });

    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.json()).toMatchObject({ status: 404, title: 'No encontrado' });
  });
});
