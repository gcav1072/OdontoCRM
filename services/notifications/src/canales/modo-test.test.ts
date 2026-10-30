import { describe, expect, it } from 'vitest';

import type { NotificationsDb } from '../db/client.js';
import { loadNotificationsConfig } from '../config.js';
import { createChannelAdapters } from './index.js';

/**
 * Modo test y canales (ADR 0020): con el modo test activo ningún adaptador que
 * hable con personas reales puede quedar encendido, ni siquiera teniendo
 * credenciales de verdad en el `.env`.
 */
const conWhatsAppCloud = {
  DATABASE_URL: 'postgres://odonto/x',
  WHATSAPP_ENABLED: 'true',
  WHATSAPP_PROVIDER: 'cloud_api',
  WHATSAPP_TOKEN: 'token-de-prueba-suficientemente-largo',
  WHATSAPP_PHONE_ID: '1234567890',
  WHATSAPP_VERIFY_TOKEN: 'verificacion-de-prueba',
  WHATSAPP_APP_SECRET: 'secreto-de-prueba',
};

describe('canales con el modo test apagado', () => {
  it('enciende Cloud API cuando es el proveedor elegido y tiene credenciales', () => {
    const canales = createChannelAdapters(loadNotificationsConfig(conWhatsAppCloud));

    expect(canales.registry.all.map((adapter) => adapter.id).sort()).toEqual([
      'telegram',
      'whatsapp',
    ]);
    expect(canales.modoWhatsApp).toBe('cloud_api');
    expect(canales.modoTest).toBe(false);
  });

  it('enciende Baileys con el interruptor, aunque no haya sesión todavía', () => {
    const canales = createChannelAdapters(
      loadNotificationsConfig({ DATABASE_URL: 'postgres://odonto/x', WHATSAPP_ENABLED: 'true' }),
      { db: {} as NotificationsDb },
    );

    expect(canales.registry.all.map((adapter) => adapter.id).sort()).toEqual([
      'telegram',
      'whatsapp',
    ]);
    expect(canales.modoWhatsApp).toBe('baileys');
    expect(canales.whatsapp).not.toBeNull();
    expect(canales.webhooks).toHaveLength(0);
  });

  it('conserva la sesión de Baileys cuando solo cambia Telegram (D15)', () => {
    const config = loadNotificationsConfig({
      DATABASE_URL: 'postgres://odonto/x',
      WHATSAPP_ENABLED: 'true',
    });
    const db = {} as NotificationsDb;
    const primero = createChannelAdapters(config, { db });
    const segundo = createChannelAdapters(
      { ...config, TELEGRAM_BOT_TOKEN: '1234567890:token-de-prueba-d15' },
      { db, previous: primero },
    );

    expect(segundo.whatsapp).toBe(primero.whatsapp);
    expect(segundo.whatsappFirma).toBe(primero.whatsappFirma);
  });

  it('mantiene WhatsApp apagado si el interruptor está en false', () => {
    const canales = createChannelAdapters(
      loadNotificationsConfig({ ...conWhatsAppCloud, WHATSAPP_ENABLED: 'false' }),
      { db: {} as NotificationsDb },
    );
    expect(canales.registry.all.map((adapter) => adapter.id)).toEqual(['telegram']);
  });
});

describe('canales con el modo test activo', () => {
  const config = loadNotificationsConfig({
    ...conWhatsAppCloud,
    TELEGRAM_BOT_TOKEN: '1234567890:token-de-prueba-del-modo-test',
    TEST_MODE: 'true',
    ALLOW_TEST_MODE: 'true',
  });
  const canales = createChannelAdapters(config, { db: {} as NotificationsDb });

  it('no enciende los canales que empujan a personas reales', () => {
    expect(canales.registry.all.map((adapter) => adapter.id)).toEqual(['telegram']);
    expect(canales.webhooks).toHaveLength(0);
    expect(canales.whatsapp).toBeNull();
  });

  it('el bot queda en simulado aunque tenga token configurado', () => {
    expect(canales.modoTest).toBe(true);
    expect(canales.modoTelegram).toBe('simulado');
    expect(canales.transport.mode).toBe('simulado');
  });
});
