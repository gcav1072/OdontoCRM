#!/usr/bin/env node
/**
 * Transporte mínimo de Telegram para el **bot del proveedor de licencias**.
 *
 * Es hermano de `tools/lib/bot-admin.mjs`, pero no se comparte con él a
 * propósito: aquel habla con el bot **del consultorio** (lo configura el dueño
 * en el panel y su token vive en la base del cliente); este habla con el bot
 * **del proveedor**, que tiene otro token y solo debe existir en la máquina que
 * emite licencias. Mezclarlos sería la forma más fácil de que un token de
 * proveedor acabara en una instalación de cliente.
 *
 * Solo lo mínimo que necesita el emisor: escuchar (`getUpdates`), responder
 * (`sendMessage`, troceando lo que pase del límite de Telegram) y mandar el
 * `.lic` (`sendDocument`). **El token va en la URL** (es como funciona
 * Telegram) y por eso se limpia de cualquier mensaje de error antes de
 * propagarlo: nunca debe acabar en un log, en la consola ni en un aviso.
 */
import { createHash } from 'node:crypto';

import { credencialesBot, rutasDeLicencias } from './licencia-config.mjs';

const TIMEOUT_MS = 15_000;
/** Telegram corta los mensajes en 4096 caracteres; se trocea un poco antes. */
export const TELEGRAM_MAX_TEXTO = 4096;
const LIMITE_TROZO = 4000;
/** Telegram corta el pie (caption) de un documento en 1024. */
const MAX_PIE = 1024;

/** Quita el token de un texto (mensajes de error, diagnósticos, logs). */
export const limpiarSecreto = (texto, token) => {
  const limpio = String(texto ?? '');
  return token === undefined || token === '' ? limpio : limpio.split(String(token)).join('***');
};

/**
 * Parte un texto en trozos que quepan en un mensaje de Telegram, cortando por
 * líneas cuando se puede y por longitud cuando una sola línea es enorme. No
 * pierde contenido: `trocear(texto).join('') === texto`.
 */
export const dividirMensaje = (texto, limite = LIMITE_TROZO) => {
  const completo = String(texto ?? '');
  if (completo === '') return [''];
  if (completo.length <= limite) return [completo];

  const trozos = [];
  let actual = '';
  const empujar = () => {
    if (actual !== '') {
      trozos.push(actual);
      actual = '';
    }
  };

  for (const linea of completo.split(/(?<=\n)/u)) {
    if (linea.length > limite) {
      empujar();
      for (let inicio = 0; inicio < linea.length; inicio += limite) {
        trozos.push(linea.slice(inicio, inicio + limite));
      }
      continue;
    }
    if ((actual + linea).length > limite) empujar();
    actual += linea;
  }
  empujar();
  return trozos;
};

/**
 * Llama a la API de Telegram. Si falla, el mensaje que sale **no lleva el
 * token** (ni el de la URL ni el de la respuesta).
 */
const llamar = async (bot, metodo, cuerpo, timeoutMs = TIMEOUT_MS) => {
  let respuesta;
  try {
    respuesta = await fetch(`${bot.apiBase}/bot${bot.token}/${metodo}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(cuerpo ?? {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (fallo) {
    const detalle = fallo instanceof Error ? fallo.message : String(fallo);
    throw new Error(limpiarSecreto(`Telegram ${metodo} no respondió: ${detalle}`, bot.token), {
      cause: fallo,
    });
  }

  const datos = await respuesta.json().catch(() => ({}));
  if (datos.ok !== true || datos.result === undefined) {
    throw new Error(
      limpiarSecreto(
        `Telegram ${metodo} falló (HTTP ${String(respuesta.status)}): ${String(datos.description ?? 'sin detalle')}`,
        bot.token,
      ),
    );
  }
  return datos.result;
};

/**
 * Construye el transporte del bot del proveedor a partir del entorno y de
 * `licencia-bot.env` (config dir). Devuelve `null` si no hay credenciales: eso
 * **no es un fallo** (así lo trata el CLI del bot, saliendo con 0 para no
 * quedar en un bucle de reinicios).
 *
 * @returns {null | {
 *   chatId: string,
 *   firma: string,
 *   getUpdates: (offset: number, timeoutSeconds: number) => Promise<object[]>,
 *   sendMessage: (texto: string) => Promise<void>,
 *   sendDocument: (documento: {filename: string, content: Buffer, mime: string}, pie?: string) => Promise<void>,
 *   setMyCommands: (commands: readonly {command: string, description: string}[]) => Promise<void>,
 *   setChatMenuButton: () => Promise<void>,
 * }}
 */
export const crearBotLicencias = ({ rutas = rutasDeLicencias(), entorno = process.env } = {}) => {
  const bot = credencialesBot(rutas, entorno);
  if (bot === null) return null;

  return {
    chatId: bot.chatId,
    /** Huella de las credenciales, para detectar cambios del archivo sin exponer el token. */
    firma: createHash('sha256').update(`${bot.token}\n${bot.chatId}`).digest('hex').slice(0, 16),

    getUpdates: (offset, timeoutSeconds) =>
      llamar(
        bot,
        'getUpdates',
        { offset, timeout: timeoutSeconds, allowed_updates: ['message'] },
        (timeoutSeconds + 15) * 1000,
      ),

    sendMessage: async (texto) => {
      for (const trozo of dividirMensaje(texto)) {
        await llamar(bot, 'sendMessage', {
          chat_id: bot.chatId,
          text: trozo,
          disable_web_page_preview: true,
        });
      }
    },

    sendDocument: async (documento, pie) => {
      const form = new FormData();
      form.append('chat_id', bot.chatId);
      const caption = String(pie ?? '').slice(0, MAX_PIE);
      if (caption !== '') form.append('caption', caption);
      form.append(
        'document',
        new Blob([new Uint8Array(documento.content)], { type: documento.mime }),
        documento.filename,
      );

      let respuesta;
      try {
        respuesta = await fetch(`${bot.apiBase}/bot${bot.token}/sendDocument`, {
          method: 'POST',
          body: form,
          signal: AbortSignal.timeout(120_000),
        });
      } catch (fallo) {
        const detalle = fallo instanceof Error ? fallo.message : String(fallo);
        throw new Error(
          limpiarSecreto(`Telegram sendDocument no respondió: ${detalle}`, bot.token),
          {
            cause: fallo,
          },
        );
      }

      const datos = await respuesta.json().catch(() => ({}));
      if (datos.ok !== true) {
        throw new Error(
          limpiarSecreto(
            `Telegram sendDocument falló (HTTP ${String(respuesta.status)}): ${String(datos.description ?? 'sin detalle')}`,
            bot.token,
          ),
        );
      }
    },

    /** El menú de comandos que aparece al pulsar `/` (idempotente en cada arranque). */
    setMyCommands: async (commands) => {
      await llamar(bot, 'setMyCommands', { commands });
    },

    setChatMenuButton: async () => {
      await llamar(bot, 'setChatMenuButton', { menu_button: { type: 'commands' } });
    },
  };
};
