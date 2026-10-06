import { baseEnvSchema, loadConfig } from '@odontocrm/kernel';
import { z } from 'zod';

export const billingEnvSchema = baseEnvSchema.extend({
  SERVICE_VERSION: z.string().min(1).default('0.1.0'),
  BILLING_HOST: z.string().min(1).default('127.0.0.1'),
  /** 4009: los puertos 4001–4008 son de los otros ocho servicios. */
  BILLING_PORT: z.coerce.number().int().min(1).max(65_535).default(4009),
  DATABASE_URL: z.string().min(1),
  /**
   * Base donde vive la cola de eventos compartida (pg-boss). La escribe el
   * bootstrap como `EVENTS_DATABASE_URL`; si falta, se usa la propia base.
   */
  EVENTS_DATABASE_URL: z.string().min(1).optional(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),

  /**
   * Servicio de pacientes: el borrador copia la **instantánea** del paciente (nombre y documento)
   * para que el papel no cambie si la ficha cambia (ADR 0048). Si no responde, el evento se
   * reintenta: un documento fiscal no puede llevar un nombre inventado.
   */
  PATIENTS_URL: z.string().min(1).default('http://127.0.0.1:4002'),

  /**
   * Almacén de los documentos archivados (la factura, el recibo y la nota de crédito). Una carpeta
   * relativa a la raíz del repositorio, ignorada por Git (ADR 0036/0048).
   */
  STORAGE_DIR: z.string().min(1).default('./storage/billing'),

  /**
   * Chromium para el PDF de la factura. Vacío = el navegador que administra Playwright
   * (`npx playwright install chromium`); con Chromium del sistema se fija la ruta.
   */
  PDF_CHROMIUM_PATH: z.string().min(1).optional(),
  /** Cuánto se espera a que el PDF salga antes de darlo por fallido. */
  PDF_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(120_000).default(30_000),

  /** Secreto compartido con los demás servicios para las rutas internas. */
  INTERNAL_SERVICE_SECRET: z.string().min(16).optional(),
});

export type BillingConfig = z.infer<typeof billingEnvSchema>;

export const loadBillingConfig = (env: Record<string, string | undefined> = process.env) =>
  loadConfig({ service: 'billing', schema: billingEnvSchema, env });
