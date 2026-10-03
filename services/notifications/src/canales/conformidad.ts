import { createHmac } from 'node:crypto';
import type { ChannelAdapter, InboundMessage } from '@odontocrm/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { sendAdapted } from './adaptador.js';
import { createSimulatedAdapter, type SentMessage } from './simulado.js';
import { createTelegramAdapter } from './telegram.js';
import {
  createSimulatedTransport,
  type TelegramTransport,
  type TelegramUpdate,
} from './telegram-api.js';
import { createWhatsAppAdapter, type WhatsAppCredentials } from './whatsapp.js';
import { loadNotificationsConfig } from '../config.js';

/**
 * **Kit de conformidad de canales** (ADR 0029).
 *
 * El mismo juego de pruebas corre contra Telegram, WhatsApp y el adaptador
 * simulado: si un canal no lo pasa, no entra. Lo que se comprueba es el contrato
 * `ChannelAdapter`, no los detalles de cada proveedor:
 *
 *  1. los entrantes llegan al núcleo ya normalizados, con `(canal, dirección)`;
 *  2. la acción de un botón viaja tal cual;
 *  3. el `eventoId` es estable (base de la idempotencia del núcleo);
 *  4. se puede enviar texto, botones y el `.ics`;
 *  5. `detener()` es idempotente y `identidad()` cumple la forma del contrato;
 *  6. los canales con webhook validan la firma y rechazan lo que no la trae.
 */

/** Cómo se inyecta un mensaje por la puerta del canal y qué se puede observar. */
export interface CasoConformidad {
  nombre: string;
  preparar: () => Promise<CasoListo>;
}

export interface CasoListo {
  adapter: ChannelAdapter;
  /** Mensajes que recibió el núcleo (los llena el `iniciar` del adaptador). */
  entregados: InboundMessage[];
  /** Inyecta un mensaje como lo haría el canal (texto o botón pulsado). */
  inyectar: (entrada: {
    direccion: string;
    eventoId: string;
    texto?: string | null;
    accion?: string | null;
  }) => Promise<void>;
  /** Identificador tal como lo entrega el canal (Telegram numérico, WhatsApp wamid). */
  eventoEsperado?: (base: string) => string;
  /** Envíos observados, si el canal los registra (el simulado). */
  enviados?: SentMessage[];
  /** Firma del webhook, si el canal lo tiene. */
  webhook?: {
    firma: (cuerpo: string) => string;
    verificacion: Record<string, string>;
    verificacionInvalida: Record<string, string>;
    cuerpo: (entrada: {
      direccion: string;
      eventoId: string;
      texto?: string;
      accion?: string;
    }) => string;
  };
  limpiar?: () => Promise<void>;
}

/** Espera a que se cumpla una condición (los adaptadores entregan en segundo plano). */
const esperarA = async (
  condicion: () => boolean,
  descripcion: string,
  timeoutMs = 3_000,
): Promise<void> => {
  const inicio = Date.now();
  while (!condicion()) {
    if (Date.now() - inicio > timeoutMs)
      throw new Error(`Se agotó el tiempo esperando: ${descripcion}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const DOCUMENTO = {
  nombre: 'cita-000123.ics',
  contenido: Buffer.from('BEGIN:VCALENDAR\nEND:VCALENDAR\n', 'utf8'),
  mime: 'text/calendar; charset=utf-8',
};

const BOTONES = [
  { etiqueta: 'V', accion: 'doc:V' },
  { etiqueta: 'E', accion: 'doc:E' },
];

export const runChannelConformance = (caso: CasoConformidad): void => {
  describe(`conformidad del canal ${caso.nombre}`, () => {
    let actual: CasoListo;

    beforeEach(async () => {
      actual = await caso.preparar();
      // El núcleo recibe lo que el adaptador entrega: es lo único que hace aquí.
      await actual.adapter.iniciar(async (entrante) => {
        actual.entregados.push(entrante);
      });
    });

    afterEach(async () => {
      await actual.adapter.detener();
      await actual.limpiar?.();
    });

    it('entrega los entrantes normalizados con canal y dirección', async () => {
      await actual.inyectar({ direccion: '55501', eventoId: '900001', texto: 'quiero una cita' });
      await esperarA(() => actual.entregados.length === 1, 'el entrante llegue al núcleo');

      expect(actual.entregados[0]).toMatchObject({
        canal: actual.adapter.id,
        direccion: '55501',
        texto: 'quiero una cita',
        accion: null,
      });
    });

    it('conserva la acción del botón pulsado', async () => {
      await actual.inyectar({ direccion: '55502', eventoId: '900002', accion: 'doc:V' });
      await esperarA(() => actual.entregados.length === 1, 'el botón llegue al núcleo');

      expect(actual.entregados[0]?.accion).toBe('doc:V');
    });

    it('entrega un eventoId estable: el mismo evento dos veces no cambia de clave', async () => {
      await actual.inyectar({ direccion: '55503', eventoId: '900003', texto: 'hola' });
      await esperarA(() => actual.entregados.length === 1, 'llegue el primer evento');
      await actual.inyectar({ direccion: '55503', eventoId: '900003', texto: 'hola' });
      await esperarA(() => actual.entregados.length === 2, 'llegue el evento repetido');

      const esperado = actual.eventoEsperado?.('900003') ?? '900003';
      expect(actual.entregados.map((mensaje) => mensaje.eventoId)).toEqual([esperado, esperado]);
    });

    it('envía texto y devuelve el identificador del mensaje', async () => {
      const resultado = await actual.adapter.enviar({ direccion: '55504', texto: 'Hola paciente' });

      expect(resultado.idMensaje.length).toBeGreaterThan(0);
    });

    it('envía botones cuando el canal los soporta y numera cuando no', async () => {
      const { opciones } = await sendAdapted(actual.adapter, {
        direccion: '55505',
        texto: '¿Qué documento tienes?',
        botones: BOTONES,
      });

      if (actual.adapter.capacidades.botones) {
        expect(opciones.size).toBe(0);
      } else {
        // Sin botones, las opciones van numeradas y el núcleo las recuerda.
        expect([...opciones.entries()]).toEqual([
          ['1', 'doc:V'],
          ['2', 'doc:E'],
        ]);
      }
    });

    it('adjunta el documento .ics cuando el canal lo soporta', async () => {
      if (!actual.adapter.capacidades.documentos) return;

      const resultado = await actual.adapter.enviar({
        direccion: '55506',
        texto: 'Tu cita',
        documento: DOCUMENTO,
      });

      expect(resultado.idMensaje.length).toBeGreaterThan(0);
      if (actual.enviados !== undefined) {
        expect(actual.enviados.at(-1)?.documento?.nombre).toBe(DOCUMENTO.nombre);
      }
    });

    it('detener es idempotente e identidad cumple el contrato', async () => {
      await actual.adapter.detener();
      await actual.adapter.detener();

      const identidad = await actual.adapter.identidad();
      // El adaptador no toca la base: aquí solo se comprueba la forma del contrato.
      expect([null, 'string']).toContain(
        identidad.nombre === null ? null : typeof identidad.nombre,
      );
      expect([null, 'string']).toContain(
        identidad.usuario === null ? null : typeof identidad.usuario,
      );
      expect(typeof identidad.conectado).toBe('boolean');
    });

    it('el webhook exige firma válida y verifica el token', async () => {
      const webhook = actual.webhook;
      if (webhook === undefined || actual.adapter.webhook === undefined) return;

      // 1) Verificación del webhook (Meta manda hub.challenge una sola vez).
      const verificacion = await actual.adapter.webhook({
        metodo: 'GET',
        query: webhook.verificacion,
        headers: {},
        rawBody: '',
        json: null,
      });
      expect(verificacion.estado).toBe(200);
      expect(String(verificacion.cuerpo)).toBe(webhook.verificacion['hub.challenge']);

      const rechazada = await actual.adapter.webhook({
        metodo: 'GET',
        query: webhook.verificacionInvalida,
        headers: {},
        rawBody: '',
        json: null,
      });
      expect(rechazada.estado).toBe(403);

      // 2) Sin firma no se procesa nada.
      const cuerpo = webhook.cuerpo({ direccion: '55507', eventoId: 'wamid.1', texto: 'cita' });
      const sinFirma = await actual.adapter.webhook({
        metodo: 'POST',
        query: {},
        headers: { 'content-type': 'application/json' },
        rawBody: cuerpo,
        json: JSON.parse(cuerpo) as unknown,
      });
      expect(sinFirma.estado).toBe(401);
      expect(actual.entregados).toHaveLength(0);

      // 3) Con la firma del proveedor sí se entrega.
      const conFirma = await actual.adapter.webhook({
        metodo: 'POST',
        query: {},
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': webhook.firma(cuerpo),
        },
        rawBody: cuerpo,
        json: JSON.parse(cuerpo) as unknown,
      });
      expect(conFirma.estado).toBe(200);
      await esperarA(() => actual.entregados.length === 1, 'el mensaje del webhook llegue');
      expect(actual.entregados[0]).toMatchObject({ direccion: '55507', texto: 'cita' });
    });
  });
};

/* ── Casos concretos ───────────────────────────────────────────────────────── */

const baseEnv = {
  LOG_LEVEL: 'silent',
  TELEGRAM_MODE: 'simulado',
  // Los adaptadores no tocan la base: la cadena solo satisface la configuración.
  DATABASE_URL: 'postgres://odonto_notifications:clave@127.0.0.1:5432/odonto_notifications',
} as const;

/** Telegram: sondea por dentro, así que se le da un transporte de doble. */
export const casoTelegram = (): CasoConformidad => ({
  nombre: 'telegram',
  preparar: async () => {
    // Modo real con transporte de doble: así el bucle de sondeo es el de verdad.
    const config = loadNotificationsConfig({
      ...baseEnv,
      TELEGRAM_MODE: 'real',
      TELEGRAM_BOT_TOKEN: '1234567890:token-de-prueba-para-el-kit',
    });
    const pendientes: TelegramUpdate[] = [];
    const base = createSimulatedTransport();

    const transport: TelegramTransport = {
      ...base,
      // Imita el long polling: sin novedades espera un poco (nada de girar en vacío).
      getUpdates: async () => {
        const lote = pendientes.splice(0, pendientes.length);
        if (lote.length === 0) await new Promise((resolve) => setTimeout(resolve, 25));
        return lote;
      },
    };

    const entregados: InboundMessage[] = [];
    const adapter = createTelegramAdapter({ config, transport, retryDelayMs: 30 });

    return {
      adapter,
      entregados,
      eventoEsperado: (base_) => String(Number(base_)),
      inyectar: async ({ direccion, eventoId, texto, accion }) => {
        const updateId = Number(eventoId);
        pendientes.push(
          accion === null || accion === undefined
            ? {
                update_id: updateId,
                message: { message_id: updateId, chat: { id: direccion }, text: texto ?? '' },
              }
            : {
                update_id: updateId,
                callback_query: {
                  id: String(updateId),
                  data: accion,
                  message: { chat: { id: direccion }, message_id: updateId },
                },
              },
        );
      },
    };
  },
});

/** WhatsApp Cloud API: empuja por webhook y firma con el `app_secret`. */
export const casoWhatsApp = (): CasoConformidad => ({
  nombre: 'whatsapp',
  preparar: async () => {
    const config = loadNotificationsConfig({ ...baseEnv });
    const credentials: WhatsAppCredentials = {
      token: 'token-de-prueba-para-el-kit',
      phoneNumberId: '1234567890',
      verifyToken: 'verify-token-de-prueba',
      appSecret: 'app-secret-de-prueba',
    };

    const entregados: InboundMessage[] = [];
    const fetchOriginal = globalThis.fetch;
    // El adaptador solo sale a la red al enviar: se responde como lo haría Meta
    // (la subida de un medio devuelve un id; el envío, un wamid).
    globalThis.fetch = (async (url: string | URL | Request) => {
      const destino = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      const cuerpo = destino.endsWith('/media')
        ? { id: 'media-1' }
        : { messages: [{ id: 'wamid.salida-1' }] };
      return new Response(JSON.stringify(cuerpo), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const adapter = createWhatsAppAdapter({
      credentials,
      config,
      onInbound: async (entrante) => {
        entregados.push(entrante);
      },
    });

    return {
      adapter,
      entregados,
      inyectar: async ({ direccion, eventoId, texto, accion }) => {
        const cuerpo = cuerpoWhatsApp({ direccion, eventoId, texto, accion });
        await adapter.webhook?.({
          metodo: 'POST',
          query: {},
          headers: {
            'content-type': 'application/json',
            'x-hub-signature-256': `sha256=${createHmac('sha256', credentials.appSecret)
              .update(cuerpo, 'utf8')
              .digest('hex')}`,
          },
          rawBody: cuerpo,
          json: JSON.parse(cuerpo) as unknown,
        });
      },
      webhook: {
        firma: (cuerpo) =>
          `sha256=${createHmac('sha256', credentials.appSecret).update(cuerpo, 'utf8').digest('hex')}`,
        verificacion: {
          'hub.mode': 'subscribe',
          'hub.verify_token': credentials.verifyToken,
          'hub.challenge': 'reto-123',
        },
        verificacionInvalida: {
          'hub.mode': 'subscribe',
          'hub.verify_token': 'token-equivocado',
          'hub.challenge': 'reto-123',
        },
        cuerpo: (entrada) => cuerpoWhatsApp(entrada),
      },
      limpiar: async () => {
        globalThis.fetch = fetchOriginal;
      },
    };
  },
});

const cuerpoWhatsApp = (entrada: {
  direccion: string;
  eventoId: string;
  texto?: string | null;
  accion?: string | null;
}): string =>
  JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '1',
        changes: [
          {
            field: 'messages',
            value: {
              contacts: [{ profile: { name: 'Paciente de prueba' }, wa_id: entrada.direccion }],
              messages: [
                entrada.accion === null || entrada.accion === undefined
                  ? {
                      from: entrada.direccion,
                      id: entrada.eventoId,
                      timestamp: '1791000000',
                      type: 'text',
                      text: { body: entrada.texto ?? '' },
                    }
                  : {
                      from: entrada.direccion,
                      id: entrada.eventoId,
                      timestamp: '1791000000',
                      type: 'interactive',
                      interactive: {
                        type: 'button_reply',
                        button_reply: { id: entrada.accion, title: 'opción' },
                      },
                    },
              ],
            },
          },
        ],
      },
    ],
  });

/** Simulado: registra los envíos y entrega lo que se le pide desde la prueba. */
export const casoSimulado = (): CasoConformidad => ({
  nombre: 'simulado',
  preparar: () => {
    const entregados: InboundMessage[] = [];
    const adapter = createSimulatedAdapter('whatsapp');

    return Promise.resolve({
      adapter,
      entregados,
      enviados: adapter.sent,
      inyectar: async ({ direccion, eventoId, texto, accion }) => {
        await adapter.deliver({
          direccion,
          eventoId,
          texto: texto ?? null,
          accion: accion ?? null,
        });
      },
    });
  },
});
