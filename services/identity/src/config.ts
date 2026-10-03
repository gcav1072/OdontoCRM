import { baseEnvSchema, loadConfig } from '@odontocrm/kernel';
import { z } from 'zod';

export const identityEnvSchema = baseEnvSchema.extend({
  SERVICE_VERSION: z.string().min(1).default('0.1.0'),
  IDENTITY_HOST: z.string().min(1).default('127.0.0.1'),
  IDENTITY_PORT: z.coerce.number().int().min(1).max(65_535).default(4001),
  /** Cadena de conexión de ESTE servicio; la escribe `npm run db:bootstrap`. */
  DATABASE_URL: z.string().min(1),
  /** Máximo de conexiones del pool (consultorio pequeño). */
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
});

export type IdentityConfig = z.infer<typeof identityEnvSchema>;

export const loadIdentityConfig = (env: Record<string, string | undefined> = process.env) =>
  loadConfig({ service: 'identity', schema: identityEnvSchema, env });
