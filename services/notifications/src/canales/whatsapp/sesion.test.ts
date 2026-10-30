import { Boom } from '@hapi/boom';
import { DisconnectReason, initAuthCreds } from '@whiskeysockets/baileys';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AdminAlerter } from '../../alertas.js';
import { loadNotificationsConfig } from '../../config.js';
import type { NotificationsDb } from '../../db/client.js';
import type { WhatsAppAuthHandle } from './auth-store.js';
import type { WhatsAppSessionStore } from './estado-store.js';
import { CanalNoDisponibleError } from './limitador.js';
import { createWhatsAppSesion, type WhatsAppSessionAudit } from './sesion.js';
import { FakeWhatsAppSocket } from './socket-falso.js';

const config = loadNotificationsConfig({
  DATABASE_URL: 'postgres://odonto/x',
  WHATSAPP_ENABLED: 'true',
  WHATSAPP_PROVIDER: 'baileys',
  WHATSAPP_TYPING: 'false',
  WHATSAPP_SEND_MIN_INTERVAL_MS: '1000',
  WHATSAPP_SEND_MAX_INTERVAL_MS: '1000',
  WHATSAPP_ALERT_AFTER_MINUTES: '1',
});

const authFalso = (linked: boolean): WhatsAppAuthHandle & { clearCalls: () => number } => {
  let vinculada = linked;
  let limpiezas = 0;
  return {
    state: {
      creds: initAuthCreds(),
      keys: { get: async () => ({}), set: async () => undefined },
    },
    saveCreds: async () => undefined,
    clear: async () => {
      limpiezas += 1;
      vinculada = false;
    },
    hasCreds: async () => vinculada,
    clearCalls: () => limpiezas,
  };
};

const storeFalso = (): WhatsAppSessionStore & { guardados: number } => {
  let guardados = 0;
  return {
    load: async () => null,
    save: async () => {
      guardados += 1;
    },
    reservarEnvio: async () => true,
    guardados,
  };
};

const alertasFalso = (): AdminAlerter & { enviados: number } => {
  let enviados = 0;
  const alertas = {
    enviar: async () => {
      enviados += 1;
      return { enviado: true, motivo: null };
    },
    estado: () => ({ configurado: true, chatConfigurado: true, enviados, ultimoEnvio: null }),
    get enviados(): number {
      return enviados;
    },
  };
  return alertas as AdminAlerter & { enviados: number };
};

const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const crear = (options: { linked?: boolean; autoQr?: boolean } = {}) => {
  const sockets: FakeWhatsAppSocket[] = [];
  const auth = authFalso(options.linked ?? true);
  const store = storeFalso();
  const alertas = alertasFalso();
  const auditoria: WhatsAppSessionAudit[] = [];
  const sesion = createWhatsAppSesion({
    config,
    db: {} as NotificationsDb,
    auth,
    store,
    alertas,
    onAuditoria: async (evento) => {
      auditoria.push(evento);
    },
    makeSocket: () => {
      const socket = new FakeWhatsAppSocket();
      socket.user = { id: '584141234567:1@s.whatsapp.net', name: 'Consultorio' };
      sockets.push(socket);
      if (options.autoQr === true) {
        setTimeout(() => socket.emit('connection.update', { qr: 'qr-de-prueba' }), 0);
      }
      return socket;
    },
  });
  return { sesion, sockets, auth, store, alertas, auditoria };
};

afterEach(() => {
  vi.useRealTimers();
});

describe('sesión de WhatsApp por Baileys', () => {
  it('se vincula por código, abre la sesión y avisa del emparejamiento', async () => {
    const { sesion, sockets, auditoria } = crear({ linked: false });
    await sesion.iniciar(async () => undefined);
    const vista = await sesion.pair({ metodo: 'codigo', telefono: '0414-1234567' });
    expect(vista.estado).toBe('esperando_qr');
    expect(vista.pairingCode).toBe('ABCD-1234');

    sockets[0]?.emit('connection.update', { connection: 'open' });
    await flush();
    expect((await sesion.vista()).estado).toBe('conectado');
    expect(auditoria.some((evento) => evento.accion === 'whatsapp_session_paired')).toBe(true);
  });

  it('genera un QR con data URL cuando se pide vincular por QR', async () => {
    const { sesion } = crear({ linked: false, autoQr: true });
    await sesion.iniciar(async () => undefined);
    const vista = await sesion.pair({ metodo: 'qr' });
    expect(vista.estado).toBe('esperando_qr');
    expect(vista.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(vista.qrExpiraEn).not.toBeNull();
  });

  it('reconecta con backoff tras un 515 y vuelve a conectar', async () => {
    vi.useFakeTimers();
    const { sesion, sockets } = crear({ linked: true });
    await sesion.iniciar(async () => undefined);
    sockets[0]?.emit('connection.update', { connection: 'open' });
    await vi.advanceTimersByTimeAsync(0);
    expect((await sesion.vista()).estado).toBe('conectado');

    sockets[0]?.emit('connection.update', {
      connection: 'close',
      lastDisconnect: {
        error: new Boom('restart', { statusCode: DisconnectReason.restartRequired }),
        date: new Date(),
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect((await sesion.vista()).estado).toBe('reconectando');

    await vi.advanceTimersByTimeAsync(2_000);
    expect(sockets).toHaveLength(2);
    sockets[1]?.emit('connection.update', { connection: 'open' });
    await vi.advanceTimersByTimeAsync(0);
    expect((await sesion.vista()).estado).toBe('conectado');
  });

  it('un loggedOut borra las credenciales, cierra la sesión y avisa', async () => {
    const { sesion, sockets, auth, alertas, auditoria } = crear({ linked: true });
    await sesion.iniciar(async () => undefined);
    sockets[0]?.emit('connection.update', { connection: 'open' });
    await flush();

    sockets[0]?.emit('connection.update', {
      connection: 'close',
      lastDisconnect: {
        error: new Boom('logged out', { statusCode: DisconnectReason.loggedOut }),
        date: new Date(),
      },
    });
    await flush();

    expect((await sesion.vista()).estado).toBe('sesion_cerrada');
    expect(auth.clearCalls()).toBe(1);
    expect((alertas as AdminAlerter & { enviados: number }).enviados).toBeGreaterThan(0);
    expect(auditoria.some((evento) => evento.accion === 'whatsapp_session_logged_out')).toBe(true);
  });

  it('un 440 deja la sesión reemplazada y no reconecta sola', async () => {
    vi.useFakeTimers();
    const { sesion, sockets } = crear({ linked: true });
    await sesion.iniciar(async () => undefined);
    sockets[0]?.emit('connection.update', { connection: 'open' });
    await vi.advanceTimersByTimeAsync(0);

    sockets[0]?.emit('connection.update', {
      connection: 'close',
      lastDisconnect: {
        error: new Boom('replaced', { statusCode: DisconnectReason.connectionReplaced }),
        date: new Date(),
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect((await sesion.vista()).estado).toBe('reemplazada');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sockets).toHaveLength(1);
  });

  it('enviar sin conexión se difiere sin gastar intentos', async () => {
    const { sesion } = crear({ linked: false });
    await sesion.iniciar(async () => undefined);
    await expect(sesion.enviar({ direccion: '04141234567', texto: 'hola' })).rejects.toBeInstanceOf(
      CanalNoDisponibleError,
    );
  });

  it('envía texto al JID correcto y registra el mensaje para getMessage', async () => {
    const { sesion, sockets } = crear({ linked: true });
    await sesion.iniciar(async () => undefined);
    sockets[0]?.emit('connection.update', { connection: 'open' });
    await flush();

    const resultado = await sesion.enviar({ direccion: '0414-1234567', texto: 'Hola' });
    expect(resultado.idMensaje).toBe('fake-1');
    expect(sockets[0]?.enviados[0]?.jid).toBe('584141234567@s.whatsapp.net');
  });

  it('detener cierra el socket sin cerrar la sesión de WhatsApp', async () => {
    const { sesion, sockets } = crear({ linked: true });
    await sesion.iniciar(async () => undefined);
    sockets[0]?.emit('connection.update', { connection: 'open' });
    await flush();

    await sesion.detener();
    expect(sockets[0]?.endCalls).toBe(1);
    expect(sockets[0]?.logoutCalls).toBe(0);
  });
});
