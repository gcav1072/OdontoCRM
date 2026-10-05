import { describe, expect, it } from 'vitest';

import { loadNotificationsConfig } from '../config.js';
import { createChannelAdapters } from './index.js';

/**
 * Modo test y canales (ADR 0020): con el modo test activo ningún adaptador que
 * hable con personas reales puede quedar encendido, ni siquiera teniendo
 * credenciales de verdad en el `.env`.
 */
const conWhatsApp = {
  DATABASE_URL: 'postgres://odonto/x',
  WHATSAPP_TOKEN: 'token-de-prueba-suficientemente-largo',
  WHATSAPP_PHONE_ID: '1234567890',
  WHATSAPP_VERIFY_TOKEN: 'verificacion-de-prueba',
  WHATSAPP_APP_SECRET: 'secreto-de-prueba',
};

describe('canales con el modo test apagado', () => {
  it('enciende los canales que tienen credenciales', () => {
    const canales = createChannelAdapters(loadNotificationsConfig(conWhatsApp));

    expect(
      canales.registry.all
        .map((adapter) => adapter.id)
        .slice()
        .sort(),
    ).toEqual(['telegram', 'whatsapp']);
    expect(canales.modoTest).toBe(false);
  });
});

describe('canales con el modo test activo', () => {
  const config = loadNotificationsConfig({
    ...conWhatsApp,
    TELEGRAM_BOT_TOKEN: '1234567890:token-de-prueba-del-modo-test',
    TEST_MODE: 'true',
    ALLOW_TEST_MODE: 'true',
  });
  const canales = createChannelAdapters(config);

  it('no enciende los canales que empujan a personas reales', () => {
    expect(canales.registry.all.map((adapter) => adapter.id)).toEqual(['telegram']);
    expect(canales.webhooks).toHaveLength(0);
  });

  it('el bot queda en simulado aunque tenga token configurado', () => {
    expect(canales.modoTest).toBe(true);
    expect(canales.modoTelegram).toBe('simulado');
    expect(canales.transport.mode).toBe('simulado');
  });
});
