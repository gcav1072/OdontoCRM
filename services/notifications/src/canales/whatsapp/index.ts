import type { ChannelAdapter } from '@odontocrm/contracts';

import { createWhatsAppBaileysAdapter } from './adaptador.js';
import { createWhatsAppAuditPublisher } from './auditoria.js';
import { createWhatsAppSesion, type WhatsAppSesion, type WhatsAppSesionOptions } from './sesion.js';

/**
 * Fábrica del canal WhatsApp por Baileys: devuelve el adaptador y la sesión.
 * La sesión se expone aparte porque las rutas de vinculación, la CLI y el
 * estado del panel necesitan operar sobre el socket sin pasar por el contrato
 * de mensajería.
 */
export const createWhatsAppChannel = (
  options: Omit<WhatsAppSesionOptions, 'onAuditoria'> & {
    onAuditoria?: WhatsAppSesionOptions['onAuditoria'];
  },
): { adapter: ChannelAdapter; sesion: WhatsAppSesion } => {
  const sesion = createWhatsAppSesion({
    ...options,
    onAuditoria:
      options.onAuditoria ??
      createWhatsAppAuditPublisher(options.db, options.config.WHATSAPP_SESSION_ID),
  });
  return { adapter: createWhatsAppBaileysAdapter(sesion), sesion };
};

export type { WhatsAppSesion } from './sesion.js';
