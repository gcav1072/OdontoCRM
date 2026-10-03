import cors from '@fastify/cors';
import httpProxy from '@fastify/http-proxy';
import rateLimit from '@fastify/rate-limit';
import { buildServer, isProduction } from '@odontocrm/kernel';
import type { FastifyInstance } from 'fastify';

import type { GatewayConfig } from './config.js';
import { buildProxyRoutes } from './routes.js';

export interface CreateGatewayServerOptions {
  config: GatewayConfig;
}

/**
 * Gateway: punto único de entrada. Verifica tokens (Fase 1), limita peticiones
 * y reenvía al servicio que corresponde según el recurso.
 *
 * El gateway **no tiene base de datos**: es solo borde (proxy, CORS, límites y
 * validación de tokens). Cualquier estado que necesite vivirá en identity.
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
    checks: [],
  });

  await app.register(cors, {
    origin: [config.WEB_ORIGIN],
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  });

  await app.register(rateLimit, {
    max: 600,
    timeWindow: '1 minute',
  });

  for (const route of buildProxyRoutes(config)) {
    // Cada ruta en su propio ámbito para poder declarar el mismo plugin varias
    // veces con prefijos distintos.
    await app.register(async (scope) => {
      await scope.register(httpProxy, {
        upstream: route.upstream,
        prefix: route.prefix,
        rewritePrefix: '',
      });
    });
    app.log.info({ prefix: route.prefix, upstream: route.upstream }, route.description);
  }

  return app;
};
