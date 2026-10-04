import { BOT_COMMANDS } from '@odontocrm/contracts';
import { describe, expect, it } from 'vitest';

import { createTelegramAdapter } from './telegram.js';
import { createSimulatedTransport, type TelegramTransport } from './telegram-api.js';
import { loadNotificationsConfig } from '../config.js';

/**
 * El menú de comandos es lo que hace usable el bot para quien no es técnico: al
 * pulsar `/` (o el botón junto al campo de texto) aparece la lista. Se registra
 * al arrancar desde el catálogo del contrato, y estas pruebas fijan las tres
 * cosas que importan: que se registre, que **no** se intente sin token, y que si
 * falla no se lleve por delante al bot.
 */

const baseEnv = {
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgres://odonto_notifications:clave@127.0.0.1:5432/odonto_notifications',
} as const;

const configReal = () =>
  loadNotificationsConfig({
    ...baseEnv,
    TELEGRAM_MODE: 'real',
    TELEGRAM_BOT_TOKEN: '1234567890:token-de-prueba-para-el-menu',
  });

const configSimulado = () => loadNotificationsConfig({ ...baseEnv, TELEGRAM_MODE: 'simulado' });

describe('menú de comandos de Telegram', () => {
  it('se registra al arrancar, con el catálogo del contrato y en su orden', async () => {
    // Con `getUpdates` vacío y una espera corta: el bucle de sondeo no estorba.
    const transport: TelegramTransport = {
      ...createSimulatedTransport(),
      getUpdates: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return [];
      },
    };
    const adapter = createTelegramAdapter({ config: configReal(), transport, retryDelayMs: 20 });

    await adapter.iniciar(async () => undefined);
    await adapter.detener();

    expect(transport.menu.map((comando) => comando.command)).toEqual(
      BOT_COMMANDS.map((comando) => comando.comando),
    );
    expect(transport.menu[0]?.description).toBe(BOT_COMMANDS[0]?.descripcion);
  });

  it('sin token (modo simulado) no se toca el menú de Telegram', async () => {
    const transport = createSimulatedTransport();
    const adapter = createTelegramAdapter({ config: configSimulado(), transport });

    await adapter.iniciar(async () => undefined);
    await adapter.detener();

    expect(transport.menu).toHaveLength(0);
  });

  it('si registrar el menú falla, el bot sigue funcionando', async () => {
    const avisos: unknown[] = [];
    const transport: TelegramTransport = {
      ...createSimulatedTransport(),
      setMyCommands: async () => {
        throw new Error('Telegram no responde');
      },
      getUpdates: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return [];
      },
    };
    const adapter = createTelegramAdapter({
      config: configReal(),
      transport,
      retryDelayMs: 20,
      onError: (error) => avisos.push(error),
    });

    // No debe lanzar: el menú es una comodidad, no un requisito para atender.
    await expect(adapter.iniciar(async () => undefined)).resolves.toBeUndefined();
    await adapter.detener();

    expect(avisos).toHaveLength(1);
    expect((avisos[0] as Error).message).toBe('Telegram no responde');
  });
});
