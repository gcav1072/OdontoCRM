import { baseEnvSchema, loadConfig } from '@odontocrm/kernel';
import { z } from 'zod';

/** Una URL vacía en el `.env` equivale a «ese servicio todavía no existe». */
const optionalUrl = z.preprocess(
  (value) => (value === '' || value === undefined ? undefined : value),
  z.string().url().optional(),
);

export const gatewayEnvSchema = baseEnvSchema.extend({
  SERVICE_VERSION: z.string().min(1).default('0.1.0'),
  GATEWAY_HOST: z.string().min(1).default('127.0.0.1'),
  GATEWAY_PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
  /** Origen permitido para la SPA (CORS). */
  WEB_ORIGIN: z.string().min(1).default('http://127.0.0.1:5173'),

  IDENTITY_URL: z.string().url(),
  PATIENTS_URL: optionalUrl,
  SCHEDULING_URL: optionalUrl,
  NOTIFICATIONS_URL: optionalUrl,
  CLINICAL_URL: optionalUrl,
  ODONTOGRAM_URL: optionalUrl,
  SCREENS_URL: optionalUrl,
  REPORTING_URL: optionalUrl,
});

export type GatewayConfig = z.infer<typeof gatewayEnvSchema>;

export const loadGatewayConfig = (env: Record<string, string | undefined> = process.env) =>
  loadConfig({ service: 'gateway', schema: gatewayEnvSchema, env });
