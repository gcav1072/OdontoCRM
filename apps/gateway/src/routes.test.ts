import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { FastifyInstance } from 'fastify';

import { loadGatewayConfig } from './config.js';
import { buildProxyRoutes } from './routes.js';
import { createGatewayServer } from './server.js';

const baseEnv = { IDENTITY_URL: 'http://127.0.0.1:4001' };

describe('mapa de rutas del gateway', () => {
  it('registra solo los servicios configurados', () => {
    const routes = buildProxyRoutes(loadGatewayConfig(baseEnv));
    expect(routes.map((route) => route.prefix)).toEqual([
      '/api/v1/auth',
      '/api/v1/users',
      '/api/v1/audit',
    ]);
  });

  it('registra todos los servicios cuando sus URLs existen', () => {
    const routes = buildProxyRoutes(
      loadGatewayConfig({
        ...baseEnv,
        PATIENTS_URL: 'http://127.0.0.1:4002',
        SCHEDULING_URL: 'http://127.0.0.1:4003',
        NOTIFICATIONS_URL: 'http://127.0.0.1:4004',
        CLINICAL_URL: 'http://127.0.0.1:4005',
        ODONTOGRAM_URL: 'http://127.0.0.1:4006',
        SCREENS_URL: 'http://127.0.0.1:4007',
        REPORTING_URL: 'http://127.0.0.1:4008',
      }),
    );

    expect(routes).toHaveLength(12);
    expect(routes.map((route) => route.prefix)).toContain('/api/v1/screens');
  });

  it('trata una URL vacía como «servicio todavía no implementado»', () => {
    const routes = buildProxyRoutes(loadGatewayConfig({ ...baseEnv, PATIENTS_URL: '' }));
    expect(routes.map((route) => route.prefix)).not.toContain('/api/v1/patients');
  });
});

describe('proxy del gateway (extremo a extremo)', () => {
  let upstream: Server;
  let upstreamUrl = '';
  let gateway: FastifyInstance;
  let gatewayUrl = '';

  beforeAll(async () => {
    upstream = createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ origen: 'identidad-simulada', metodo: request.method, url: request.url }),
      );
    });

    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const address = upstream.address() as AddressInfo;
    upstreamUrl = `http://127.0.0.1:${String(address.port)}`;

    gateway = await createGatewayServer({
      config: loadGatewayConfig({ ...baseEnv, IDENTITY_URL: upstreamUrl, LOG_LEVEL: 'silent' }),
    });
    const gatewayAddress = await gateway.listen({ port: 0, host: '127.0.0.1' });
    gatewayUrl = gatewayAddress;
  });

  afterAll(async () => {
    await gateway.close();
    await new Promise<void>((resolve, reject) => {
      upstream.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it('reenvía al servicio destino quitando el prefijo público', async () => {
    const response = await fetch(`${gatewayUrl}/api/v1/auth/health`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      origen: 'identidad-simulada',
      metodo: 'GET',
      url: '/health',
    });
  });

  it('expone su propio /health sin pasar por el proxy', async () => {
    const response = await fetch(`${gatewayUrl}/health`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ service: 'gateway' });
  });

  it('responde 404 en formato problem+json para rutas desconocidas', async () => {
    const response = await fetch(`${gatewayUrl}/api/v1/inventado`);
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
  });
});
