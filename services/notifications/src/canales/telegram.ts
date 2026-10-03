import type {
  ChannelAdapter,
  ChannelCapabilities,
  InboundMessage,
  OutboundMessage,
  SendResult,
} from '@odontocrm/contracts';

import type { NotificationsConfig } from '../config.js';
import type { TelegramUpdate } from '../telegram.js';
import {
  createHttpTransport,
  createSimulatedTransport,
  type TelegramTransport,
} from '../telegram.js';

/**
 * Adaptador de Telegram (ADR 0029).
 *
 * Es el único que **sondea** (`getUpdates` con long polling, ADR 0008): por dentro
 * saca las actualizaciones y las entrega ya normalizadas al núcleo. Tiene botones
 * (teclado en línea), adjuntos (el `.ics`) y comandos con barra.
 */
export interface TelegramAdapterOptions {
  config: NotificationsConfig;
  /** Transporte ya construido (real o simulado) para pruebas. */
  transport?: TelegramTransport;
  /** Cada cuánto se reintenta si el long polling falla. */
  retryDelayMs?: number;
}

const TELEGRAM_CAPABILITIES: ChannelCapabilities = {
  botones: true,
  documentos: true,
  comandos: true,
  plantillasAprobadas: false,
};

export const toInbound = (update: TelegramUpdate): InboundMessage | null => {
  const callback = update.callback_query;
  const message = update.message;
  const chatId = callback?.message?.chat.id ?? message?.chat.id;
  if (chatId === undefined) return null;

  const texto = message?.text ?? null;
  const accion = callback?.data ?? null;
  if ((texto ?? '').trim() === '' && (accion ?? '').trim() === '') return null;

  return {
    canal: 'telegram',
    direccion: String(chatId),
    usuario: callback?.from?.username ?? message?.from?.username ?? null,
    texto,
    accion,
    eventoId: String(update.update_id),
    recibidoEn: new Date().toISOString(),
  };
};

export const createTelegramAdapter = (options: TelegramAdapterOptions): ChannelAdapter => {
  const { config } = options;
  const transport =
    options.transport ??
    (config.TELEGRAM_BOT_TOKEN === undefined
      ? createSimulatedTransport()
      : createHttpTransport(config, config.TELEGRAM_BOT_TOKEN));

  let entregar: ((entrante: InboundMessage) => Promise<void>) | null = null;
  let offset = 0;
  let running = false;
  let stopping = false;

  const cycle = async (): Promise<void> => {
    const updates = await transport.getUpdates(offset, config.TELEGRAM_POLL_TIMEOUT_SECONDS);
    for (const update of updates) {
      offset = update.update_id + 1;
      const inbound = toInbound(update);
      if (inbound === null) continue;
      // El núcleo decide si es duplicado (idempotencia por eventoId).
      if (entregar !== null) await entregar(inbound);
    }
  };

  return {
    id: 'telegram',
    capacidades: TELEGRAM_CAPABILITIES,

    iniciar: async (handler) => {
      entregar = handler;
      if (running || stopping) return;
      running = true;

      const loop = async (): Promise<void> => {
        while (!stopping) {
          try {
            await cycle();
          } catch {
            // El long polling puede fallar por red: se espera y se sigue.
            await new Promise((resolve) => setTimeout(resolve, options.retryDelayMs ?? 5_000));
          }
        }
        running = false;
      };
      void loop();
    },

    detener: async () => {
      stopping = true;
      for (let attempt = 0; attempt < 40 && running; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    },

    enviar: async (saliente: OutboundMessage): Promise<SendResult> => {
      if (saliente.documento !== undefined) {
        const resultado = await transport.sendDocument(
          saliente.direccion,
          {
            filename: saliente.documento.nombre,
            content: saliente.documento.contenido,
            mime: saliente.documento.mime,
          },
          saliente.texto,
        );
        return { idMensaje: resultado.messageId };
      }

      const resultado = await transport.sendMessage(
        saliente.direccion,
        saliente.texto,
        saliente.botones === undefined || saliente.botones.length === 0
          ? {}
          : {
              buttons: saliente.botones.map((boton) => ({
                text: boton.etiqueta,
                data: boton.accion,
              })),
            },
      );
      return { idMensaje: resultado.messageId };
    },

    identidad: async () => {
      try {
        const me = await transport.getMe();
        return { nombre: me.name, usuario: me.username, conectado: me.username !== null };
      } catch {
        return { nombre: null, usuario: null, conectado: false };
      }
    },
  };
};
