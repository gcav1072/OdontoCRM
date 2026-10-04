import { baseEnvSchema, loadConfig } from '@odontocrm/kernel';
import { CLINIC } from '@odontocrm/contracts';
import { z } from 'zod';

export const screensEnvSchema = baseEnvSchema.extend({
  SERVICE_VERSION: z.string().min(1).default('0.1.0'),
  SCREENS_HOST: z.string().min(1).default('127.0.0.1'),
  SCREENS_PORT: z.coerce.number().int().min(1).max(65_535).default(4007),
  DATABASE_URL: z.string().min(1),
  /** Base de la cola de eventos compartida (la escribe `npm run db:bootstrap`). */
  EVENTS_DATABASE_URL: z.string().min(1).optional(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),

  /** Cuántos llamados se quedan en el displaylobby (los más recientes). */
  SCREEN_CALLS_SHOWN: z.coerce.number().int().min(1).max(10).default(3),
  /** Segundos que un llamado sigue «en pantalla» antes de considerarse viejo. */
  SCREEN_CALL_TTL_SECONDS: z.coerce.number().int().min(15).max(3600).default(120),
  /** Cada cuántos segundos se manda un latido por el flujo SSE. */
  SCREEN_KEEPALIVE_SECONDS: z.coerce.number().int().min(5).max(120).default(20),
  /** Nombre del sillón que aparece en el llamado (un solo sillón, decisión 6). */
  CHAIR_LABEL: z.string().min(1).max(40).default('Consultorio 1'),
  /** Nombre del consultorio que sale en las pantallas (por defecto, el editable). */
  CLINIC_NAME: z.string().min(1).default(CLINIC.name),

  /** Servicio de pacientes: la pantalla del consultorio pide ahí la ficha. */
  PATIENTS_URL: z.string().min(1).default('http://127.0.0.1:4002'),
  /**
   * Servicio clínico: de ahí salen los datos críticos del paciente en curso
   * (alergias, crónicos, anticoagulantes) que la pantalla pinta con semáforo.
   */
  CLINICAL_URL: z.string().min(1).default('http://127.0.0.1:4005'),

  /** Secreto compartido con los demás servicios para las rutas internas. */
  INTERNAL_SERVICE_SECRET: z.string().min(16).optional(),
});

export type ScreensConfig = z.infer<typeof screensEnvSchema>;

export const loadScreensConfig = (env: Record<string, string | undefined> = process.env) =>
  loadConfig({ service: 'screens', schema: screensEnvSchema, env });
