import {
  ANTI_FLOOD_MAX_MESSAGES,
  ANTI_FLOOD_WINDOW_SECONDS,
  DEFAULT_WHATSAPP_PROVIDER,
  NOTIFICATION_MAX_ATTEMPTS,
  NOTIFICATION_RETRY_DELAYS_SECONDS,
  WHATSAPP_PROVIDERS,
  WHATSAPP_RATE_DEFAULTS,
  type ChannelCredentials,
} from '@odontocrm/contracts';
import { baseEnvSchema, loadConfig, testModeEnabled } from '@odontocrm/kernel';
import { z } from 'zod';

export const notificationsEnvSchema = baseEnvSchema
  .extend({
    SERVICE_VERSION: z.string().min(1).default('1.1.0'),
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
     * **WhatsApp (ADR 0072).** El canal tiene dos proveedores detrás del mismo id:
     *
     * - `baileys` (por defecto): socket saliente y sesión vinculada por QR/código.
     *   Se enciende con `WHATSAPP_ENABLED` (o el interruptor del panel, que manda);
     *   sin sesión queda `sin_vincular` y no escribe a nadie.
     * - `cloud_api`: la integración oficial de Meta, que se conserva como
     *   alternativa. Sigue necesitando sus cuatro credenciales.
     */
    WHATSAPP_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((valor) => valor === 'true'),
    WHATSAPP_PROVIDER: z.enum(WHATSAPP_PROVIDERS).default(DEFAULT_WHATSAPP_PROVIDER),
    /** Clave de la sesión en `whatsapp_auth` (una instalación = una sesión). */
    WHATSAPP_SESSION_ID: z.string().min(1).max(60).default('principal'),
    /** Prefijo para normalizar los números locales (`0414…` → `58414…`). */
    WHATSAPP_DEFAULT_COUNTRY_CODE: z
      .string()
      .regex(/^\d{1,4}$/)
      .default('58'),
    /**
     * Ritmo de Baileys (D9): la espera entre envíos se sortea entre el mínimo y el
     * máximo. El valor por defecto (2–4 s) es el que el usuario pidió; el panel
     * puede cambiarlo y la base manda sobre el `.env`.
     */
    WHATSAPP_SEND_MIN_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(1000)
      .max(60_000)
      .default(WHATSAPP_RATE_DEFAULTS.minSendIntervalMs),
    WHATSAPP_SEND_MAX_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(1000)
      .max(60_000)
      .default(WHATSAPP_RATE_DEFAULTS.maxSendIntervalMs),
    WHATSAPP_DAILY_SEND_CAP: z.coerce
      .number()
      .int()
      .min(1)
      .max(1000)
      .default(WHATSAPP_RATE_DEFAULTS.dailySendCap),
    /** Simular «escribiendo…» antes de cada mensaje (mitigación de bloqueo). */
    WHATSAPP_TYPING: z
      .enum(['true', 'false'])
      .default('true')
      .transform((valor) => valor === 'true'),
    /** Techo del backoff de reconexión. */
    WHATSAPP_RECONNECT_MAX_DELAY_MS: z.coerce
      .number()
      .int()
      .min(1000)
      .max(86_400_000)
      .default(300_000),
    /** Caída que dispara el aviso al bot de administración. */
    WHATSAPP_ALERT_AFTER_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
    /** Nivel del logger que se pasa a Baileys (no el del servicio). */
    WHATSAPP_LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('warn'),
    /**
     * Clave con la que se cifra la **sesión Signal** de WhatsApp en la base
     * (`whatsapp_auth`). Es la misma del almacén; se escribe en el `.env` de
     * `notifications` por el aprovisionador.
     */
    STORAGE_ENCRYPTION_KEY: z.string().min(1).optional(),

    // Cloud API (proveedor alternativo que se conserva, ADR 0072).
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

    ANTI_FLOOD_MAX_MESSAGES: z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .default(ANTI_FLOOD_MAX_MESSAGES),
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
  })
  .superRefine((valor, ctx) => {
    if (valor.WHATSAPP_SEND_MIN_INTERVAL_MS > valor.WHATSAPP_SEND_MAX_INTERVAL_MS) {
      ctx.addIssue({
        code: 'custom',
        path: ['WHATSAPP_SEND_MAX_INTERVAL_MS'],
        message: 'El intervalo máximo no puede ser menor que el mínimo',
      });
    }
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

/**
 * Aplica sobre la configuración las credenciales que el panel guardó en la base (ADR 0060).
 *
 * La **base manda** cuando trae el dato; el `.env` queda como **respaldo** (una instalación
 * que ya tenía los tokens en el archivo sigue funcionando sin tocar el panel). Un campo en
 * `null` en la base no pisa al `.env`: significa «no se configuró aquí», no «bórralo».
 *
 * Es puro y se llama **en caliente** (cada pocos minutos) para que guardar en el panel se
 * note sin reiniciar: los adaptadores se reconstruyen con la configuración resultante.
 */
export const applyChannelCredentials = (
  config: NotificationsConfig,
  creds: ChannelCredentials | null,
): NotificationsConfig => {
  if (creds === null) return config;
  return {
    ...config,
    TELEGRAM_BOT_TOKEN: creds.telegramBotToken ?? config.TELEGRAM_BOT_TOKEN,
    TELEGRAM_BOT_USERNAME: creds.telegramBotUsername ?? config.TELEGRAM_BOT_USERNAME,
    ADMIN_TELEGRAM_BOT_TOKEN: creds.adminTelegramBotToken ?? config.ADMIN_TELEGRAM_BOT_TOKEN,
    ADMIN_TELEGRAM_CHAT_ID: creds.adminTelegramChatId ?? config.ADMIN_TELEGRAM_CHAT_ID,
    WHATSAPP_ENABLED: creds.whatsappEnabled ?? config.WHATSAPP_ENABLED,
    WHATSAPP_PROVIDER: creds.whatsappProvider ?? config.WHATSAPP_PROVIDER,
    WHATSAPP_SEND_MIN_INTERVAL_MS:
      creds.whatsappSendMinIntervalMs ?? config.WHATSAPP_SEND_MIN_INTERVAL_MS,
    WHATSAPP_SEND_MAX_INTERVAL_MS:
      creds.whatsappSendMaxIntervalMs ?? config.WHATSAPP_SEND_MAX_INTERVAL_MS,
    WHATSAPP_DAILY_SEND_CAP: creds.whatsappDailySendCap ?? config.WHATSAPP_DAILY_SEND_CAP,
    WHATSAPP_TOKEN: creds.whatsappToken ?? config.WHATSAPP_TOKEN,
    WHATSAPP_PHONE_ID: creds.whatsappPhoneId ?? config.WHATSAPP_PHONE_ID,
    WHATSAPP_VERIFY_TOKEN: creds.whatsappVerifyToken ?? config.WHATSAPP_VERIFY_TOKEN,
    WHATSAPP_APP_SECRET: creds.whatsappAppSecret ?? config.WHATSAPP_APP_SECRET,
    WHATSAPP_API_BASE:
      creds.whatsappApiBase === '' ? config.WHATSAPP_API_BASE : creds.whatsappApiBase,
  };
};

/**
 * Copia los campos de canal de `origen` sobre `destino` (**el mismo objeto** que ya
 * comparten el asistente, las rutas y la cola). Se usa al aplicar las credenciales del
 * panel: en vez de repartir un `config` nuevo por medio servicio, se refresca el que ya
 * está en uso y todo el que lo lea ve el dato bueno sin reiniciar.
 */
export const syncChannelFields = (
  destino: NotificationsConfig,
  origen: NotificationsConfig,
): void => {
  destino.TELEGRAM_BOT_TOKEN = origen.TELEGRAM_BOT_TOKEN;
  destino.TELEGRAM_BOT_USERNAME = origen.TELEGRAM_BOT_USERNAME;
  destino.ADMIN_TELEGRAM_BOT_TOKEN = origen.ADMIN_TELEGRAM_BOT_TOKEN;
  destino.ADMIN_TELEGRAM_CHAT_ID = origen.ADMIN_TELEGRAM_CHAT_ID;
  destino.WHATSAPP_ENABLED = origen.WHATSAPP_ENABLED;
  destino.WHATSAPP_PROVIDER = origen.WHATSAPP_PROVIDER;
  destino.WHATSAPP_SEND_MIN_INTERVAL_MS = origen.WHATSAPP_SEND_MIN_INTERVAL_MS;
  destino.WHATSAPP_SEND_MAX_INTERVAL_MS = origen.WHATSAPP_SEND_MAX_INTERVAL_MS;
  destino.WHATSAPP_DAILY_SEND_CAP = origen.WHATSAPP_DAILY_SEND_CAP;
  destino.WHATSAPP_TOKEN = origen.WHATSAPP_TOKEN;
  destino.WHATSAPP_PHONE_ID = origen.WHATSAPP_PHONE_ID;
  destino.WHATSAPP_VERIFY_TOKEN = origen.WHATSAPP_VERIFY_TOKEN;
  destino.WHATSAPP_APP_SECRET = origen.WHATSAPP_APP_SECRET;
  destino.WHATSAPP_API_BASE = origen.WHATSAPP_API_BASE;
};

/**
 * Huella de lo que decide los adaptadores activos. El servicio la compara cada pocos
 * minutos: si cambió (el panel guardó un token), reconstruye los adaptadores sin reiniciar.
 *
 * **No se registra ni se expone**: lleva los secretos dentro para detectar cualquier cambio,
 * y por eso solo se compara en memoria.
 */
export const channelSignature = (config: NotificationsConfig): string =>
  JSON.stringify([telegramSignature(config), whatsappSignature(config)]);

/** Huella de lo que decide el adaptador de Telegram. */
const telegramSignature = (config: NotificationsConfig): string =>
  JSON.stringify([
    config.TELEGRAM_BOT_TOKEN ?? null,
    config.TELEGRAM_BOT_USERNAME ?? null,
    config.ADMIN_TELEGRAM_BOT_TOKEN ?? null,
    config.ADMIN_TELEGRAM_CHAT_ID ?? null,
    telegramMode(config),
  ]);

/**
 * Huella de lo que decide el adaptador de WhatsApp. **D15:** la recarga en caliente
 * compara esta huella con la anterior; si solo cambió Telegram, la sesión de Baileys
 * se conserva y no se cierra el socket.
 */
export const whatsappSignature = (config: NotificationsConfig): string =>
  JSON.stringify([
    whatsappMode(config),
    config.WHATSAPP_TOKEN ?? null,
    config.WHATSAPP_PHONE_ID ?? null,
    config.WHATSAPP_VERIFY_TOKEN ?? null,
    config.WHATSAPP_APP_SECRET ?? null,
    config.WHATSAPP_API_BASE,
    config.WHATSAPP_SESSION_ID,
    config.WHATSAPP_DEFAULT_COUNTRY_CODE,
    config.WHATSAPP_SEND_MIN_INTERVAL_MS,
    config.WHATSAPP_SEND_MAX_INTERVAL_MS,
    config.WHATSAPP_DAILY_SEND_CAP,
    config.WHATSAPP_TYPING,
    config.WHATSAPP_RECONNECT_MAX_DELAY_MS,
    config.WHATSAPP_ALERT_AFTER_MINUTES,
    config.STORAGE_ENCRYPTION_KEY ?? null,
  ]);

/**
 * Modo efectivo típico del canal `whatsapp`:
 *
 * - `desactivado`: interruptor apagado, modo test o Cloud API sin credenciales.
 * - `baileys`: socket saliente.
 * - `cloud_api`: webhook de Meta.
 *
 * **Modo test (ADR 0020):** ningún proveedor real se enciende, aunque haya
 * credenciales y el interruptor esté puesto.
 */
export const whatsappMode = (
  config: NotificationsConfig,
): 'desactivado' | 'baileys' | 'cloud_api' => {
  if (testModeEnabled(config) || !config.WHATSAPP_ENABLED) return 'desactivado';
  if (config.WHATSAPP_PROVIDER === 'cloud_api') {
    return config.WHATSAPP_TOKEN !== undefined &&
      config.WHATSAPP_PHONE_ID !== undefined &&
      config.WHATSAPP_VERIFY_TOKEN !== undefined &&
      config.WHATSAPP_APP_SECRET !== undefined
      ? 'cloud_api'
      : 'desactivado';
  }
  return 'baileys';
};
