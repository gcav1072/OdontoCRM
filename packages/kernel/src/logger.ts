import { pino, type Logger, type LoggerOptions } from 'pino';

/**
 * Rutas que nunca se escriben en los logs. Cualquier objeto que las contenga
 * (incluidos los anidados) se censura con `[REDACTADO]`.
 */
export const REDACT_PATHS: readonly string[] = [
  'password',
  'passwordHash',
  'token',
  'accessToken',
  'refreshToken',
  'authorization',
  'cookie',
  'secret',
  'apiKey',
  'connectionString',
  'DATABASE_URL',
  'PG_ADMIN_URL',
  'TELEGRAM_BOT_TOKEN',
  '*.password',
  '*.token',
  '*.secret',
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'headers.cookie',
  'err.config.headers.authorization',
];

export interface CreateLoggerOptions {
  service: string;
  level: string;
  /** Salida legible para desarrollo; en producción siempre JSON. */
  pretty?: boolean;
}

/**
 * Opciones de logger para Fastify (`logger: buildLoggerOptions(...)`). Se separa
 * de `createLogger` para que el tipo del servidor siga siendo el estándar de
 * Fastify y no el de una instancia concreta de pino.
 */
export const buildLoggerOptions = (options: CreateLoggerOptions): LoggerOptions => ({
  name: options.service,
  level: options.level,
  base: { service: options.service },
  redact: { paths: [...REDACT_PATHS], censor: '[REDACTADO]' },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label: string) => ({ level: label }),
  },
  ...(options.pretty === true
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:HH:MM:ss',
            ignore: 'pid,hostname,service',
            messageFormat: '[{service}] {msg}',
          },
        },
      }
    : {}),
});

/**
 * Logger independiente del servidor HTTP (trabajadores, migraciones, scripts).
 * Censura credenciales y nunca imprime el contenido de un `.env`.
 */
export const createLogger = (options: CreateLoggerOptions): Logger =>
  pino(buildLoggerOptions(options));

export type { Logger, LoggerOptions };
