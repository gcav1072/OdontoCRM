/**
 * Aviso al **administrador** desde las herramientas de consola.
 *
 * Las herramientas (`npm run estado -- --alertas`, la verificación del respaldo) corren
 * fuera de la pila: no tienen el servicio de notificaciones al lado, así que hablan con
 * Telegram directamente con el token del bot de administración. El formato del mensaje es
 * el mismo que usa el servicio (`formatAdminAlert` del contrato): un aviso se tiene que
 * leer igual lo mande quien lo mande.
 *
 * **Nunca lanza**: estas herramientas se ejecutan en un temporizador y lo peor que puede
 * pasar es que el aviso no salga (el estado de salida y el registro siguen diciendo qué
 * pasa). El token no se imprime jamás, ni en el error.
 */
import { formatAdminAlert } from '@odontocrm/contracts';

import { leerEnv, rutaEnvDe, SERVICIOS } from './servicios.mjs';

/** El servicio que guarda el bot de administración (es el único que lo tiene). */
const notificaciones = SERVICIOS.find((servicio) => servicio.name === 'notifications');

/** Token y chat del bot, o `null` si esta instalación no lo tiene configurado. */
export const leerBotAdmin = () => {
  const env = notificaciones === undefined ? {} : leerEnv(rutaEnvDe(notificaciones));
  const token = (env.ADMIN_TELEGRAM_BOT_TOKEN ?? '').trim();
  const chatId = (env.ADMIN_TELEGRAM_CHAT_ID ?? '').trim();
  if (token === '' || chatId === '' || /^CAMBIAR/i.test(token)) return null;
  return { token, chatId, apiBase: (env.TELEGRAM_API_BASE ?? 'https://api.telegram.org').trim() };
};

/**
 * Manda el aviso. Devuelve `{ enviado, motivo }`; el motivo **nunca** incluye el token
 * (podría acabar en un registro de systemd o en una consola compartida).
 */
export const enviarAvisoAdmin = async (aviso, opciones = {}) => {
  const bot = opciones.bot ?? leerBotAdmin();
  if (bot === null) {
    return { enviado: false, motivo: 'sin bot de administración configurado (ADMIN_TELEGRAM_*)' };
  }

  const texto = formatAdminAlert({
    level: aviso.level ?? 'warning',
    title: aviso.title,
    detail: aviso.detail ?? null,
    context: aviso.context ?? {},
    source: aviso.source ?? 'odontocrm',
  });

  try {
    const respuesta = await (opciones.fetchImpl ?? fetch)(
      `${bot.apiBase}/bot${bot.token}/sendMessage`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: bot.chatId, text: texto, disable_notification: false }),
        signal: AbortSignal.timeout(opciones.timeoutMs ?? 10_000),
      },
    );
    const cuerpo = await respuesta.json().catch(() => ({}));
    if (cuerpo.ok !== true) {
      return {
        enviado: false,
        motivo: `Telegram respondió: ${cuerpo.description ?? respuesta.status}`,
      };
    }
    return { enviado: true, motivo: null };
  } catch (error) {
    return { enviado: false, motivo: error instanceof Error ? error.message : String(error) };
  }
};
