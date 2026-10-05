import {
  generateKeyPairPem,
  importPrivateKeyPem,
  importPublicKeyPem,
  signAccessToken,
} from '@odontocrm/kernel';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { FastifyInstance } from 'fastify';

import { loadGatewayConfig } from './config.js';
import { isPublicPath, pathOf } from './auth-guard.js';
import { buildProxyRoutes } from './routes.js';
import { createGatewayServer } from './server.js';

const baseEnv = { IDENTITY_URL: 'http://127.0.0.1:4001', LOG_LEVEL: 'silent' };

describe('mapa de rutas del gateway', () => {
  it('registra los prefijos de identity y solo los servicios configurados', () => {
    const routes = buildProxyRoutes(loadGatewayConfig(baseEnv));

    expect(routes.map((route) => route.prefix)).toEqual([
      '/api/v1/auth/health',
      '/api/v1/auth',
      '/api/v1/users',
      '/api/v1/audit',
      '/api/v1/devices',
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

    expect(routes).toHaveLength(14);
    expect(routes.map((route) => route.prefix)).toContain('/api/v1/screens');
  });

  it('trata una URL vacía como «servicio todavía no implementado»', () => {
    const routes = buildProxyRoutes(loadGatewayConfig({ ...baseEnv, PATIENTS_URL: '' }));
    expect(routes.map((route) => route.prefix)).not.toContain('/api/v1/patients');
  });

  it('conserva la ruta salvo en el alias de salud, que se reescribe', () => {
    const routes = buildProxyRoutes(loadGatewayConfig(baseEnv));
    const health = routes.find((route) => route.prefix === '/api/v1/auth/health');
    const auth = routes.find((route) => route.prefix === '/api/v1/auth');

    expect(health?.rewritePrefix).toBe('/health');
    expect(auth?.rewritePrefix).toBeUndefined();
  });

  it('clasifica las rutas públicas (salud, ciclo de autenticación, webhooks y verificación)', () => {
    expect(isPublicPath('/health')).toBe(true);
    // El estado del sistema lo pide la SPA antes de iniciar sesión (banner MODO TEST).
    expect(isPublicPath('/api/v1/meta')).toBe(true);
    expect(isPublicPath('/api/v1/auth/login')).toBe(true);
    expect(isPublicPath('/api/v1/auth/refresh')).toBe(true);
    expect(isPublicPath('/api/v1/auth/logout')).toBe(true);
    // El webhook de WhatsApp no lleva JWT: lo valida la firma del proveedor.
    expect(isPublicPath('/api/v1/notifications/webhook/whatsapp')).toBe(true);
    expect(isPublicPath('/api/v1/notifications/webhook/telegram')).toBe(true);
    // El QR del récipe lo abre cualquiera con el papel en la mano, sin sesión.
    expect(isPublicPath('/api/v1/clinical/verify/ABCDE-FGHJK')).toBe(true);
    expect(isPublicPath('/api/v1/users')).toBe(false);
    expect(isPublicPath('/api/v1/auth/me')).toBe(false);
    expect(isPublicPath('/api/v1/notifications')).toBe(false);
    // Los récipes del paciente y sus adjuntos sí exigen sesión.
    expect(isPublicPath('/api/v1/clinical/prescriptions/abc')).toBe(false);
    expect(isPublicPath('/api/v1/clinical/sessions/abc/attachments')).toBe(false);
    expect(pathOf('/api/v1/users?page=2')).toBe('/api/v1/users');
  });
});

describe('gateway: proxy y guardia de autenticación', () => {
  let upstream: Server;
  let gateway: FastifyInstance;
  let gatewayUrl = '';
  let token = '';
  let otherToken = '';
  let userId = '';

  const identityHeaders = (extra: Record<string, string> = {}): Record<string, string> => ({
    authorization: `Bearer ${token}`,
    ...extra,
  });

  beforeAll(async () => {
    const pair = await generateKeyPairPem();
    const publicKey = await importPublicKeyPem(pair.publicPem);
    const privateKey = await importPrivateKeyPem(pair.privatePem);
    const otherPair = await generateKeyPairPem();
    const otherPrivateKey = await importPrivateKeyPem(otherPair.privatePem);

    userId = globalThis.crypto.randomUUID();
    const sid = globalThis.crypto.randomUUID();
    const claims = {
      sub: userId,
      username: 'admin',
      fullName: 'Administrador del sistema',
      roles: ['admin'] as const,
      permissions: ['users:manage'] as const,
      mustChangePassword: false,
      sid,
    };

    token = await signAccessToken(
      { ...claims, roles: [...claims.roles], permissions: [...claims.permissions] },
      { privateKey },
    );
    otherToken = await signAccessToken(
      { ...claims, roles: [...claims.roles], permissions: [...claims.permissions] },
      { privateKey: otherPrivateKey },
    );

    // Servicio simulado: devuelve la ruta recibida y las cabeceras de identidad.
    upstream = createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          origen: 'identidad-simulada',
          metodo: request.method,
          url: request.url,
          identidad: {
            usuario: request.headers['x-user-id'] ?? null,
            nombre: request.headers['x-user-username'] ?? null,
            roles: request.headers['x-user-roles'] ?? null,
            permisos: request.headers['x-user-permissions'] ?? null,
            sesion: request.headers['x-session-id'] ?? null,
            cambioPendiente: request.headers['x-user-must-change-password'] ?? null,
          },
        }),
      );
    });

    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const address = upstream.address() as AddressInfo;

    gateway = await createGatewayServer({
      config: loadGatewayConfig({
        ...baseEnv,
        IDENTITY_URL: `http://127.0.0.1:${String(address.port)}`,
      }),
      publicKey,
    });
    gatewayUrl = await gateway.listen({ port: 0, host: '127.0.0.1' });
  });

  afterAll(async () => {
    await gateway.close();
    await new Promise<void>((resolve, reject) => {
      upstream.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it('deja pasar la salud pública y reescribe la ruta del alias', async () => {
    const response = await fetch(`${gatewayUrl}/api/v1/auth/health`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ url: '/health' });
  });

  it('expone su propio /health sin pasar por el proxy', async () => {
    const response = await fetch(`${gatewayUrl}/health`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ service: 'gateway' });
  });

  it('publica /api/v1/meta sin sesión y sin pasar por el proxy', async () => {
    const response = await fetch(`${gatewayUrl}/api/v1/meta`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      service: 'gateway',
      environment: 'development',
      testMode: { enabled: false, state: 'disabled' },
      fixtures: { seed: 'odontocrm-2026' },
    });
  });

  it('con el modo test activo, /api/v1/meta lo dice', async () => {
    const conModoTest = await createGatewayServer({
      config: loadGatewayConfig({
        ...baseEnv,
        TEST_MODE: 'true',
        ALLOW_TEST_MODE: 'true',
      }),
      publicKey: await importPublicKeyPem((await generateKeyPairPem()).publicPem),
    });
    const url = await conModoTest.listen({ port: 0, host: '127.0.0.1' });

    try {
      const response = await fetch(`${url}/api/v1/meta`);
      await expect(response.json()).resolves.toMatchObject({
        testMode: { enabled: true, state: 'enabled' },
      });
    } finally {
      await conModoTest.close();
    }
  });

  it('exige token en las rutas de la API (401 en problem+json)', async () => {
    const response = await fetch(`${gatewayUrl}/api/v1/users`);

    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
  });

  it('rechaza un token firmado con otra clave', async () => {
    const response = await fetch(`${gatewayUrl}/api/v1/users`, {
      headers: { authorization: `Bearer ${otherToken}` },
    });

    expect(response.status).toBe(401);
  });

  it('con token válido reenvía al servicio y publica la identidad', async () => {
    const response = await fetch(`${gatewayUrl}/api/v1/users`, { headers: identityHeaders() });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      url: string;
      identidad: Record<string, string | null>;
    };

    // Las rutas se conservan (identity es dueño de /api/v1/users).
    expect(body.url).toBe('/api/v1/users');
    expect(body.identidad).toMatchObject({
      usuario: userId,
      nombre: 'admin',
      roles: 'admin',
      permisos: 'users:manage',
      cambioPendiente: 'false',
    });
  });

  it('borra las cabeceras de identidad que intente enviar el cliente', async () => {
    const response = await fetch(`${gatewayUrl}/api/v1/users`, {
      headers: identityHeaders({ 'x-user-id': 'inventado', 'x-user-roles': 'admin' }),
    });
    const body = (await response.json()) as { identidad: Record<string, string | null> };

    expect(body.identidad['usuario']).toBe(userId);
  });

  it('no permite suplantar identidad sin token', async () => {
    const response = await fetch(`${gatewayUrl}/api/v1/users`, {
      headers: { 'x-user-id': globalThis.crypto.randomUUID(), 'x-user-roles': 'admin' },
    });

    expect(response.status).toBe(401);
  });

  it('con token válido, una ruta desconocida responde 404 en problem+json', async () => {
    const response = await fetch(`${gatewayUrl}/api/v1/inventado`, { headers: identityHeaders() });

    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
  });
});
