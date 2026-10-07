import { formatAdminAlert, type AdminAlert, type AdminAlertResult } from '@odontocrm/contracts';

import { adminBotReady, type NotificationsConfig } from './config.js';
import { createHttpTransport, type TelegramTransport } from './canales/telegram-api.js';

/**
 * El **emisor de avisos al administrador**: el único sitio que sabe escribir por el bot de
 * administración.
 *
 * Es deliberadamente pequeño y **nunca lanza**: quien avisa está en mitad de atender otra
 * cosa (un evento perdido, una verificación de respaldo) y un fallo al avisar no puede
 * convertirse en un segundo problema. Todo lo que sale de aquí es «se envió» o «no se pudo,
 * y por esto».
 *
 * El transporte se inyecta (y en las pruebas se sustituye por un doble): el mismo cliente
 * HTTP que habla con Telegram para los pacientes sirve para este bot, solo cambia el token.
 */
export interface AdminAlerter {
  /** Manda el aviso. Devuelve el resultado en vez de lanzar. */
  enviar: (alert: Omit<AdminAlert, 'source'> & { source?: string }) => Promise<AdminAlertResult>;
  /** Estado del bot para el panel: hay token, hay chat, cuántos salieron. */
  estado: () => {
    configurado: boolean;
    chatConfigurado: boolean;
    enviados: number;
    ultimoEnvio: string | null;
  };
}

export interface CreateAdminAlerterOptions {
  config: NotificationsConfig;
  /** Transporte ya construido (lo real usa el token de admin; en pruebas, un doble). */
  transport?: TelegramTransport | null;
  /** Registro del fallo (el logger del servicio), para no perder el rastro. */
  onError?: (error: unknown, contexto: string) => void;
}

/** Nombre con el que se firman los avisos que no dicen de dónde vienen. */
const ORIGEN_POR_DEFECTO = 'odontocrm';

export const createAdminAlerter = (options: CreateAdminAlerterOptions): AdminAlerter => {
  const { config } = options;
  const transport =
    options.transport === undefined
      ? config.ADMIN_TELEGRAM_BOT_TOKEN === undefined
        ? null
        : createHttpTransport(config, config.ADMIN_TELEGRAM_BOT_TOKEN)
      : options.transport;

  let enviados = 0;
  let ultimoEnvio: string | null = null;

  return {
    estado: () => ({
      configurado: config.ADMIN_TELEGRAM_BOT_TOKEN !== undefined,
      chatConfigurado: config.ADMIN_TELEGRAM_CHAT_ID !== undefined,
      enviados,
      ultimoEnvio,
    }),

    enviar: async (alert) => {
      const destinatario = config.ADMIN_TELEGRAM_CHAT_ID;
      if (!adminBotReady(config) || transport === null || destinatario === undefined) {
        // No es un error: es una instalación sin bot de administración. Se dice **qué**
        // falta para que el diagnóstico no cueste media hora.
        const falta =
          config.ADMIN_TELEGRAM_BOT_TOKEN === undefined
            ? 'sin ADMIN_TELEGRAM_BOT_TOKEN'
            : 'sin ADMIN_TELEGRAM_CHAT_ID';
        options.onError?.(
          new Error(`no hay bot de administración (${falta})`),
          'aviso_al_administrador',
        );
        return {
          enviado: false,
          motivo: `El bot de administración no está configurado (${falta})`,
        };
      }

      const completo: AdminAlert = {
        level: alert.level,
        title: alert.title,
        detail: alert.detail,
        context: alert.context,
        source: alert.source ?? ORIGEN_POR_DEFECTO,
      };

      try {
        await transport.sendMessage(destinatario, formatAdminAlert(completo));
        enviados += 1;
        ultimoEnvio = new Date().toISOString();
        return { enviado: true, motivo: null };
      } catch (error) {
        options.onError?.(error, 'envio_de_aviso');
        return {
          enviado: false,
          motivo: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
};
