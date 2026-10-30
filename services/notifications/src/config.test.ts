import { describe, expect, it } from 'vitest';

import {
  applyChannelCredentials,
  channelSignature,
  loadNotificationsConfig,
  telegramMode,
  whatsappMode,
} from './config.js';

/** La configuración base de las pruebas: una cadena válida y sin canales configurados. */
const base = (extra: Record<string, string | undefined> = {}) =>
  loadNotificationsConfig({ DATABASE_URL: 'postgres://odonto/x', ...extra });

/**
 * Los datos del consultorio **no** salen del código (`CLINIC` es neutro, sin datos
 * personales): los sirve el registro del titular vía identity
 * (`aplicarDatosDelConsultorio`), que **pisa** lo que traiga el entorno. Sin configurar
 * quedan sin valor y los avisos que los necesitan se **difieren**.
 */
describe('datos del consultorio en las notificaciones', () => {
  it('sin el registro, quedan sin valor (no hay respaldo con datos)', () => {
    const config = loadNotificationsConfig({ DATABASE_URL: 'postgres://odonto/x' });
    expect(config.CLINIC_NAME).toBeUndefined();
    expect(config.CLINIC_ADDRESS).toBeUndefined();
    expect(config.CLINIC_EMAIL).toBeUndefined();
  });
});

/**
 * El bloqueo que pide el plan §12: con el modo test activo **ningún mensaje sale
 * a un paciente**, ni aunque el bot tenga token de verdad.
 */
describe('modo test: los envíos reales quedan bloqueados', () => {
  const conToken = {
    DATABASE_URL: 'postgres://odonto/x',
    TELEGRAM_BOT_TOKEN: '1234567890:token-de-prueba-del-modo-test',
    TELEGRAM_BOT_USERNAME: 'bot_de_prueba',
  };

  it('con token y sin modo test, el bot es el real', () => {
    expect(telegramMode(loadNotificationsConfig(conToken))).toBe('real');
  });

  it('con modo test activo, el bot pasa a simulado aunque haya token', () => {
    const config = loadNotificationsConfig({
      ...conToken,
      TEST_MODE: 'true',
      ALLOW_TEST_MODE: 'true',
    });

    expect(telegramMode(config)).toBe('simulado');
  });

  it('en producción el modo test no se activa y el token manda', () => {
    const config = loadNotificationsConfig({
      ...conToken,
      NODE_ENV: 'production',
      TEST_MODE: 'true',
      ALLOW_TEST_MODE: 'true',
    });

    expect(telegramMode(config)).toBe('real');
  });

  it('pedir el modo test sin permiso no bloquea nada (la bandera sola no basta)', () => {
    expect(telegramMode(loadNotificationsConfig({ ...conToken, TEST_MODE: 'true' }))).toBe('real');
  });
});

/**
 * Las credenciales del **panel de configuración** (ADR 0060): la base manda, el `.env`
 * queda de respaldo y un campo vacío en la base **no** borra el del archivo.
 */
describe('credenciales de canal desde el panel', () => {
  const credenciales = (overrides: Record<string, string | boolean | null> = {}) => ({
    telegramBotToken: null,
    telegramBotUsername: null,
    adminTelegramBotToken: null,
    adminTelegramChatId: null,
    whatsappEnabled: null,
    whatsappProvider: null,
    whatsappSendMinIntervalMs: null,
    whatsappSendMaxIntervalMs: null,
    whatsappDailySendCap: null,
    whatsappToken: null,
    whatsappPhoneId: null,
    whatsappVerifyToken: null,
    whatsappAppSecret: null,
    whatsappApiBase: 'https://graph.facebook.com/v21.0',
    ...overrides,
  });

  it('sin credenciales en la base, se queda la del entorno', () => {
    const config = base({ TELEGRAM_BOT_USERNAME: 'bot_del_env' });
    const efectivo = applyChannelCredentials(config, credenciales());
    expect(efectivo.TELEGRAM_BOT_USERNAME).toBe('bot_del_env');
  });

  it('la base manda sobre el entorno cuando trae el dato', () => {
    const config = base({ TELEGRAM_BOT_USERNAME: 'bot_del_env' });
    const efectivo = applyChannelCredentials(
      config,
      credenciales({ telegramBotUsername: 'bot_del_panel' }),
    );
    expect(efectivo.TELEGRAM_BOT_USERNAME).toBe('bot_del_panel');
  });

  it('un token vacío en la base no borra el del entorno (respaldo)', () => {
    const config = base({ TELEGRAM_BOT_TOKEN: '1234567890:token-del-entorno-de-prueba' });
    const efectivo = applyChannelCredentials(config, credenciales({ telegramBotToken: null }));
    expect(efectivo.TELEGRAM_BOT_TOKEN).toBe('1234567890:token-del-entorno-de-prueba');
    expect(telegramMode(efectivo)).toBe('real');
  });

  it('un token de la base enciende el bot real aunque el entorno no lo tenga', () => {
    const efectivo = applyChannelCredentials(
      base(),
      credenciales({ telegramBotToken: '1234567890:token-desde-el-panel-de-config' }),
    );
    expect(telegramMode(efectivo)).toBe('real');
  });

  it('la huella cambia cuando cambia un secreto (para recargar en caliente)', () => {
    const sinToken = base();
    const conToken = applyChannelCredentials(
      base(),
      credenciales({ telegramBotToken: '1234567890:token-desde-el-panel-de-config' }),
    );
    expect(channelSignature(sinToken)).not.toBe(channelSignature(conToken));
    expect(channelSignature(conToken)).toBe(channelSignature(conToken));
  });

  it('la base manda en el interruptor y el proveedor de WhatsApp', () => {
    const config = base({ WHATSAPP_ENABLED: 'true', WHATSAPP_PROVIDER: 'baileys' });
    const efectivo = applyChannelCredentials(
      config,
      credenciales({ whatsappEnabled: false, whatsappProvider: 'cloud_api' }),
    );
    expect(efectivo.WHATSAPP_ENABLED).toBe(false);
    expect(efectivo.WHATSAPP_PROVIDER).toBe('cloud_api');
  });
});

describe('proveedor de WhatsApp', () => {
  it('Baileys se enciende con el interruptor y queda a la espera de sesión', () => {
    expect(whatsappMode(base())).toBe('desactivado');
    expect(whatsappMode(base({ WHATSAPP_ENABLED: 'true' }))).toBe('baileys');
  });

  it('Cloud API exige sus cuatro credenciales y el interruptor', () => {
    const conCredenciales = {
      WHATSAPP_ENABLED: 'true',
      WHATSAPP_PROVIDER: 'cloud_api',
      WHATSAPP_TOKEN: 'token-de-prueba-suficientemente-largo',
      WHATSAPP_PHONE_ID: '1234567890',
      WHATSAPP_VERIFY_TOKEN: 'verificacion-de-prueba',
      WHATSAPP_APP_SECRET: 'secreto-de-prueba',
    };
    expect(whatsappMode(base(conCredenciales))).toBe('cloud_api');
    expect(whatsappMode(base({ ...conCredenciales, WHATSAPP_APP_SECRET: undefined }))).toBe(
      'desactivado',
    );
  });

  it('en modo test no se abre ningún proveedor real', () => {
    const config = base({
      WHATSAPP_ENABLED: 'true',
      TEST_MODE: 'true',
      ALLOW_TEST_MODE: 'true',
    });
    expect(whatsappMode(config)).toBe('desactivado');
  });

  it('el ritmo por defecto es 2–4 s y 150 al día', () => {
    const config = base();
    expect(config.WHATSAPP_SEND_MIN_INTERVAL_MS).toBe(2000);
    expect(config.WHATSAPP_SEND_MAX_INTERVAL_MS).toBe(4000);
    expect(config.WHATSAPP_DAILY_SEND_CAP).toBe(150);
  });
});
