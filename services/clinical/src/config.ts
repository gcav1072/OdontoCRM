import { baseEnvSchema, loadConfig } from '@odontocrm/kernel';
import { z } from 'zod';

export const clinicalEnvSchema = baseEnvSchema.extend({
  SERVICE_VERSION: z.string().min(1).default('0.1.0'),
  CLINICAL_HOST: z.string().min(1).default('127.0.0.1'),
  CLINICAL_PORT: z.coerce.number().int().min(1).max(65_535).default(4005),
  DATABASE_URL: z.string().min(1),
  /**
   * Base donde vive la cola de eventos compartida (pg-boss). La escribe el
   * bootstrap como `EVENTS_DATABASE_URL`; si falta, se usa la propia base.
   */
  EVENTS_DATABASE_URL: z.string().min(1).optional(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),

  /**
   * Servicio de pacientes: la historia clínica pide ahí la ficha para mostrar
   * nombre, edad, documento y contacto. Si no responde, la historia se ve igual
   * (solo faltan esos datos).
   */
  PATIENTS_URL: z.string().min(1).default('http://127.0.0.1:4002'),

  /** Secreto compartido con los demás servicios para las rutas internas. */
  INTERNAL_SERVICE_SECRET: z.string().min(16).optional(),
});

export type ClinicalConfig = z.infer<typeof clinicalEnvSchema>;

export const loadClinicalConfig = (env: Record<string, string | undefined> = process.env) =>
  loadConfig({ service: 'clinical', schema: clinicalEnvSchema, env });
