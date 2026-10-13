#!/usr/bin/env node
/**
 * **Bot de administración**: escucha los comandos del dueño del consultorio y responde con el
 * estado del servidor y respaldos a demanda.
 *
 *   node tools/admin-bot.mjs            # escucha (lo supervisa PM2/systemd)
 *   node tools/admin-bot.mjs --una-vez  # procesa lo pendiente y sale (prueba/diagnóstico)
 *   node tools/admin-bot.mjs --ayuda    # ayuda
 *
 * **Solo responde al chat de `ADMIN_TELEGRAM_CHAT_ID`**: cualquier otro mensaje se ignora en
 * silencio. El bot es privado por diseño —hay que estar anclado a ese id para usarlo—.
 *
 * Corre **fuera** de la pila, como las otras herramientas de consola: por eso lo arranca el
 * supervisor (PM2 en Windows, systemd en Fedora) y no el servicio de notificaciones. Ese
 * detalle importa para los respaldos: el bot corre con los permisos que necesita para leer
 * las credenciales y escribir los volcados.
 *
 * Hay **dos** respaldos y no son lo mismo:
 *
 *   · `/respaldos` — volcados **ad-hoc** de las bases, temporales, para que viajen por Telegram
 *     (te los llevas en el móvil).
 *   · `/respaldo`  — copia **completa** (bases + configuración + almacén) que se queda en el
 *     servidor, con la forma que entiende `odontocrm recuperar`. Es la que vale si se muere el
 *     disco; la del chat no (le faltan los adjuntos y los secretos).
 */
import { adminBotCommandsAsText, toAdminMenuCommands } from '@odontocrm/contracts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  MAX_ARCHIVO_TELEGRAM,
  formatearEstado,
  formatearRespaldoCompleto,
  formatearRespaldos,
  limpiarRespaldos,
  tomarEstado,
  tomarRespaldoCompleto,
  tomarRespaldos,
} from './lib/admin-informes.mjs';
import { crearBotAdmin } from './lib/bot-admin.mjs';

const args = process.argv.slice(2);
const unaVez = args.includes('--una-vez');
const pedirAyuda = args.includes('--ayuda') || args.includes('--help');

const AYUDA = [
  'OdontoCRM · bot de administración del consultorio',
  '',
  'Comandos:',
  adminBotCommandsAsText(),
  '',
  'Solo responde al chat configurado (ADMIN_TELEGRAM_CHAT_ID).',
].join('\n');

if (pedirAyuda) {
  console.log(AYUDA);
  process.exit(0);
}

let bot = await crearBotAdmin();
if (bot === null) {
  // NO es un fallo: es una instalación sin bot de administración. Se sale con 0 para que el
  // supervisor (PM2 con `stop_exit_codes: [0]`, systemd con `Restart=on-failure`) NO lo
  // reinicie en bucle.
  console.log(
    'sin bot de administración configurado (faltan ADMIN_TELEGRAM_BOT_TOKEN / ADMIN_TELEGRAM_CHAT_ID): no hay nada que escuchar.',
  );
  process.exit(0);
}

/** Segundos de long polling: el máximo útil de Telegram (menos peticiones, más inmediato). */
const POLL_TIMEOUT = 25;
let offset = 0;

/** El comando de un texto: primer token, sin `/`, sin el sufijo `@bot` y en minúsculas. */
const comandoDe = (texto) => {
  const raw = (texto ?? '').trim();
  if (raw === '') return '';
  const primero = raw.split(/\s+/)[0] ?? '';
  const sinBarra = primero.startsWith('/') ? primero.slice(1) : primero;
  return (sinBarra.split('@')[0] ?? '').trim().toLowerCase();
};

const responderEstado = async () => {
  const resultado = tomarEstado();
  if (resultado.error !== undefined) {
    await bot.sendMessage(`⚠ ${resultado.error}`);
    return;
  }
  await bot.sendMessage(formatearEstado(resultado.foto, resultado.problemas));
};

const responderRespaldos = async () => {
  await bot.sendMessage('Tomando el respaldo de las bases… (puede tardar unos minutos).');
  const resultado = await tomarRespaldos();

  // Los volcados, uno por uno. Telegram corta en 50 MB: lo que no quepa se avisa y se deja en
  // la carpeta temporal (no se borra) para poder recogerlo a mano.
  const grandes = [];
  for (const archivo of resultado.archivos) {
    if (archivo.bytes > MAX_ARCHIVO_TELEGRAM) {
      grandes.push(archivo);
      continue;
    }
    await bot.sendDocument(
      {
        filename: archivo.nombre,
        content: readFileSync(archivo.path),
        mime: 'application/octet-stream',
      },
      `Respaldo · ${archivo.base}`,
    );
  }

  // Las sumas viajan como archivo para poder comprobarlas sin copiarlas de un mensaje.
  if (resultado.archivos.length > 0) {
    await bot.sendDocument(
      {
        filename: 'SHA256SUMS',
        content: readFileSync(join(resultado.dir, 'SHA256SUMS')),
        mime: 'text/plain',
      },
      'Sumas SHA-256 de los volcados',
    );
  }

  const avisoGrandes =
    grandes.length === 0
      ? ''
      : `\n\n⚠ ${grandes.length} archivo(s) superan los 50 MB y NO se enviaron; quedan en:\n${resultado.dir}`;
  await bot.sendMessage(`${formatearRespaldos(resultado)}${avisoGrandes}`);

  // Solo se borra lo temporal si TODO salió: si algo se quedó por enviar, se conserva.
  if (grandes.length === 0) limpiarRespaldos(resultado.dir);
};

/**
 * Respaldo **completo** (bases + configuración + almacén) que se queda en el servidor.
 *
 * No se manda nada por Telegram a propósito: lo que viaja mal por chat son justo los dos
 * bloques que hacen falta para recuperar de verdad (los adjuntos y los secretos), y para
 * llevarse las bases ya está `/respaldos`. Aquí lo que importa es que la copia exista y esté
 * verificada en la máquina, así que se responde con dónde quedó.
 */
const responderRespaldo = async () => {
  await bot.sendMessage(
    'Tomando el respaldo completo en el servidor (bases, configuración y almacén)…\n' +
      'Puede tardar unos minutos: el almacén entero se comprime dentro.',
  );
  const resultado = await tomarRespaldoCompleto();
  await bot.sendMessage(formatearRespaldoCompleto(resultado));
};

const atender = async (mensaje) => {
  // El candado: solo el chat anclado. Cualquier otro, ignorado en silencio.
  if (String(mensaje.chat?.id ?? '') !== bot.chatId) return;

  switch (comandoDe(mensaje.text)) {
    case 'start':
      await bot.sendMessage(`OdontoCRM · bot de administración.\n\n${adminBotCommandsAsText()}`);
      break;
    case 'estado':
      await responderEstado();
      break;
    case 'respaldos':
    case 'respaldar':
    case 'backup':
      await responderRespaldos();
      break;
    // El respaldo completo, con otro nombre a propósito: `/respaldos` manda los `.dump` por
    // chat y `/respaldo` deja la copia entera en el servidor. `completo` es el alias largo.
    case 'respaldo':
    case 'completo':
      await responderRespaldo();
      break;
    case 'ayuda':
    case 'help':
    case 'menu':
      await bot.sendMessage(AYUDA);
      break;
    case '':
      break;
    default:
      await bot.sendMessage(`No conozco ese comando.\n\n${adminBotCommandsAsText()}`);
  }
};

/** Un ciclo de long polling: saca las actualizaciones y las atiende. */
const ciclo = async (timeoutSeconds) => {
  const updates = await bot.getUpdates(offset, timeoutSeconds);
  for (const update of updates) {
    offset = update.update_id + 1;
    const mensaje = update.message;
    if (mensaje === undefined || typeof mensaje.text !== 'string') continue;
    try {
      await atender(mensaje);
    } catch (fallo) {
      const detalle = fallo instanceof Error ? fallo.message : String(fallo);
      console.error(`fallo atendiendo un mensaje: ${detalle}`);
      await bot.sendMessage(`⚠ No pude completar eso: ${detalle}`).catch(() => undefined);
    }
  }
};

const registrarMenu = async () => {
  // Idempotente: se registra en cada arranque (Telegram lo guarda por bot). Si falla, el bot
  // sigue funcionando: solo se pierde el menú desplegable.
  await bot.setMyCommands(toAdminMenuCommands()).catch((fallo) => {
    console.error(`no pude registrar el menú: ${fallo instanceof Error ? fallo.message : fallo}`);
  });
  await bot.setChatMenuButton().catch(() => undefined);
};

/**
 * Cada cuánto se releen las credenciales del panel (ADR 0060). El token o el chat del bot se
 * pueden cambiar en `/configuración`; con esta relectura el bot lo aplica **solo**, en ~1
 * minuto y sin reiniciar.
 *
 * Es una **relectura**, no la recarga caliente del servicio de notificaciones: aquí solo se
 * recrea la conexión con Telegram (el transporte es un objeto sin estado), no se tocan
 * adaptadores ni eventos. El intervalo es más corto que un ciclo de long polling, así que en
 * la práctica se revisa una vez por ciclo.
 */
const REVISAR_CREDENCIALES_MS = 30_000;
let proximaRevision = 0;

const revisarCredenciales = async () => {
  if (Date.now() < proximaRevision) return;
  proximaRevision = Date.now() + REVISAR_CREDENCIALES_MS;

  // Si el panel no tiene credenciales (o la base no responde), `crearBotAdmin` devuelve `null`
  // y se sigue con las actuales: un fallo transitorio no puede dejar al bot sin escuchar.
  const nuevo = await crearBotAdmin().catch(() => null);
  if (nuevo === null || nuevo.firma === bot.firma) return;

  bot = nuevo;
  console.log('credenciales del bot actualizadas desde el panel');
  // El menú de Telegram vive por bot: si cambió el token, hay que registrarlo en el nuevo.
  await registrarMenu();
};

const main = async () => {
  await registrarMenu();

  if (unaVez) {
    // Sin long polling: lee lo que haya y sale. Repite las actualizaciones recientes (Telegram
    // las guarda ~24 h), así que es para PROBAR, no para producción.
    await ciclo(0);
    return;
  }

  console.log(`Bot de administración escuchando (chat ${bot.chatId}).`);
  let parando = false;
  const parar = () => {
    parando = true;
  };
  process.on('SIGINT', parar);
  process.on('SIGTERM', parar);

  while (!parando) {
    try {
      await revisarCredenciales();
      await ciclo(POLL_TIMEOUT);
    } catch (fallo) {
      console.error(`falló el sondeo: ${fallo instanceof Error ? fallo.message : fallo}`);
      await new Promise((seguir) => setTimeout(seguir, 5_000));
    }
  }
  console.log('Bot de administración detenido.');
};

await main();
