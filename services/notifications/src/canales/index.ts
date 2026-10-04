import type { ChannelAdapter, InboundMessage } from '@odontocrm/contracts';

import { telegramMode, type NotificationsConfig } from '../config.js';
import { createAdapterRegistry, type AdapterRegistry } from './adaptador.js';
import { createTelegramAdapter } from './telegram.js';
import { createTransport, type TelegramTransport } from './telegram-api.js';
import { createWhatsAppAdapter, whatsappCredentials } from './whatsapp.js';

/** Los canales activos del servicio y lo que hace falta para mostrarlos en la bandeja. */
export interface CanalesHandle {
  /** Registro de adaptadores: por aquí salen y entran todos los mensajes. */
  registry: AdapterRegistry;
  /** Transporte de Telegram (real o simulado), para el estado del bot. */
  transport: TelegramTransport;
  modoTelegram: 'real' | 'simulado';
  /** Adaptadores que reciben mensajes por webhook (WhatsApp): la ruta los publica. */
  webhooks: readonly ChannelAdapter[];
}

/**
 * Construye los adaptadores según la configuración (ADR 0029): Telegram siempre
 * (real con token, simulado sin él) y WhatsApp **solo** si están sus credenciales.
 * Añadir un canal nuevo es escribir su adaptador y registrarlo aquí.
 */
export const createChannelAdapters = (
  config: NotificationsConfig,
  options: {
    onError?: (error: unknown, entrante: InboundMessage) => void;
    onAviso?: (error: unknown, contexto: string) => void;
  } = {},
): CanalesHandle => {
  const modo = telegramMode(config);
  const transport = createTransport(config, modo);

  const adapters: ChannelAdapter[] = [
    createTelegramAdapter({
      config,
      transport,
      ...(options.onAviso === undefined
        ? {}
        : { onError: (error) => options.onAviso?.(error, 'menu_de_comandos') }),
    }),
  ];

  const credentials = whatsappCredentials(config);
  if (credentials !== null) {
    adapters.push(
      createWhatsAppAdapter({
        credentials,
        config,
        ...(options.onError === undefined ? {} : { onError: options.onError }),
      }),
    );
  }

  return {
    registry: createAdapterRegistry(adapters),
    transport,
    modoTelegram: modo,
    webhooks: adapters.filter((adapter) => adapter.webhook !== undefined),
  };
};
