import cors from '@fastify/cors';
import httpProxy from '@fastify/http-proxy';
import rateLimit from '@fastify/rate-limit';
import { buildServer, isProduction, loadPublicKey } from '@odontocrm/kernel';
import type { FastifyInstance } from 'fastify';

import { registerAuthGuard } from './auth-guard.js';
import { jwtPublicKeyPath, origenesPermitidos, type GatewayConfig } from './config.js';
import { buildSystemMeta } from './meta.js';
import { buildUpstreamChecks } from './upstreams.js';
import { buildProxyRoutes } from './routes.js';

export interface CreateGatewayServerOptions {
  config: GatewayConfig;
  /** Clave pública opcional (en las pruebas se inyecta una generada al vuelo). */
  publicKey?: Awaited<ReturnType<typeof loadPublicKey>>;
}

/**
 * Gateway: punto único de entrada. Verifica el JWT de acceso, publica la
 * identidad en cabeceras internas, limita peticiones y reenvía al servicio que
 * corresponde según el recurso.
 *
 * El gateway **no tiene base de datos**: es solo borde (proxy, CORS, límites y
 * validación de tokens). Cualquier estado vive en identity.
 */
export const createGatewayServer = async (
  options: CreateGatewayServerOptions,
): Promise<FastifyInstance> => {
  const { config } = options;

  const app = buildServer({
    service: 'gateway',
    version: config.SERVICE_VERSION,
    logLevel: config.LOG_LEVEL,
    prettyLogs: config.LOG_PRETTY,
    production: isProduction(config),
    // El `/ready` de la puerta mira a sus servicios: sin ellos no hay nada que
    // enrutar y el tablero de estado tiene que verlo (Fase 10).
    checks: buildUpstreamChecks(config),
  });

  const publicKey = options.publicKey ?? (await loadPublicKey(jwtPublicKeyPath(config)));
  registerAuthGuard(app, publicKey);

  await app.register(cors, {
    origin: origenesPermitidos(config.WEB_ORIGIN),
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  });

  await app.register(rateLimit, {
    max: 600,
    timeWindow: '1 minute',
  });

  /**
   * Estado del sistema, público y propio de la puerta (no se proxya a ningún
   * servicio): la interfaz lo pide al arrancar para saber si tiene que pintar el
   * banner de MODO TEST, incluso en la pantalla de acceso.
   */
  app.get('/api/v1/meta', async () => buildSystemMeta(config));

  for (const route of buildProxyRoutes(config)) {
    // Cada ruta en su propio ámbito para poder declarar el mismo plugin varias
    // veces con prefijos distintos.
    await app.register(async (scope) => {
      await scope.register(httpProxy, {
        upstream: route.upstream,
        prefix: route.prefix,
        // `@fastify/http-proxy` usa '' como reemplazo por defecto (recortaría la
        // ruta); aquí se conserva salvo que la ruta indique otra cosa.
        rewritePrefix: route.rewritePrefix ?? route.prefix,
      });
    });
    app.log.info({ prefix: route.prefix, upstream: route.upstream }, route.description);
  }

  return app;
};
