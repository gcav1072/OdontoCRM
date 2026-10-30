import type { ChannelAdapter, InboundMessage } from '@odontocrm/contracts';
import { testModeEnabled } from '@odontocrm/kernel';

import type { AdminAlerter } from '../alertas.js';
import {
  telegramMode,
  whatsappMode,
  whatsappSignature,
  type NotificationsConfig,
} from '../config.js';
import type { NotificationsDb } from '../db/client.js';
import { createAdapterRegistry, type AdapterRegistry } from './adaptador.js';
import { createTelegramAdapter } from './telegram.js';
import { createTransport, type TelegramTransport } from './telegram-api.js';
import { createWhatsAppAdapter, whatsappCredentials } from './whatsapp-cloud.js';
import { createWhatsAppChannel, type WhatsAppSesion } from './whatsapp/index.js';
import type { MakeWhatsAppSocket } from './whatsapp/sesion.js';

/** Los canales activos del servicio y lo que hace falta para mostrarlos en la bandeja. */
export interface CanalesHandle {
  /** Registro de adaptadores: por aquí salen y entran todos los mensajes. */
  registry: AdapterRegistry;
  /** Transporte de Telegram (real o simulado), para el estado del bot. */
  transport: TelegramTransport;
  modoTelegram: 'real' | 'simulado';
  /** Modo test activo: **ningún** canal puede alcanzar a una persona real. */
  modoTest: boolean;
  /** Proveedor efectivo de WhatsApp. */
  modoWhatsApp: 'desactivado' | 'baileys' | 'cloud_api';
  /** Huella del adaptador de WhatsApp, para conservarlo entre recargas (D15). */
  whatsappFirma: string;
  /** Sesión de Baileys, si es el proveedor activo. */
  whatsapp: WhatsAppSesion | null;
  /** Adaptadores con webhook (Cloud API): la ruta los publica. */
  webhooks: readonly ChannelAdapter[];
}

export interface CreateChannelAdaptersOptions {
  onError?: (error: unknown, entrante: InboundMessage) => void;
  onAviso?: (error: unknown, contexto: string) => void;
  /** Handle anterior: si WhatsApp no cambió, se reutiliza su socket (D15). */
  previous?: CanalesHandle | null;
  /** Necesario para el proveedor Baileys (estado y contadores de la sesión). */
  db?: NotificationsDb;
  alertas?: AdminAlerter | null;
  makeSocket?: MakeWhatsAppSocket;
}

/**
 * Construye los adaptadores según la configuración (ADR 0029/0072): Telegram
 * siempre (real con token, simulado sin él) y WhatsApp según su proveedor:
 *
 * - `baileys`: interruptor encendido; la sesión queda `sin_vincular` hasta que
 *   un admin escanee el QR.
 * - `cloud_api`: la alternativa oficial, con sus credenciales.
 * - `desactivado`: no se registra.
 *
 * **Modo test (ADR 0020):** con el modo test activo no se registra ningún canal
 * que pueda hablar con una persona real; Baileys no abre el socket.
 */
export const createChannelAdapters = (
  config: NotificationsConfig,
  options: CreateChannelAdaptersOptions = {},
): CanalesHandle => {
  const modo = telegramMode(config);
  const transport = createTransport(config, modo);
  const enModoTest = testModeEnabled(config);
  const proveedorWhatsApp = whatsappMode(config);
  const firmaWhatsApp = whatsappSignature(config);

  const adapters: ChannelAdapter[] = [
    createTelegramAdapter({
      config,
      transport,
      ...(options.onAviso === undefined
        ? {}
        : { onError: (error) => options.onAviso?.(error, 'menu_de_comandos') }),
    }),
  ];

  let whatsapp: WhatsAppSesion | null = null;
  let webhooks: ChannelAdapter[] = [];
  const reutilizar =
    proveedorWhatsApp === 'baileys' &&
    options.previous !== undefined &&
    options.previous !== null &&
    options.previous.modoWhatsApp === 'baileys' &&
    options.previous.whatsappFirma === firmaWhatsApp &&
    options.previous.whatsapp !== null;

  if (reutilizar && options.previous !== undefined && options.previous !== null) {
    whatsapp = options.previous.whatsapp;
    const adaptador = options.previous.registry.get('whatsapp');
    if (adaptador !== null) adapters.push(adaptador);
  } else if (proveedorWhatsApp === 'baileys') {
    if (options.db === undefined) {
      throw new Error('El proveedor Baileys necesita la base de notificaciones');
    }
    const canal = createWhatsAppChannel({
      config,
      db: options.db,
      alertas: options.alertas ?? null,
      ...(options.makeSocket === undefined ? {} : { makeSocket: options.makeSocket }),
      onError: (error, contexto) => options.onAviso?.(error, contexto),
    });
    whatsapp = canal.sesion;
    adapters.push(canal.adapter);
  } else if (proveedorWhatsApp === 'cloud_api' && !enModoTest) {
    const credentials = whatsappCredentials(config);
    if (credentials !== null) {
      const adaptador = createWhatsAppAdapter({
        credentials,
        config,
        ...(options.onError === undefined ? {} : { onError: options.onError }),
      });
      adapters.push(adaptador);
      webhooks = [adaptador];
    }
  }

  return {
    registry: createAdapterRegistry(adapters),
    transport,
    modoTelegram: modo,
    modoTest: enModoTest,
    modoWhatsApp: proveedorWhatsApp,
    whatsappFirma: firmaWhatsApp,
    whatsapp,
    webhooks,
  };
};
