import type {
  ChannelAdapter,
  ChannelCapabilities,
  InboundMessage,
  OutboundMessage,
  SendResult,
  WebhookRequest,
  WebhookResponse,
} from '@odontocrm/contracts';
import { createHmac, timingSafeEqual } from 'node:crypto';

import type { NotificationsConfig } from '../config.js';

/**
 * Adaptador de **WhatsApp Cloud API** (ADR 0029).
 *
 * A diferencia de Telegram, WhatsApp **empuja**: Meta llama a un webhook HTTPS
 * (por eso el túnel de Cloudflare). Aquí se valida la firma, se normaliza el
 * mensaje y se responde rápido; el núcleo conversacional no cambia nada.
 *
 * Faltan las credenciales para activarlo (`WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID`,
 * `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`): sin ellas el adaptador no se
 * registra y el servicio sigue con Telegram. Cuando estén, se enciende solo.
 */
const WHATSAPP_CAPABILITIES: ChannelCapabilities = {
  botones: true,
  documentos: true,
  comandos: false,
  plantillasAprobadas: true,
};

export interface WhatsAppCredentials {
  token: string;
  phoneNumberId: string;
  verifyToken: string;
  appSecret: string;
}

export const whatsappCredentials = (config: NotificationsConfig): WhatsAppCredentials | null => {
  const token = config.WHATSAPP_TOKEN;
  const phoneNumberId = config.WHATSAPP_PHONE_ID;
  const verifyToken = config.WHATSAPP_VERIFY_TOKEN;
  const appSecret = config.WHATSAPP_APP_SECRET;
  if (
    token === undefined ||
    phoneNumberId === undefined ||
    verifyToken === undefined ||
    appSecret === undefined
  ) {
    return null;
  }
  return { token, phoneNumberId, verifyToken, appSecret };
};

/** Firma de Meta: `sha256=<hmac del cuerpo con app_secret>`. */
export const validateSignature = (
  rawBody: string,
  header: string | undefined,
  appSecret: string,
): boolean => {
  if (header === undefined || !header.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody, 'utf8').digest('hex');
  const received = header.slice('sha256='.length);
  if (received.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(received), Buffer.from(expected));
};

interface WhatsAppPayload {
  entry?: {
    changes?: {
      value?: {
        contacts?: { profile?: { name?: string }; wa_id?: string }[];
        messages?: {
          from?: string;
          id?: string;
          timestamp?: string;
          type?: string;
          text?: { body?: string };
          button?: { payload?: string; text?: string };
          interactive?: {
            type?: string;
            button_reply?: { id?: string; title?: string };
            list_reply?: { id?: string; title?: string };
          };
        }[];
      };
    }[];
  }[];
}

/** Convierte el webhook de Meta en mensajes normalizados. */
export const toInboundMessages = (payload: unknown): InboundMessage[] => {
  const parsed = payload as WhatsAppPayload;
  const messages: InboundMessage[] = [];

  for (const entry of parsed.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      const nombre = value?.contacts?.[0]?.profile?.name ?? null;
      for (const message of value?.messages ?? []) {
        if (message.from === undefined || message.id === undefined) continue;

        const accion =
          message.button?.payload ??
          message.interactive?.button_reply?.id ??
          message.interactive?.list_reply?.id ??
          null;

        messages.push({
          canal: 'whatsapp',
          direccion: message.from,
          usuario: nombre,
          texto: message.text?.body ?? message.button?.text ?? null,
          accion,
          eventoId: message.id,
          recibidoEn: new Date(
            message.timestamp === undefined ? Date.now() : Number(message.timestamp) * 1000,
          ).toISOString(),
        });
      }
    }
  }
  return messages;
};

export const createWhatsAppAdapter = (options: {
  credentials: WhatsAppCredentials;
  config: NotificationsConfig;
  /** Para pruebas: entrega los mensajes sin red (el webhook sigue siendo el real). */
  onInbound?: (entrante: InboundMessage) => Promise<void>;
}): ChannelAdapter => {
  const { credentials, config } = options;
  let entregar: ((entrante: InboundMessage) => Promise<void>) | null = options.onInbound ?? null;

  const graph = async (body: Record<string, unknown>): Promise<SendResult> => {
    const response = await fetch(
      `${config.WHATSAPP_API_BASE}/${credentials.phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${credentials.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ messaging_product: 'whatsapp', ...body }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    const parsed = (await response.json()) as {
      messages?: { id?: string }[];
      error?: { message?: string };
    };
    if (!response.ok || parsed.error !== undefined) {
      throw new Error(
        `WhatsApp rechazó el mensaje: ${parsed.error?.message ?? String(response.status)}`,
      );
    }
    return { idMensaje: parsed.messages?.[0]?.id ?? 'desconocido' };
  };

  return {
    id: 'whatsapp',
    capacidades: WHATSAPP_CAPABILITIES,

    // WhatsApp no sondea: los mensajes llegan por webhook.
    iniciar: async (handler) => {
      entregar = handler;
    },
    detener: async () => undefined,

    enviar: async (saliente: OutboundMessage): Promise<SendResult> => {
      if (saliente.documento !== undefined) {
        // El documento se sube primero como medio y luego se envía por identificador.
        const form = new FormData();
        form.append('messaging_product', 'whatsapp');
        form.append(
          'file',
          new Blob([new Uint8Array(saliente.documento.contenido)], {
            type: saliente.documento.mime,
          }),
          saliente.documento.nombre,
        );
        form.append('type', saliente.documento.mime);

        const upload = await fetch(
          `${config.WHATSAPP_API_BASE}/${credentials.phoneNumberId}/media`,
          {
            method: 'POST',
            headers: { authorization: `Bearer ${credentials.token}` },
            body: form,
            signal: AbortSignal.timeout(60_000),
          },
        );
        const media = (await upload.json()) as { id?: string; error?: { message?: string } };
        if (!upload.ok || media.id === undefined) {
          throw new Error(
            `WhatsApp no aceptó el archivo: ${media.error?.message ?? String(upload.status)}`,
          );
        }

        return graph({
          to: saliente.direccion,
          type: 'document',
          document: {
            id: media.id,
            filename: saliente.documento.nombre,
            ...(saliente.texto === '' ? {} : { caption: saliente.texto.slice(0, 1024) }),
          },
        });
      }

      const botones = saliente.botones ?? [];
      if (botones.length > 0 && botones.length <= 3) {
        return graph({
          to: saliente.direccion,
          type: 'interactive',
          interactive: {
            type: 'button',
            body: { text: saliente.texto.slice(0, 1024) },
            action: {
              buttons: botones.map((boton) => ({
                type: 'reply',
                reply: { id: boton.accion, title: boton.etiqueta.slice(0, 20) },
              })),
            },
          },
        });
      }

      return graph({
        to: saliente.direccion,
        type: 'text',
        text: { preview_url: false, body: saliente.texto.slice(0, 4096) },
      });
    },

    webhook: async (peticion: WebhookRequest): Promise<WebhookResponse> => {
      // 1) Verificación del webhook (Meta manda hub.challenge una sola vez).
      if (peticion.metodo === 'GET') {
        const modo = peticion.query['hub.mode'];
        const token = peticion.query['hub.verify_token'];
        const challenge = peticion.query['hub.challenge'] ?? '';
        if (modo === 'subscribe' && token === credentials.verifyToken) {
          return { estado: 200, cuerpo: challenge, contentType: 'text/plain' };
        }
        return { estado: 403, cuerpo: 'verificación rechazada', contentType: 'text/plain' };
      }

      // 2) Firma obligatoria: sin ella no se procesa nada.
      const firma = peticion.headers['x-hub-signature-256'];
      if (!validateSignature(peticion.rawBody, firma, credentials.appSecret)) {
        return { estado: 401, cuerpo: { error: 'firma inválida' } };
      }

      const entrantes = toInboundMessages(peticion.json);
      if (entregar !== null) {
        for (const entrante of entrantes) await entregar(entrante);
      }
      // Meta exige un 200 rápido: el núcleo ya procesó y contestó por su cuenta.
      return { estado: 200, cuerpo: { recibidos: entrantes.length } };
    },

    identidad: async () => {
      try {
        const response = await fetch(
          `${config.WHATSAPP_API_BASE}/${credentials.phoneNumberId}?fields=display_phone_number,verified_name`,
          {
            headers: { authorization: `Bearer ${credentials.token}` },
            signal: AbortSignal.timeout(15_000),
          },
        );
        const parsed = (await response.json()) as {
          display_phone_number?: string;
          verified_name?: string;
          error?: { message?: string };
        };
        if (!response.ok || parsed.error !== undefined) {
          return { nombre: null, usuario: null, conectado: false };
        }
        return {
          nombre: parsed.verified_name ?? null,
          usuario: parsed.display_phone_number ?? null,
          conectado: true,
        };
      } catch {
        return { nombre: null, usuario: null, conectado: false };
      }
    },
  };
};
