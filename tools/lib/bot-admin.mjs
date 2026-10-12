/**
 * Cliente mínimo de la API de Telegram para el **bot de administración**.
 *
 * Es el mismo transporte que usa `alerta-admin.mjs` para *enviar* avisos, pero aquí además
 * se **escucha** (`getUpdates`) y se mandan **documentos** (los respaldos). Vive en
 * `tools/lib` porque lo usa una herramienta de consola que corre fuera de la pila.
 *
 * No se comparte con el servicio de notificaciones a propósito: aquel habla con el bot de
 * los **pacientes** (el que ven las familias); este, con el de administración. Son dos bots
 * distintos, con dos tokens distintos.
 *
 * **El token va en la URL** (es como funciona Telegram) y **nunca** se imprime ni se pone en
 * el mensaje de un error.
 */
import { createHash } from 'node:crypto';

import { resolverBotAdmin } from './alerta-admin.mjs';

const TIMEOUT_MS = 15_000;
/** Telegram corta en 50 MB por archivo; por encima de eso no se puede enviar. */
export const TELEGRAM_MAX_FILE_BYTES = 50 * 1024 * 1024;

const llamar = async (bot, metodo, cuerpo, timeoutMs = TIMEOUT_MS) => {
  const respuesta = await fetch(`${bot.apiBase}/bot${bot.token}/${metodo}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(cuerpo ?? {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const datos = await respuesta.json().catch(() => ({}));
  if (datos.ok !== true || datos.result === undefined) {
    // Sin el token: podría acabar en un registro o en una consola compartida.
    throw new Error(`Telegram ${metodo} falló: ${datos.description ?? respuesta.status}`);
  }
  return datos.result;
};

/**
 * Transporte del bot de administración: lo mínimo para escuchar y responder.
 *
 * @typedef {object} BotAdminTransporte
 * @property {string} chatId  Chat (o grupo) al que SOLO se responde.
 * @property {string} firma  Huella de las credenciales (para detectar cambios del panel).
 * @property {(offset: number, timeoutSeconds: number) => Promise<object[]>} getUpdates
 * @property {(texto: string) => Promise<void>} sendMessage
 * @property {(documento: {filename: string, content: Buffer, mime: string}, pie?: string) => Promise<void>} sendDocument
 * @property {(commands: readonly {command: string, description: string}[]) => Promise<void>} setMyCommands
 * @property {() => Promise<void>} setChatMenuButton
 */

/**
 * Construye el transporte del bot de administración, o `null` si esta instalación no lo tiene
 * configurado (sin token/chat no hay bot que escuchar). Las credenciales salen del **panel**
 * (ADR 0060) y, si faltan, del `.env` de notificaciones.
 *
 * @returns {Promise<BotAdminTransporte | null>}
 */
export const crearBotAdmin = async () => {
  const bot = await resolverBotAdmin();
  if (bot === null) return null;

  return {
    chatId: bot.chatId,
    // Huella de las credenciales (token + chat), para que el bot detecte un cambio del panel
    // **sin exponer el token**: solo compara este valor cuando relee.
    firma: createHash('sha256').update(`${bot.token}\n${bot.chatId}`).digest('hex').slice(0, 16),

    getUpdates: (offset, timeoutSeconds) =>
      llamar(
        bot,
        'getUpdates',
        { offset, timeout: timeoutSeconds, allowed_updates: ['message'] },
        (timeoutSeconds + 15) * 1000,
      ),

    sendMessage: async (texto) => {
      await llamar(bot, 'sendMessage', {
        chat_id: bot.chatId,
        text: texto,
        disable_web_page_preview: true,
      });
    },

    sendDocument: async (documento, pie) => {
      // Un documento va por `multipart/form-data`, no por JSON.
      const form = new FormData();
      form.append('chat_id', bot.chatId);
      if (pie !== undefined && pie !== '') form.append('caption', pie);
      form.append(
        'document',
        new Blob([new Uint8Array(documento.content)], { type: documento.mime }),
        documento.filename,
      );
      const respuesta = await fetch(`${bot.apiBase}/bot${bot.token}/sendDocument`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(120_000),
      });
      const datos = await respuesta.json().catch(() => ({}));
      if (datos.ok !== true) {
        throw new Error(`Telegram sendDocument falló: ${datos.description ?? respuesta.status}`);
      }
    },

    /** El menú que aparece al pulsar `/` (idempotente: se registra en cada arranque). */
    setMyCommands: async (commands) => {
      await llamar(bot, 'setMyCommands', { commands });
    },

    setChatMenuButton: async () => {
      await llamar(bot, 'setChatMenuButton', { menu_button: { type: 'commands' } });
    },
  };
};
