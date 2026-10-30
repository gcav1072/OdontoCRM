import type {
  ChannelAdapter,
  ChannelCapabilities,
  InboundMessage,
  OutboundMessage,
  SendResult,
} from '@odontocrm/contracts';

import type { WhatsAppSesion } from './sesion.js';

/**
 * Adaptador `whatsapp` sobre Baileys (ADR 0072). El **contrato** es el mismo
 * que el de Cloud API; lo que cambia es quién abre la conexión (un socket
 * saliente) y qué capacidades declara.
 *
 * `botones: false` es deliberado (D7): los mensajes interactivos no son
 * fiables en clientes no oficiales y el núcleo ya numera las opciones. Cloud
 * API sigue declarando `true` en su propio adaptador.
 */
export const WHATSAPP_BAILEYS_CAPABILITIES: ChannelCapabilities = {
  botones: false,
  documentos: true,
  comandos: false,
  plantillasAprobadas: false,
};

export const createWhatsAppBaileysAdapter = (sesion: WhatsAppSesion): ChannelAdapter => ({
  id: 'whatsapp',
  capacidades: WHATSAPP_BAILEYS_CAPABILITIES,

  iniciar: async (entregar: (entrante: InboundMessage) => Promise<void>) => {
    await sesion.iniciar(entregar);
  },

  detener: async () => {
    await sesion.detener();
  },

  enviar: async (saliente: OutboundMessage): Promise<SendResult> => sesion.enviar(saliente),

  identidad: async () => sesion.identidad(),
});
