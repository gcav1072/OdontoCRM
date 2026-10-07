import { baseEnvSchema, loadConfig } from '@odontocrm/kernel';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { z } from 'zod';

/** Raíz del repositorio desde la ubicación de este archivo (src/ o dist/). */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

export const resolveFromRepoRoot = (path: string): string =>
  isAbsolute(path) ? path : resolve(REPO_ROOT, path);

export const patientsEnvSchema = baseEnvSchema.extend({
  SERVICE_VERSION: z.string().min(1).default('0.1.0'),
  PATIENTS_HOST: z.string().min(1).default('127.0.0.1'),
  PATIENTS_PORT: z.coerce.number().int().min(1).max(65_535).default(4002),
  DATABASE_URL: z.string().min(1),
  /**
   * Base donde vive la cola de eventos compartida (pg-boss). La escribe el
   * bootstrap como `EVENTS_DATABASE_URL`; si falta, se usa la propia base.
   */
  EVENTS_DATABASE_URL: z.string().min(1).optional(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),

  /** Carpeta raíz del almacén de archivos (relativa a la raíz del repositorio). */
  STORAGE_DIR: z.string().min(1).default('./storage/patients'),
  MAX_FILE_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .default(20 * 1024 * 1024),

  /**
   * Servicio de **notificaciones**: por ahí se manda el aviso al administrador cuando un
   * evento se pierde (el bot de administración vive allí y este servicio no tiene su token).
   */
  NOTIFICATIONS_URL: z.string().min(1).default('http://127.0.0.1:4004'),

  /** Secreto compartido con los demás servicios para las rutas internas. */
  INTERNAL_SERVICE_SECRET: z.string().min(16).optional(),
});

export type PatientsConfig = z.infer<typeof patientsEnvSchema>;

export const loadPatientsConfig = (env: Record<string, string | undefined> = process.env) =>
  loadConfig({ service: 'patients', schema: patientsEnvSchema, env });

export const storageRoot = (config: PatientsConfig): string =>
  resolveFromRepoRoot(config.STORAGE_DIR);
