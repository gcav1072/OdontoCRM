#!/usr/bin/env node
/**
 * **Bot de Telegram del proveedor de licencias** ([ADR 0075](../../docs/adr/0075-licenciamiento-offline-y-modo-consulta.md)).
 *
 * Es el segundo bot del sistema (el otro es el del consultorio, `admin-bot.mjs`):
 * este vive en la **máquina del proveedor**, tiene su **propio token** y la
 * clave privada con la que firma. El consultorio no puede emitir ni revocar: su
 * bot solo activa (verifica) un `.lic` que le reenvíen.
 *
 *   node tools/licencia-bot.mjs            # escucha (lo supervisa PM2/systemd)
 *   node tools/licencia-bot.mjs --una-vez  # procesa lo pendiente y sale (prueba)
 *   node tools/licencia-bot.mjs --ayuda    # ayuda
 *
 * **Solo responde al chat de `LICENCIA_BOT_CHAT_ID`** (en `licencia-bot.env`, en
 * el directorio de configuración): cualquier otro mensaje se ignora en silencio.
 *
 * Flujo normal: el consultorio manda un mensaje con un código `ODO-REQ1.…`; el
 * dueño lo reenvía aquí, el bot lo decodifica, pide el tipo y devuelve el `.lic`
 * como documento para que lo reenvíen al bot de administración del consultorio.
 */
import {
  LICENSE_KINDS,
  LICENSE_KIND_LABELS,
  diasDelTipoDeLicencia,
  LICENSE_REQUEST_PREFIX,
} from '@odontocrm/contracts';

import { resumenRutas, rutasDeLicencias } from './lib/licencia-config.mjs';
import {
  cargarClavePrivada,
  emitirLicencia,
  extraerSolicitudDeTexto,
  formatearEmision,
  formatearSolicitud,
  nombreArchivoLicencia,
} from './lib/licencia-emision.mjs';
import {
  esTipoDeLicencia,
  fechaCorta,
  formatearDetalleLicencia,
  formatearPendientes,
  leerRegistro,
  pendientes,
  textoDias,
  ultimaPorInstalacion,
} from './lib/licencia-registro.mjs';
import { crearBotLicencias } from './lib/telegram-licencias.mjs';

const args = process.argv.slice(2);
const unaVez = args.includes('--una-vez');
const pedirAyuda = args.includes('--ayuda') || args.includes('--help');

const AYUDA = [
  'OdontoCRM · bot de licencias del proveedor',
  '',
  'Comandos:',
  '  /emitir <uuid> <tipo> [--cliente "Nombre"] [--rif RIF] [--desde ISO] [--notas "..."]',
  '      Emite la primera licencia de una instalación (si ya tenía, suma días).',
  '  /renovar <uuid> <tipo> [--desde ISO] [--notas "..."]',
  '      Renueva con el consultorio de la licencia anterior.',
  '  /licencia <uuid>   Ver la última licencia de esa instalación.',
  '  /pendientes [dias] Vencen en los próximos N días (30 por defecto) y las vencidas.',
  '  /ayuda             Esta ayuda.',
  '',
  'Solicitudes del consultorio:',
  `  Reenvíame el mensaje que empieza por ${LICENSE_REQUEST_PREFIX}…; te digo el consultorio`,
  '  y respondes /mensual, /trimestral, /anual o /vitalicia para emitir y enviarte el .lic.',
  '',
  `Tipos: ${LICENSE_KINDS.map((tipo) => {
    const dias = diasDelTipoDeLicencia(tipo);
    return dias === null ? `${tipo} (sin vencimiento)` : `${tipo} (${textoDias(dias)})`;
  }).join(' · ')}`,
  '',
  'Rutas:',
  resumenRutas(),
  '',
  'Solo respondo al chat configurado. Nunca mando la clave privada ni el token.',
].join('\n');

/** Menú que se registra en Telegram (`setMyCommands`), en el orden en que se usa. */
const MENU = [
  { command: 'start', description: 'Empezar' },
  { command: 'ayuda', description: 'Ver los comandos' },
  { command: 'emitir', description: 'Emitir licencia a una instalación' },
  { command: 'renovar', description: 'Renovar una licencia existente' },
  { command: 'pendientes', description: 'Ver vencimientos próximos' },
  { command: 'licencia', description: 'Ver la licencia de una instalación' },
];

/** Segundos de long polling: el máximo útil de Telegram. */
const POLL_TIMEOUT = 25;
const REVISAR_CREDENCIALES_MS = 30_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const rutas = rutasDeLicencias();
let bot = crearBotLicencias({ rutas });
let offset = 0;
/** Última solicitud reenviada pendiente de que el proveedor diga el tipo. */
let pendiente = null;
/** Clave privada importada (se lee la primera vez que hace falta firmar). */
let clavePrivada = null;

if (pedirAyuda) {
  console.log(AYUDA);
  process.exit(0);
}

const esperar = (milisegundos) => new Promise((seguir) => setTimeout(seguir, milisegundos));

/** El comando de un texto: primer token, sin `/`, sin el sufijo `@bot` y en minúsculas. */
const comandoDe = (texto) => {
  const raw = String(texto ?? '').trim();
  if (raw === '') return '';
  const primero = raw.split(/\s+/)[0] ?? '';
  const sinBarra = primero.startsWith('/') ? primero.slice(1) : primero;
  return (sinBarra.split('@')[0] ?? '').trim().toLowerCase();
};

/**
 * Trocea un texto en argumentos respetando comillas (`"Clínica Sonrisa"`).
 * Es propio de este bot: lo que llega por Telegram es texto libre.
 */
const trocear = (texto) => {
  const tokens = [];
  const patron = /"([^"]*)"|'([^']*)'|(\S+)/gu;
  for (const coincidencia of String(texto ?? '').matchAll(patron)) {
    tokens.push(coincidencia[1] ?? coincidencia[2] ?? coincidencia[3] ?? '');
  }
  return tokens;
};

/** Separa los `--opcion valor` de los posicionales (uuid, tipo…). */
const leerOpciones = (tokens, permitidas) => {
  const opciones = {};
  const posicionales = [];
  for (let indice = 0; indice < tokens.length; indice += 1) {
    const token = tokens[indice];
    if (!token.startsWith('--')) {
      posicionales.push(token);
      continue;
    }
    const clave = token.slice(2);
    if (!permitidas.includes(clave)) {
      throw new Error(
        `Opción desconocida --${clave}. Válidas: ${permitidas.map((nombre) => `--${nombre}`).join(', ')}.`,
      );
    }
    const valor = tokens[indice + 1];
    if (valor === undefined || valor.startsWith('--')) {
      throw new Error(`Falta el valor de --${clave}.`);
    }
    opciones[clave] = valor;
    indice += 1;
  }
  return { posicionales, opciones };
};

const validarInstalacion = (valor) => {
  if (!UUID.test(String(valor ?? ''))) {
    throw new Error(
      `La instalación no es un UUID válido: «${String(valor ?? '')}». ` +
        'Lo muestra el consultorio en /licencia (o en su bot, /licencia).',
    );
  }
  return String(valor).toLowerCase();
};

const validarTipo = (valor) => {
  if (!esTipoDeLicencia(valor)) {
    throw new Error(`Tipo no válido: «${String(valor)}». Usa ${LICENSE_KINDS.join(' / ')}.`);
  }
  return valor;
};

/** Registro actual; avisa por consola si hay líneas ilegibles (no tumba el bot). */
const registroActual = () => {
  const { entradas, invalidas } = leerRegistro(rutas.registro);
  if (invalidas.length > 0) {
    console.error(
      `⚠ ${rutas.registro}: ${String(invalidas.length)} línea(s) ilegible(s) ignorada(s).`,
    );
  }
  return entradas;
};

/** Importa la clave privada una sola vez (lazy: /pendientes no la necesita). */
const claveDelProveedor = async () => {
  if (clavePrivada !== null) return clavePrivada;
  clavePrivada = await cargarClavePrivada(rutas.privada);
  return clavePrivada;
};

/** Busca el nombre del consultorio: opción explícita, solicitud pendiente o registro. */
const resolverCliente = (instalacion, opciones) => {
  if (typeof opciones.cliente === 'string' && opciones.cliente.trim() !== '') {
    return { nombre: opciones.cliente.trim(), rif: opciones.rif };
  }
  if (pendiente !== null && pendiente.solicitud.instalacion === instalacion) {
    return {
      nombre: pendiente.solicitud.cliente.nombre,
      rif: opciones.rif ?? pendiente.solicitud.cliente.rif,
    };
  }
  const previa = ultimaPorInstalacion(registroActual(), instalacion);
  if (previa !== null) {
    return { nombre: previa.cliente.nombre, rif: opciones.rif ?? previa.cliente.rif };
  }
  throw new Error(
    'Es la primera licencia de esa instalación y no sé el nombre del consultorio.\n' +
      `Usa: /emitir ${instalacion} <tipo> --cliente "Nombre del consultorio"`,
  );
};

/**
 * Emite, manda el `.lic` como documento y anota el registro. Si el envío por
 * Telegram falla, la licencia **ya está emitida y guardada**: se avisa con la
 * ruta del archivo para que el proveedor pueda mandarlo a mano.
 */
const emitirYEnviar = async ({ instalacion, tipo, cliente, rif, desde, notas }) => {
  const entradas = registroActual();
  const resultado = await emitirLicencia({
    tipo,
    instalacion,
    cliente,
    rif,
    desde,
    notas,
    emitidaPor: 'bot',
    entradas,
    clavePrivada: await claveDelProveedor(),
    rutas,
  });

  if (pendiente !== null && pendiente.solicitud.instalacion === instalacion) {
    pendiente = null;
  }

  const pie =
    `Licencia ${LICENSE_KIND_LABELS[tipo]} · ${cliente} · ` +
    (resultado.claims.venceEn === null
      ? 'sin vencimiento (vitalicia)'
      : `vence ${fechaCorta(resultado.claims.venceEn)}`);

  try {
    await bot.sendDocument(
      {
        filename: nombreArchivoLicencia(resultado.claims),
        content: Buffer.from(resultado.token, 'utf8'),
        mime: 'text/plain',
      },
      pie,
    );
  } catch (fallo) {
    const detalle = fallo instanceof Error ? fallo.message : String(fallo);
    await bot.sendMessage(
      `⚠ La licencia ${resultado.claims.lic} quedó emitida, pero no pude mandarte el archivo: ${detalle}\n` +
        `Está en: ${resultado.archivo}`,
    );
    return resultado;
  }

  await bot.sendMessage(
    `${formatearEmision(resultado, { adjunto: true })}\n\n` +
      'Reenvía este archivo al consultorio: lo activa reenviándolo al bot de administración\n' +
      'o subiéndolo en /licencia de la app.',
  );
  return resultado;
};

const comandoEmitir = async (texto) => {
  const { posicionales, opciones } = leerOpciones(trocear(texto).slice(1), [
    'cliente',
    'rif',
    'desde',
    'notas',
  ]);
  if (posicionales.length !== 2) {
    throw new Error(
      'Uso: /emitir <uuid> <tipo> [--cliente "Nombre"] [--rif RIF] [--desde ISO] [--notas "…"]',
    );
  }
  const instalacion = validarInstalacion(posicionales[0]);
  const tipo = validarTipo(posicionales[1]);
  const cliente = resolverCliente(instalacion, opciones);

  await emitirYEnviar({
    instalacion,
    tipo,
    cliente: cliente.nombre,
    rif: cliente.rif,
    desde: opciones.desde,
    notas: opciones.notas,
  });
};

const comandoRenovar = async (texto) => {
  const { posicionales, opciones } = leerOpciones(trocear(texto).slice(1), ['desde', 'notas']);
  if (posicionales.length !== 2) {
    throw new Error('Uso: /renovar <uuid> <tipo> [--desde ISO] [--notas "…"]');
  }
  const instalacion = validarInstalacion(posicionales[0]);
  const tipo = validarTipo(posicionales[1]);
  const previa = ultimaPorInstalacion(registroActual(), instalacion);
  if (previa === null) {
    throw new Error(
      `No hay licencia previa para la instalación ${instalacion}.\n` +
        `Emite la primera: /emitir ${instalacion} <tipo> --cliente "Nombre del consultorio"`,
    );
  }

  await emitirYEnviar({
    instalacion,
    tipo,
    cliente: previa.cliente.nombre,
    rif: previa.cliente.rif,
    desde: opciones.desde,
    notas: opciones.notas,
  });
};

const comandoPendientes = async (texto) => {
  const tokens = trocear(texto).slice(1);
  if (tokens.length > 1) throw new Error('Uso: /pendientes [dias]');
  const crudo = tokens[0] ?? '30';
  const dias = Number(crudo);
  if (!Number.isInteger(dias) || dias < 0) {
    throw new Error(
      `El número de días debe ser un entero mayor o igual que 0 (recibido: «${crudo}»).`,
    );
  }

  const ahora = new Date();
  const filas = pendientes(registroActual(), { ahora, dias });
  await bot.sendMessage(formatearPendientes(filas, { ahora, dias }));
};

const comandoLicencia = async (texto) => {
  const tokens = trocear(texto).slice(1);
  if (tokens.length !== 1) throw new Error('Uso: /licencia <uuid>');
  const instalacion = validarInstalacion(tokens[0]);
  const ultima = ultimaPorInstalacion(registroActual(), instalacion);

  let respuesta = formatearDetalleLicencia(ultima, new Date());
  if (pendiente !== null && pendiente.solicitud.instalacion === instalacion) {
    respuesta += `\n\nHay una solicitud pendiente de este consultorio:\n${formatearSolicitud(pendiente.solicitud)}`;
  }
  await bot.sendMessage(respuesta);
};

/** Emite con la solicitud pendiente cuando el proveedor responde el tipo. */
const comandoTipo = async (tipo) => {
  if (pendiente === null) {
    await bot.sendMessage(
      'No hay una solicitud pendiente. Reenvíame un mensaje con ' +
        `${LICENSE_REQUEST_PREFIX}… o usa /emitir <uuid> <tipo>.`,
    );
    return;
  }
  const solicitud = pendiente.solicitud;
  await emitirYEnviar({
    instalacion: solicitud.instalacion,
    tipo: validarTipo(tipo),
    cliente: solicitud.cliente.nombre,
    rif: solicitud.cliente.rif,
  });
};

/**
 * Detecta un código `ODO-REQ1.…` en un mensaje reenviado y lo deja pendiente.
 * Devuelve `true` si el mensaje era una solicitud (para no tratarlo como comando).
 */
const atenderSolicitud = async (texto) => {
  const solicitud = extraerSolicitudDeTexto(texto);
  if (solicitud !== null) {
    pendiente = { solicitud, recibidaEn: new Date() };
    await bot.sendMessage(
      `${formatearSolicitud(solicitud)}\n\n` +
        '¿Qué tipo emito? Responde /mensual, /trimestral, /anual o /vitalicia.',
    );
    return true;
  }
  if (String(texto).includes(LICENSE_REQUEST_PREFIX)) {
    await bot.sendMessage(
      'No pude leer el código ' +
        `${LICENSE_REQUEST_PREFIX}… (puede estar incompleto o mal copiado).\n` +
        'Pide al consultorio que lo regenere en /licencia y reenvía el mensaje completo.',
    );
    return true;
  }
  return false;
};

const atender = async (mensaje) => {
  if (bot === null) return;
  // El candado: solo el chat anclado. Cualquier otro, ignorado en silencio.
  if (String(mensaje.chat?.id ?? '') !== bot.chatId) return;

  const texto = typeof mensaje.text === 'string' ? mensaje.text.trim() : '';
  if (texto === '') {
    // Documentos/fotos: este bot no los procesa (el flujo es texto + ODO-REQ1.).
    return;
  }

  const comando = comandoDe(texto);
  if (comando === '') return;

  if (await atenderSolicitud(texto)) return;

  switch (comando) {
    case 'start':
    case 'ayuda':
    case 'help':
    case 'menu':
      await bot.sendMessage(AYUDA);
      break;
    case 'emitir':
      await comandoEmitir(texto);
      break;
    case 'renovar':
      await comandoRenovar(texto);
      break;
    case 'pendientes':
      await comandoPendientes(texto);
      break;
    case 'licencia':
      await comandoLicencia(texto);
      break;
    case 'mensual':
    case 'trimestral':
    case 'anual':
    case 'vitalicia':
      await comandoTipo(comando);
      break;
    default:
      await bot.sendMessage(`No conozco ese comando.\n\n${AYUDA}`);
  }
};

/** Un ciclo de long polling: saca las actualizaciones y las atiende. */
const ciclo = async (timeoutSeconds) => {
  if (bot === null) return;
  const updates = await bot.getUpdates(offset, timeoutSeconds);
  for (const update of updates) {
    offset = update.update_id + 1;
    const mensaje = update.message;
    if (mensaje === undefined) continue;
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
  if (bot === null) return;
  // Idempotente: se registra en cada arranque. Si falla, el bot sigue escuchando.
  await bot.setMyCommands(MENU).catch((fallo) => {
    console.error(`no pude registrar el menú: ${fallo instanceof Error ? fallo.message : fallo}`);
  });
  await bot.setChatMenuButton().catch(() => undefined);
};

/**
 * Relee `licencia-bot.env` cada 30 s: si el token cambia (o aparece la primera
 * vez), se adopta sin reiniciar el proceso. El transporte es sin estado, así que
 * recrearlo es barato.
 */
let proximaRevision = 0;
const revisarCredenciales = async () => {
  if (Date.now() < proximaRevision) return;
  proximaRevision = Date.now() + REVISAR_CREDENCIALES_MS;

  const nuevo = crearBotLicencias({ rutas });
  if (nuevo === null || (bot !== null && nuevo.firma === bot.firma)) return;

  const primero = bot === null;
  bot = nuevo;
  console.log(
    primero
      ? `bot de licencias disponible (chat ${bot.chatId}): escuchando`
      : 'credenciales del bot actualizadas desde licencia-bot.env',
  );
  await registrarMenu();
};

const main = async () => {
  if (bot === null) {
    console.log(
      `sin bot de licencias configurado todavía (${rutas.botEnv}): reintentaré cada 60 s`,
    );
  } else {
    console.log(`Bot de licencias escuchando (chat ${bot.chatId}).`);
  }
  await registrarMenu();

  if (unaVez) {
    // Sin long polling: lee lo que haya y sale (para probar el transporte).
    await ciclo(0);
    return;
  }

  let parando = false;
  const parar = () => {
    parando = true;
  };
  process.on('SIGINT', parar);
  process.on('SIGTERM', parar);

  while (!parando) {
    try {
      await revisarCredenciales();
      if (bot === null) {
        await esperar(60_000);
        continue;
      }
      await ciclo(POLL_TIMEOUT);
    } catch (fallo) {
      console.error(`falló el sondeo: ${fallo instanceof Error ? fallo.message : fallo}`);
      await esperar(5_000);
    }
  }
  console.log('Bot de licencias detenido.');
};

await main().catch((fallo) => {
  console.error(`✖ ${fallo instanceof Error ? fallo.message : String(fallo)}`);
  process.exitCode = 1;
});
