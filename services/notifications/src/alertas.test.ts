import { describe, expect, it } from 'vitest';

import { createAdminAlerter } from './alertas.js';
import { loadNotificationsConfig, type NotificationsConfig } from './config.js';
import { createSimulatedTransport } from './canales/telegram-api.js';

/**
 * El emisor de avisos al administrador.
 *
 * Lo que hay que fijar aquí es que **nunca lanza**: quien avisa está a mitad de atender otra
 * cosa —un evento perdido, una comprobación que falló— y un fallo al avisar no puede
 * convertirse en el segundo problema. Todo lo que sale es «salió» o «no salió, y por esto».
 */

const baseEnv = {
  DATABASE_URL: 'postgres://odonto_notifications:clave@127.0.0.1:5432/odonto_notifications',
  LOG_LEVEL: 'silent',
};

const conBot = (extra: Record<string, string> = {}): NotificationsConfig =>
  loadNotificationsConfig({
    ...baseEnv,
    ADMIN_TELEGRAM_BOT_TOKEN: '1234567890:token-del-bot-de-administracion',
    ADMIN_TELEGRAM_CHAT_ID: '-100200300',
    ...extra,
  });

const aviso = {
  level: 'critical' as const,
  title: 'Evento perdido',
  detail: 'El consumidor no pudo aplicarlo.',
  context: { cola: 'domain-events.clinical' },
};

describe('el emisor de avisos al administrador', () => {
  it('manda el aviso al chat configurado, con el formato del contrato', async () => {
    const transport = createSimulatedTransport();
    const emisor = createAdminAlerter({ config: conBot(), transport });

    await expect(emisor.enviar(aviso)).resolves.toEqual({ enviado: true, motivo: null });

    expect(transport.sent).toHaveLength(1);
    const enviado = transport.sent[0];
    expect(enviado?.chatId).toBe('-100200300');
    expect(enviado?.text).toContain('CRÍTICO');
    expect(enviado?.text).toContain('Evento perdido');
    expect(enviado?.text).toContain('cola: domain-events.clinical');
    // El origen por defecto, para que el mensaje siempre diga de dónde viene.
    expect(enviado?.text).toContain('odontocrm');
  });

  it('sin bot configurado lo dice y no falla', async () => {
    const emisor = createAdminAlerter({
      config: loadNotificationsConfig(baseEnv),
      transport: null,
    });

    const resultado = await emisor.enviar(aviso);
    expect(resultado.enviado).toBe(false);
    expect(resultado.motivo).toContain('ADMIN_TELEGRAM_BOT_TOKEN');
  });

  it('con token pero sin chat tampoco puede avisar, y lo explica', async () => {
    const emisor = createAdminAlerter({
      config: conBot({ ADMIN_TELEGRAM_CHAT_ID: '' }),
      transport: createSimulatedTransport(),
    });

    const resultado = await emisor.enviar(aviso);
    expect(resultado.enviado).toBe(false);
    expect(resultado.motivo).toContain('ADMIN_TELEGRAM_CHAT_ID');
  });

  it('si Telegram no responde devuelve el motivo en vez de lanzar', async () => {
    const fallon = {
      ...createSimulatedTransport(),
      sendMessage: async () => {
        throw new Error('Telegram sendMessage falló: Too Many Requests');
      },
    };
    const emisor = createAdminAlerter({ config: conBot(), transport: fallon });

    const resultado = await emisor.enviar(aviso);
    expect(resultado.enviado).toBe(false);
    expect(resultado.motivo).toContain('Too Many Requests');
    // El token nunca aparece en el motivo (podría acabar en un registro o en pantalla).
    expect(resultado.motivo).not.toContain('token-del-bot');
  });

  it('un marcador de plantilla no cuenta como token configurado', () => {
    const config = conBot({ ADMIN_TELEGRAM_BOT_TOKEN: 'CAMBIAR_TOKEN_BOTFATHER' });
    expect(config.ADMIN_TELEGRAM_BOT_TOKEN).toBeUndefined();
  });

  it('el estado cuenta los avisos enviados y el último envío', async () => {
    const emisor = createAdminAlerter({ config: conBot(), transport: createSimulatedTransport() });
    expect(emisor.estado()).toMatchObject({
      configurado: true,
      chatConfigurado: true,
      enviados: 0,
    });

    await emisor.enviar(aviso);
    await emisor.enviar({ ...aviso, level: 'info' });

    const estado = emisor.estado();
    expect(estado.enviados).toBe(2);
    expect(estado.ultimoEnvio).not.toBeNull();
  });
});
