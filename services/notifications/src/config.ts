import {
  ANTI_FLOOD_MAX_MESSAGES,
  ANTI_FLOOD_WINDOW_SECONDS,
  CLINIC,
  clinicFullAddress,
  NOTIFICATION_MAX_ATTEMPTS,
  NOTIFICATION_RETRY_DELAYS_SECONDS,
} from '@odontocrm/contracts';
import { baseEnvSchema, loadConfig, testModeEnabled } from '@odontocrm/kernel';
import { z } from 'zod';

export const notificationsEnvSchema = baseEnvSchema.extend({
  SERVICE_VERSION: z.string().min(1).default('0.1.0'),
  NOTIFICATIONS_HOST: z.string().min(1).default('127.0.0.1'),
  NOTIFICATIONS_PORT: z.coerce.number().int().min(1).max(65_535).default(4004),
  DATABASE_URL: z.string().min(1),
  EVENTS_DATABASE_URL: z.string().min(1).optional(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),

  /**
   * Token del bot (BotFather). Vive **solo** en `services/notifications/.env`.
   * Sin token el servicio arranca en **modo simulado**: todo el flujo funciona
   * (cola, plantillas, `.ics`, reintentos) pero los mensajes no salen a Telegram.
   */
  TELEGRAM_BOT_TOKEN: z.string().min(20).optional(),
  /** Usuario del bot sin `@`, para armar el enlace `t.me/<usuario>?start=<código>`. */
  TELEGRAM_BOT_USERNAME: z.string().min(1).optional(),
  /** `auto` usa el bot real si hay token; `simulado` fuerza las pruebas sin red. */
  TELEGRAM_MODE: z.enum(['auto', 'real', 'simulado']).default('auto'),
  /**
   * WhatsApp Cloud API (ADR 0029). Sin credenciales el adaptador **no se activa**
   * y el servicio sigue solo con Telegram: cuando estén, se enciende solo.
   */
  WHATSAPP_TOKEN: z.string().min(20).optional(),
  WHATSAPP_PHONE_ID: z.string().min(3).optional(),
  WHATSAPP_VERIFY_TOKEN: z.string().min(8).optional(),
  WHATSAPP_APP_SECRET: z.string().min(8).optional(),
  WHATSAPP_API_BASE: z.string().min(1).default('https://graph.facebook.com/v21.0'),
  /** Base de la API de Telegram (se puede apuntar a un doble local en pruebas). */
  TELEGRAM_API_BASE: z.string().min(1).default('https://api.telegram.org'),
  /** Segundos de espera del long polling. */
  TELEGRAM_POLL_TIMEOUT_SECONDS: z.coerce.number().int().min(0).max(50).default(25),
  /** Cada cuánto se sondea la cola de envíos, en milisegundos. */
  QUEUE_INTERVAL_MS: z.coerce.number().int().min(250).max(60_000).default(5_000),
  /** Envíos que se procesan por ciclo. */
  QUEUE_BATCH_SIZE: z.coerce.number().int().min(1).max(200).default(20),

  ANTI_FLOOD_MAX_MESSAGES: z.coerce.number().int().min(1).max(100).default(ANTI_FLOOD_MAX_MESSAGES),
  ANTI_FLOOD_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .min(10)
    .max(3600)
    .default(ANTI_FLOOD_WINDOW_SECONDS),
  NOTIFICATION_MAX_ATTEMPTS: z.coerce
    .number()
    .int()
    .min(1)
    .max(20)
    .default(NOTIFICATION_MAX_ATTEMPTS),
  RETRY_DELAYS_SECONDS: z.string().default(NOTIFICATION_RETRY_DELAYS_SECONDS.join(',')),

  /**
   * Datos que aparecen en los mensajes y en el `.ics`. Salen de `CLINIC`
   * (`packages/contracts/src/clinic.ts`, la sección editable del consultorio) y el
   * `.env` solo los sustituye si una instalación concreta lo necesita.
   */
  CLINIC_NAME: z.string().min(1).default(CLINIC.name),
  CLINIC_ADDRESS: z.string().min(1).default(clinicFullAddress()),
  CLINIC_EMAIL: z
    .string()
    .min(3)
    .default(CLINIC.email ?? 'citas@odontocrm.local'),

  /** Servicios internos que usa el bot (altas de paciente y solicitudes). */
  PATIENTS_URL: z.string().min(1).default('http://127.0.0.1:4002'),
  SCHEDULING_URL: z.string().min(1).default('http://127.0.0.1:4003'),
  INTERNAL_SERVICE_SECRET: z.string().min(16).optional(),
});

export type NotificationsConfig = z.infer<typeof notificationsEnvSchema>;

export const loadNotificationsConfig = (env: Record<string, string | undefined> = process.env) =>
  loadConfig({ service: 'notifications', schema: notificationsEnvSchema, env });

/**
 * Modo efectivo del bot: con token y sin forzar simulado, es el bot real.
 *
 * **Modo test (ADR 0020):** con el modo test activo el bot es **siempre**
 * simulado, aunque haya token configurado. Es el bloqueo que pide el plan:
 * mientras se enseña o se prueba el sistema, ningún mensaje sale a un paciente.
 */
export const telegramMode = (config: NotificationsConfig): 'real' | 'simulado' =>
  config.TELEGRAM_MODE === 'simulado' ||
  config.TELEGRAM_BOT_TOKEN === undefined ||
  testModeEnabled(config)
    ? 'simulado'
    : 'real';

export const retryDelays = (config: NotificationsConfig): number[] =>
  config.RETRY_DELAYS_SECONDS.split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value) && value > 0);
