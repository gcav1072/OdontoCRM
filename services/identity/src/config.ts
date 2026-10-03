import { baseEnvSchema, loadConfig } from '@odontocrm/kernel';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { z } from 'zod';

/**
 * Raíz del repositorio, calculada desde la ubicación de este archivo (funciona
 * igual desde `src/` en pruebas que desde `dist/` en producción, y con cualquier
 * directorio de trabajo). Los servicios que abren archivos por rutas del `.env`
 * las resuelven con `resolveFromRepoRoot`.
 */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

export const resolveFromRepoRoot = (path: string): string =>
  isAbsolute(path) ? path : resolve(REPO_ROOT, path);

export const identityEnvSchema = baseEnvSchema.extend({
  SERVICE_VERSION: z.string().min(1).default('0.1.0'),
  IDENTITY_HOST: z.string().min(1).default('127.0.0.1'),
  IDENTITY_PORT: z.coerce.number().int().min(1).max(65_535).default(4001),
  /** Cadena de conexión de ESTE servicio; la escribe `npm run db:bootstrap`. */
  DATABASE_URL: z.string().min(1),
  /**
   * Base donde vive la cola de eventos compartida (pg-boss). La escribe el
   * bootstrap como `EVENTS_DATABASE_URL`; si falta, se usa la propia base (solo
   * válido para pruebas de un único servicio).
   */
  EVENTS_DATABASE_URL: z.string().min(1).optional(),
  /** Máximo de conexiones del pool (consultorio pequeño). */
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),

  /** Claves EdDSA del JWT de acceso (ver `npm run keys:generate`). */
  JWT_PRIVATE_KEY_PATH: z.string().min(1).default('./services/identity/.keys/jwt-private.pem'),
  JWT_PUBLIC_KEY_PATH: z.string().min(1).default('./services/identity/.keys/jwt-public.pem'),

  /**
   * La cookie de refresco exige HTTPS cuando está en `true`. En desarrollo sobre
   * http tiene que ser `false`; en producción (TLS interno) siempre `true`.
   */
  COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  COOKIE_DOMAIN: z
    .string()
    .optional()
    .transform((value) => (value === undefined || value === '' ? undefined : value)),

  /** Origen permitido de la SPA (se usa en la comprobación de origen del login). */
  WEB_ORIGIN: z.string().min(1).default('http://127.0.0.1:5173'),
});

export type IdentityConfig = z.infer<typeof identityEnvSchema>;

export const loadIdentityConfig = (env: Record<string, string | undefined> = process.env) =>
  loadConfig({ service: 'identity', schema: identityEnvSchema, env });

/** Rutas de las claves del JWT ya resueltas contra la raíz del repositorio. */
export const jwtKeyPaths = (
  config: IdentityConfig,
): { privateKeyPath: string; publicKeyPath: string } => ({
  privateKeyPath: resolveFromRepoRoot(config.JWT_PRIVATE_KEY_PATH),
  publicKeyPath: resolveFromRepoRoot(config.JWT_PUBLIC_KEY_PATH),
});
