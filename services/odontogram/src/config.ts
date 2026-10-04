import { baseEnvSchema, loadConfig } from '@odontocrm/kernel';
import { z } from 'zod';

export const odontogramEnvSchema = baseEnvSchema.extend({
  SERVICE_VERSION: z.string().min(1).default('0.1.0'),
  ODONTOGRAM_HOST: z.string().min(1).default('127.0.0.1'),
  ODONTOGRAM_PORT: z.coerce.number().int().min(1).max(65_535).default(4006),
  DATABASE_URL: z.string().min(1),
  /**
   * Base donde vive la cola de eventos compartida (pg-boss). La escribe el
   * bootstrap como `EVENTS_DATABASE_URL`; si falta, se usa la propia base.
   */
  EVENTS_DATABASE_URL: z.string().min(1).optional(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),

  /**
   * Servicio de pacientes: el odontograma pide ahí la ficha para encabezar la
   * vista impresa. Si no responde, el odontograma se lee igual (solo falta el
   * encabezado).
   */
  PATIENTS_URL: z.string().min(1).default('http://127.0.0.1:4002'),

  /** Secreto compartido con los demás servicios para las rutas internas. */
  INTERNAL_SERVICE_SECRET: z.string().min(16).optional(),
});

export type OdontogramConfig = z.infer<typeof odontogramEnvSchema>;

export const loadOdontogramConfig = (env: Record<string, string | undefined> = process.env) =>
  loadConfig({ service: 'odontogram', schema: odontogramEnvSchema, env });
