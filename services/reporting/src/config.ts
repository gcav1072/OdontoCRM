import { baseEnvSchema, loadConfig } from '@odontocrm/kernel';
import { z } from 'zod';

export const reportingEnvSchema = baseEnvSchema.extend({
  SERVICE_VERSION: z.string().min(1).default('0.1.0'),
  REPORTING_HOST: z.string().min(1).default('127.0.0.1'),
  REPORTING_PORT: z.coerce.number().int().min(1).max(65_535).default(4008),
  DATABASE_URL: z.string().min(1),
  /**
   * Base donde vive la cola de eventos compartida (pg-boss). La escribe el
   * bootstrap como `EVENTS_DATABASE_URL`; si falta, se usa la propia base.
   */
  EVENTS_DATABASE_URL: z.string().min(1).optional(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),

  /**
   * Servicio de identidad: de ahí se lee la **identidad del consultorio** para el
   * membrete del reporte (ADR 0056). Sin ella (o sin secreto interno) se usa el respaldo
   * del código (`CLINIC`).
   */
  IDENTITY_URL: z.string().min(1).default('http://127.0.0.1:4001'),

  /**
   * Hora local (0–23, zona del consultorio) del **refresco nocturno** de las vistas
   * materializadas. A las 3 de la madrugada no hay nadie mirando el tablero, así
   * que el `REFRESH` no compite con las consultas de la mañana.
   */
  REPORTING_REFRESH_HOUR: z.coerce.number().int().min(0).max(23).default(3),

  /**
   * Chromium para el PDF del reporte (A4 horizontal). Vacío = el navegador que
   * administra Playwright (`npx playwright install chromium`). Mismo patrón que el
   * servicio clínico, que ya imprime los récipes con él.
   */
  PDF_CHROMIUM_PATH: z.string().min(1).optional(),
  /** Cuánto se espera a que el PDF salga antes de darlo por fallido. */
  PDF_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(120_000).default(30_000),

  /**
   * Servicio de **notificaciones**: por ahí se manda el aviso al administrador cuando un
   * evento se pierde (el bot de administración vive allí y este servicio no tiene su token).
   */
  NOTIFICATIONS_URL: z.string().min(1).default('http://127.0.0.1:4004'),

  /** Secreto compartido con los demás servicios para las rutas internas. */
  INTERNAL_SERVICE_SECRET: z.string().min(16).optional(),
});

export type ReportingConfig = z.infer<typeof reportingEnvSchema>;

export const loadReportingConfig = (env: Record<string, string | undefined> = process.env) =>
  loadConfig({ service: 'reporting', schema: reportingEnvSchema, env });
