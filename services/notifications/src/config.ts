import {
  ANTI_FLOOD_MAX_MESSAGES,
  ANTI_FLOOD_WINDOW_SECONDS,
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
  TELEGRAM_BOT_TOKEN: z
    .string()
    .min(20)
    .optional()
    // Un marcador de plantilla (`CAMBIAR_TOKEN_BOTFATHER`) **no es un token**: cumple el
    // mínimo de longitud y el servicio diría «configurado» para luego no conectar, que es
    // un diagnóstico que cuesta media hora. Se trata como ausente y se avisa.
    .transform((valor) => (valor === undefined || /^CAMBIAR/i.test(valor) ? undefined : valor)),
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
   * Datos del consultorio que aparecen en los mensajes y en el `.ics`. **No vienen del
   * código** (`CLINIC` es neutro y sin datos personales): los sirve el registro del
   * titular vía identity (`aplicarDatosDelConsultorio`). Mientras no estén, quedan
   * **sin valor** y los servicios que los necesitan **difieren** el aviso y el `.ics`.
   */
  CLINIC_NAME: z.string().min(1).optional(),

  /**
   * Servicio de identidad: al arrancar (y cada pocos minutos) se lee de ahí el nombre,
   * la dirección y el correo del consultorio (ADR 0056). No hay fallback con datos.
   */
  IDENTITY_URL: z.string().min(1).default('http://127.0.0.1:4001'),
  CLINIC_ADDRESS: z.string().min(1).optional(),
  CLINIC_EMAIL: z.string().min(3).optional(),

  /** Servicios internos que usa el bot (altas de paciente y solicitudes). */
  PATIENTS_URL: z.string().min(1).default('http://127.0.0.1:4002'),
  SCHEDULING_URL: z.string().min(1).default('http://127.0.0.1:4003'),
  INTERNAL_SERVICE_SECRET: z.string().min(16).optional(),

  /**
   * **Bot de administración** (mejora 1 del plan post-Fase 11): el que avisa al dueño del
   * consultorio de los fallos de infraestructura —eventos que agotan sus reintentos, la
   * verificación del respaldo, el tablero de estado—.
   *
   * Es un bot **aparte** del de los pacientes a propósito: el de los pacientes lo ven las
   * familias, y «el outbox de clinical lleva 40 minutos sin publicar» no es un mensaje para
   * un paciente. Token y chat son opcionales: sin ellos los avisos quedan en el registro y
   * el resto del sistema funciona igual.
   */
  ADMIN_TELEGRAM_BOT_TOKEN: z
    .string()
    .min(20)
    .optional()
    // Misma trampa que el bot de pacientes: el marcador de la plantilla cumple la longitud
    // y el servicio diría «configurado» para luego no conectar.
    .transform((valor) => (valor === undefined || /^CAMBIAR/i.test(valor) ? undefined : valor)),
  /** Chat (o grupo) del administrador. Sin él el bot no sabe a quién escribir. */
  ADMIN_TELEGRAM_CHAT_ID: z
    // Una línea vacía en el `.env` es «sin configurar», no una configuración inválida (el
    // aprovisionador deja las claves opcionales comentadas, pero alguien puede dejarla vacía).
    .preprocess(
      (valor) => (typeof valor === 'string' && valor.trim() === '' ? undefined : valor),
      z.string().min(1).optional(),
    ),
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

/**
 * El bot de administración queda **listo** cuando tiene token **y** chat: con uno solo no
 * puede mandar nada, y las dos cosas juntas no tienen valor por defecto (el token lo da
 * BotFather y el chat es de quien va a leer los avisos).
 */
export const adminBotReady = (config: NotificationsConfig): boolean =>
  config.ADMIN_TELEGRAM_BOT_TOKEN !== undefined && config.ADMIN_TELEGRAM_CHAT_ID !== undefined;
