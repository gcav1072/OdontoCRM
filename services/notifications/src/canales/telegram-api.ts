import type { NotificationsConfig } from '../config.js';

/**
 * Cliente de la API de Telegram (llamadas HTTP sueltas) y su doble simulado.
 *
 * Es un detalle del **adaptador** de Telegram (ADR 0029): el núcleo conversacional
 * no importa nada de este archivo. Con `fetch` basta para sondeo y tres llamadas,
 * así que no hace falta grammY ni Telegraf.
 */
export interface TelegramChat {
  id: number | string;
  username?: string;
  first_name?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: TelegramChat;
    from?: { id: number | string; username?: string; first_name?: string };
    text?: string;
  };
  callback_query?: {
    id: string;
    data?: string;
    from?: { id: number | string; username?: string; first_name?: string };
    message?: { chat: TelegramChat; message_id: number };
  };
}

export interface BotIdentity {
  id: string;
  username: string | null;
  name: string | null;
}

export interface SendResult {
  messageId: string;
}

export interface InlineButton {
  text: string;
  /** Datos que vuelven como `callback_query` (se guardan tal cual). */
  data: string;
}

export interface SendOptions {
  buttons?: readonly InlineButton[];
}

export interface OutgoingDocument {
  filename: string;
  content: Buffer;
  mime: string;
}

/** Mensaje saliente registrado por el transporte simulado (para pruebas). */
export interface SentMessage {
  chatId: string;
  text: string;
  at: string;
  document?: { filename: string; size: number; mime: string };
}

/**
 * Transporte de Telegram. Hay dos implementaciones: la real (HTTP contra la API de
 * Telegram) y la **simulada**, que se usa cuando no hay token: registra los envíos
 * para poder probar todo el flujo (cola, reintentos, `.ics`) sin red ni bot.
 */
export interface TelegramTransport {
  readonly mode: 'real' | 'simulado';
  /** Envíos realizados (solo el transporte simulado los conserva). */
  readonly sent: SentMessage[];
  getMe: () => Promise<BotIdentity>;
  getUpdates: (offset: number, timeoutSeconds: number) => Promise<TelegramUpdate[]>;
  sendMessage: (chatId: string, text: string, options?: SendOptions) => Promise<SendResult>;
  sendDocument: (
    chatId: string,
    document: OutgoingDocument,
    caption?: string,
  ) => Promise<SendResult>;
  answerCallbackQuery: (callbackId: string, text?: string) => Promise<void>;
}

const callApi = async <T>(
  config: NotificationsConfig,
  token: string,
  method: string,
  payload?: Record<string, unknown>,
): Promise<T> => {
  const response = await fetch(`${config.TELEGRAM_API_BASE}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
    signal: AbortSignal.timeout((config.TELEGRAM_POLL_TIMEOUT_SECONDS + 15) * 1000),
  });

  const body = (await response.json()) as {
    ok: boolean;
    result?: T;
    description?: string;
  };

  if (body.ok !== true || body.result === undefined) {
    // Nunca se incluye el token en el error: podría acabar en un registro o en la API.
    throw new Error(`Telegram ${method} falló: ${body.description ?? String(response.status)}`);
  }
  return body.result;
};

const keyboard = (buttons?: readonly InlineButton[]) =>
  buttons === undefined || buttons.length === 0
    ? undefined
    : {
        inline_keyboard: buttons.map((button) => [
          { text: button.text, callback_data: button.data },
        ]),
      };

/** Transporte real: un `fetch` por llamada, con el token siempre en la URL de la API. */
export const createHttpTransport = (
  config: NotificationsConfig,
  token: string,
): TelegramTransport => ({
  mode: 'real',
  sent: [],

  getMe: async () => {
    const me = await callApi<{ id: number; username?: string; first_name?: string }>(
      config,
      token,
      'getMe',
    );
    return {
      id: String(me.id),
      username: me.username ?? null,
      name: me.first_name ?? null,
    };
  },

  getUpdates: async (offset, timeoutSeconds) => {
    const updates = await callApi<TelegramUpdate[]>(config, token, 'getUpdates', {
      offset,
      timeout: timeoutSeconds,
      allowed_updates: ['message', 'callback_query'],
    });
    return updates;
  },

  sendMessage: async (chatId, text, options) => {
    const message = await callApi<{ message_id: number }>(config, token, 'sendMessage', {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
      ...(keyboard(options?.buttons) === undefined
        ? {}
        : { reply_markup: keyboard(options?.buttons) }),
    });
    return { messageId: String(message.message_id) };
  },

  sendDocument: async (chatId, document, caption) => {
    // El `.ics` va como archivo: Telegram no lo previsualiza, pero el paciente lo
    // descarga y su calendario lo abre.
    const form = new FormData();
    form.append('chat_id', chatId);
    if (caption !== undefined) form.append('caption', caption);
    form.append(
      'document',
      new Blob([new Uint8Array(document.content)], { type: document.mime }),
      document.filename,
    );

    const response = await fetch(`${config.TELEGRAM_API_BASE}/bot${token}/sendDocument`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await response.json()) as {
      ok: boolean;
      result?: { message_id: number };
      description?: string;
    };
    if (body.ok !== true || body.result === undefined) {
      throw new Error(
        `Telegram sendDocument falló: ${body.description ?? String(response.status)}`,
      );
    }
    return { messageId: String(body.result.message_id) };
  },

  answerCallbackQuery: async (callbackId, text) => {
    await callApi(config, token, 'answerCallbackQuery', {
      callback_query_id: callbackId,
      ...(text === undefined ? {} : { text }),
    });
  },
});

/**
 * Transporte simulado: no habla con Telegram, pero se comporta igual (identidad,
 * envíos registrados y sin actualizaciones entrantes). Es el modo por defecto en
 * desarrollo y en las pruebas, y lo que permite trabajar sin token.
 */
export const createSimulatedTransport = (): TelegramTransport => {
  const sent: SentMessage[] = [];

  return {
    mode: 'simulado',
    sent,

    getMe: async () => ({ id: 'simulado', username: null, name: 'Bot simulado' }),

    getUpdates: async () => [],

    sendMessage: async (chatId, text) => {
      sent.push({ chatId, text, at: new Date().toISOString() });
      return { messageId: `simulado-${String(sent.length)}` };
    },

    sendDocument: async (chatId, document, caption) => {
      sent.push({
        chatId,
        text: caption ?? '',
        at: new Date().toISOString(),
        document: {
          filename: document.filename,
          size: document.content.byteLength,
          mime: document.mime,
        },
      });
      return { messageId: `simulado-doc-${String(sent.length)}` };
    },

    answerCallbackQuery: async () => undefined,
  };
};

export const createTransport = (
  config: NotificationsConfig,
  mode: 'real' | 'simulado',
): TelegramTransport =>
  mode === 'real' && config.TELEGRAM_BOT_TOKEN !== undefined
    ? createHttpTransport(config, config.TELEGRAM_BOT_TOKEN)
    : createSimulatedTransport();
