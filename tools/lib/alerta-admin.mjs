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
 *
 * **De dónde salen las credenciales**: igual que en el servicio, **manda el panel** (ADR 0060),
 * que las guarda cifradas en identity, y el `.env` de notificaciones es el **respaldo**. Las
 * herramientas leen la base directamente (corren fuera de la pila y a menudo con los servicios
 * caídos, que es justo cuando hay que avisar), así que no pasan por la ruta interna. Se resuelven
 * campo a campo, como `applyChannelCredentials`: el que esté en la base gana; si no, el archivo.
 */
import { decryptBlob, parseEncryptionKey } from '@odontocrm/storage';
import pg from 'pg';

import { formatAdminAlert } from '@odontocrm/contracts';

import { leerEnv, rutaEnvDe, SERVICIOS } from './servicios.mjs';

const { Client } = pg;

/** El servicio que guarda el bot de administración (es el único que lo tiene). */
const notificaciones = SERVICIOS.find((servicio) => servicio.name === 'notifications');
/** El dueño de la configuración de los canales (ADR 0060): el panel escribe ahí. */
const identidad = SERVICIOS.find((servicio) => servicio.name === 'identity');

/**
 * Descifra un secreto del panel. Replica `open` de `channel-service.ts`: un valor sin marca
 * está en claro (compatibilidad); `plain:` es «sin clave de almacén» y `enc:` es el blob.
 */
const abrirSecreto = (guardado, key) => {
  if (guardado === null || guardado === '') return null;
  if (guardado.startsWith('plain:')) return guardado.slice('plain:'.length);
  if (guardado.startsWith('enc:')) {
    if (key === undefined) return null;
    try {
      return decryptBlob(Buffer.from(guardado.slice('enc:'.length), 'base64'), key).toString(
        'utf8',
      );
    } catch {
      // Clave cambiada o blob corrupto: se cae al `.env` en vez de tumbar la herramienta.
      return null;
    }
  }
  return guardado;
};

/**
 * Las credenciales del bot tal como las guardó el **panel**, o `null` si no hay fila o no
 * tiene los dos datos. Se conecta a la base de identity (es la dueña de `channel_settings`).
 */
const leerBotAdminDeBase = async () => {
  if (identidad === undefined) return null;
  const env = leerEnv(rutaEnvDe(identidad));
  const url = (env.DATABASE_URL ?? '').trim();
  if (url === '') return null;

  const client = new Client({
    connectionString: url,
    application_name: 'odontocrm-bot-admin',
    connectionTimeoutMillis: 3_000,
  });
  try {
    await client.connect();
    const { rows } = await client.query(
      `select admin_telegram_chat_id, admin_telegram_bot_token_enc
         from channel_settings where id = 1`,
    );
    const fila = rows[0];
    if (fila === undefined) return null;
    const key = (() => {
      try {
        return parseEncryptionKey(env.STORAGE_ENCRYPTION_KEY);
      } catch {
        return undefined;
      }
    })();
    return {
      token: abrirSecreto(fila.admin_telegram_bot_token_enc, key),
      chatId: (fila.admin_telegram_chat_id ?? '').trim() || null,
    };
  } catch {
    // Base caída o sin la tabla (instalación vieja): el `.env` sigue sirviendo.
    return null;
  } finally {
    await client.end().catch(() => undefined);
  }
};

/**
 * Credenciales del bot según el **archivo** (`notifications.env`): el respaldo de siempre.
 * Se mantiene síncrona por compatibilidad; `resolverBotAdmin` es la que deben usar los demás.
 */
export const leerBotAdmin = () => {
  const env = notificaciones === undefined ? {} : leerEnv(rutaEnvDe(notificaciones));
  const token = (env.ADMIN_TELEGRAM_BOT_TOKEN ?? '').trim();
  const chatId = (env.ADMIN_TELEGRAM_CHAT_ID ?? '').trim();
  if (token === '' || chatId === '' || /^CAMBIAR/i.test(token)) return null;
  return { token, chatId, apiBase: (env.TELEGRAM_API_BASE ?? 'https://api.telegram.org').trim() };
};

/**
 * Credenciales **efectivas** del bot de administración: las del panel mandan y el `.env`
 * rellena lo que falte (misma semántica que `applyChannelCredentials`). Devuelve `null`
 * cuando no hay forma de mandar un mensaje (falta el token o el chat).
 *
 * La `apiBase` no se guarda en el panel: sale siempre del archivo (la base de Telegram).
 */
export const resolverBotAdmin = async () => {
  const archivo = leerBotAdmin() ?? { token: '', chatId: '' };
  const base = await leerBotAdminDeBase();

  const token = base?.token ?? archivo.token;
  const chatId = base?.chatId ?? archivo.chatId;
  if (token === '' || chatId === '') return null;

  const env = notificaciones === undefined ? {} : leerEnv(rutaEnvDe(notificaciones));
  const apiBase = (env.TELEGRAM_API_BASE ?? 'https://api.telegram.org').trim();
  return { token, chatId, apiBase };
};

/**
 * Manda el aviso. Devuelve `{ enviado, motivo }`; el motivo **nunca** incluye el token
 * (podría acabar en un registro de systemd o en una consola compartida).
 */
export const enviarAvisoAdmin = async (aviso, opciones = {}) => {
  const bot = opciones.bot ?? (await resolverBotAdmin());
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
