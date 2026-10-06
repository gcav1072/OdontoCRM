import { baseEnvSchema, loadConfig } from '@odontocrm/kernel';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { z } from 'zod';

/** Raíz del repositorio desde la ubicación de este archivo (src/ o dist/). */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

export const resolveFromRepoRoot = (path: string): string =>
  isAbsolute(path) ? path : resolve(REPO_ROOT, path);

/** Una URL vacía en el `.env` equivale a «ese servicio todavía no existe». */
const optionalUrl = z.preprocess(
  (value) => (value === '' || value === undefined ? undefined : value),
  z.string().url().optional(),
);

export const gatewayEnvSchema = baseEnvSchema.extend({
  SERVICE_VERSION: z.string().min(1).default('0.1.0'),
  GATEWAY_HOST: z.string().min(1).default('127.0.0.1'),
  /**
   * Puerto del gateway. Por defecto 8090 y no 8080: en Windows el 8080 queda
   * ocupado por el servicio de red del host (`hns`/Hyper-V), lo que provoca
   * `listen EACCES`. Si tu máquina lo tiene libre, cámbialo en el `.env`.
   */
  GATEWAY_PORT: z.coerce.number().int().min(1).max(65_535).default(8090),
  /**
   * Origen(es) permitidos para la SPA (CORS).
   *
   * Admite **varios separados por comas**: en la clínica se entra tanto por el
   * nombre (`https://odontocrm.local`) como por la IP de la LAN
   * (`https://192.168.1.50`), y el navegador manda uno u otro según lo que se
   * teclee. Con un solo valor, entrar por el otro obligaba a cambiar la
   * configuración y reiniciar; con la lista, funcionan los dos.
   */
  WEB_ORIGIN: z.string().min(1).default('http://127.0.0.1:5173'),

  /** Clave pública EdDSA con la que se verifica el JWT de acceso. */
  JWT_PUBLIC_KEY_PATH: z.string().min(1).default('./services/identity/.keys/jwt-public.pem'),

  IDENTITY_URL: z.string().url(),
  PATIENTS_URL: optionalUrl,
  SCHEDULING_URL: optionalUrl,
  NOTIFICATIONS_URL: optionalUrl,
  CLINICAL_URL: optionalUrl,
  ODONTOGRAM_URL: optionalUrl,
  SCREENS_URL: optionalUrl,
  REPORTING_URL: optionalUrl,
  BILLING_URL: optionalUrl,
});

export type GatewayConfig = z.infer<typeof gatewayEnvSchema>;

export const loadGatewayConfig = (env: Record<string, string | undefined> = process.env) =>
  loadConfig({ service: 'gateway', schema: gatewayEnvSchema, env });

export const jwtPublicKeyPath = (config: GatewayConfig): string =>
  resolveFromRepoRoot(config.JWT_PUBLIC_KEY_PATH);

/** Los orígenes permitidos, ya separados y sin espacios (`WEB_ORIGIN`). */
export const origenesPermitidos = (webOrigin: string): string[] =>
  webOrigin
    .split(',')
    .map((origen) => origen.trim())
    .filter((origen) => origen !== '');
