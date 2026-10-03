import { PROBLEM_CONTENT_TYPE, type ProblemFieldError } from '@odontocrm/contracts';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';

import { AppError, NotFoundError, toProblemDetails, ValidationError } from './errors.js';
import { registerHealthRoutes, type HealthCheck } from './health.js';
import { buildLoggerOptions } from './logger.js';

export interface BuildServerOptions {
  /** Nombre del servicio tal como aparece en logs y en `/health`. */
  service: string;
  version: string;
  logLevel: string;
  prettyLogs?: boolean;
  production?: boolean;
  checks?: HealthCheck[];
  bodyLimitBytes?: number;
}

const DEFAULT_BODY_LIMIT = 2 * 1024 * 1024;

const validationErrorsFrom = (error: FastifyError): ProblemFieldError[] =>
  (error.validation ?? []).map((issue) => ({
    path: issue.instancePath === '' ? '(cuerpo)' : issue.instancePath,
    message: issue.message ?? 'valor inválido',
    ...(issue.keyword === undefined ? {} : { code: issue.keyword }),
  }));

const normalizeError = (error: FastifyError): AppError => {
  if (error instanceof AppError) return error;

  if (error.validation !== undefined && error.validation.length > 0) {
    return new ValidationError('Los datos enviados no son válidos', validationErrorsFrom(error));
  }

  const status = typeof error.statusCode === 'number' ? error.statusCode : 500;
  return new AppError({
    status: status >= 400 && status <= 599 ? status : 500,
    code: status === 404 ? 'not_found' : 'request_error',
    message: error.message,
    expose: status < 500,
    cause: error,
  });
};

/**
 * Construye el servidor Fastify con el comportamiento común a todos los
 * servicios: logger con datos censurados, id de petición, errores en formato
 * RFC 7807 y endpoints de salud.
 */
export const buildServer = (options: BuildServerOptions): FastifyInstance => {
  const production = options.production ?? false;

  const app = Fastify({
    logger: buildLoggerOptions({
      service: options.service,
      level: options.logLevel,
      pretty: options.prettyLogs ?? false,
    }),
    genReqId: () => randomUUID(),
    bodyLimit: options.bodyLimitBytes ?? DEFAULT_BODY_LIMIT,
    trustProxy: false,
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const appError = normalizeError(error);
    const context = { requestId: String(request.id), code: appError.code };

    if (appError.status >= 500) {
      request.log.error({ ...context, err: error }, 'Error no controlado');
    } else {
      request.log.warn(context, appError.message);
    }

    const problem = toProblemDetails(appError, {
      requestId: String(request.id),
      instance: request.url,
      production,
    });

    void reply.status(appError.status).type(PROBLEM_CONTENT_TYPE).send(problem);
  });

  app.setNotFoundHandler((request, reply) => {
    const error = new NotFoundError(`Ruta no encontrada: ${request.method} ${request.url}`);
    const problem = toProblemDetails(error, {
      requestId: String(request.id),
      instance: request.url,
      production,
    });
    void reply.status(error.status).type(PROBLEM_CONTENT_TYPE).send(problem);
  });

  registerHealthRoutes(app, {
    service: options.service,
    version: options.version,
    checks: options.checks ?? [],
    production,
  });

  return app;
};

/** Arranca el servidor y registra el apagado ordenado. */
export const startServer = async (
  app: FastifyInstance,
  options: { port: number; host: string },
): Promise<string> => {
  const address = await app.listen({ port: options.port, host: options.host });

  const shutdown = (signal: string): void => {
    app.log.info({ signal }, 'Cerrando el servicio…');
    app
      .close()
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        app.log.error({ err: error }, 'Error al cerrar el servicio');
        process.exit(1);
      });
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      shutdown(signal);
    });
  }

  return address;
};
