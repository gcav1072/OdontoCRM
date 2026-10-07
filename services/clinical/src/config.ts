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

  /**
   * Servicio de odontograma: el **dossier** del expediente lee ahí la boca del paciente
   * para dibujarla en el PDF. Si no responde, el dossier sale igual, sin el dibujo.
   */
  ODONTOGRAM_URL: z.string().min(1).default('http://127.0.0.1:4006'),

  /**
   * Almacén de binarios del servicio: adjuntos de la sesión y los PDF de los
   * récipes. Es una carpeta relativa a la raíz del repositorio (ignorada por Git),
   * separada de la de pacientes.
   */
  STORAGE_DIR: z.string().min(1).default('./storage/clinical'),
  /** Tope de un adjunto: el mismo que la ficha del paciente (20 MB). */
  MAX_FILE_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .max(200 * 1024 * 1024)
    .default(20 * 1024 * 1024),

  /**
   * Dirección pública de la interfaz: es la base del enlace del **QR** del récipe
   * (`<PUBLIC_APP_URL>/verificar/<código>`). En producción es la URL del proxy
   * inverso de la clínica, no `localhost`.
   */
  PUBLIC_APP_URL: z.string().min(1).default('http://127.0.0.1:5173'),

  /**
   * Chromium para el PDF A5. Vacío = el navegador que administra Playwright
   * (`npx playwright install chromium`). Se puede fijar una ruta concreta en una
   * instalación que ya tenga Chromium (Fedora con el paquete del sistema).
   */
  PDF_CHROMIUM_PATH: z.string().min(1).optional(),
  /** Cuánto se espera a que el PDF salga antes de darlo por fallido. */
  PDF_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(120_000).default(30_000),

  /** Secreto compartido con los demás servicios para las rutas internas. */
  INTERNAL_SERVICE_SECRET: z.string().min(16).optional(),
});

export type ClinicalConfig = z.infer<typeof clinicalEnvSchema>;

export const loadClinicalConfig = (env: Record<string, string | undefined> = process.env) =>
  loadConfig({ service: 'clinical', schema: clinicalEnvSchema, env });
