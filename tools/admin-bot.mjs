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
 *
 * Y la **licencia** (ADR 0075): `/licencia` enseña el estado y la solicitud para el proveedor;
 * para activarla, el dueño **reenvía a este chat el archivo `.lic`**. El bot solo comprueba la
 * firma con la clave pública: aquí no se firma ninguna licencia (la clave privada es del
 * proveedor). Si la prueba o la licencia están por vencer, avisa una vez al día por este chat.
 */
import { adminBotCommandsAsText, toAdminMenuCommands } from '@odontocrm/contracts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  MAX_ARCHIVO_TELEGRAM,
  formatearActivacionLicencia,
  formatearEstado,
  formatearLicenciaDetalle,
  formatearRespaldoCompleto,
  formatearRespaldos,
  limpiarRespaldos,
  tomarEstado,
  tomarRespaldoCompleto,
  tomarRespaldos,
} from './lib/admin-informes.mjs';
import { crearBotAdmin } from './lib/bot-admin.mjs';
import {
  MAX_LICENCIA_BYTES,
  activarLicencia,
  estadoLicencia,
  pareceLicencia,
} from './lib/licencia-cliente.mjs';

const args = process.argv.slice(2);
const unaVez = args.includes('--una-vez');
const pedirAyuda = args.includes('--ayuda') || args.includes('--help');

const AYUDA = [
  'OdontoCRM · bot de administración del consultorio',
  '',
  'Comandos:',
  adminBotCommandsAsText(),
  '',
  'Para activar la licencia, reenvía a este chat el archivo .lic que te mande el proveedor.',
  '',
  'Solo responde al chat configurado (ADMIN_TELEGRAM_CHAT_ID).',
].join('\n');

if (pedirAyuda) {
  console.log(AYUDA);
  process.exit(0);
}

let bot = await crearBotAdmin();
if (bot === null && unaVez) {
  // NO es un fallo: es una instalación sin bot de administración. Se sale con 0 para que el
  // supervisor (PM2 con `stop_exit_codes: [0]`, systemd con `Restart=on-failure`) NO lo
  // reinicie en bucle.
  console.log(
    'sin bot de administración configurado (faltan ADMIN_TELEGRAM_BOT_TOKEN / ADMIN_TELEGRAM_CHAT_ID): no hay nada que escuchar.',
  );
  process.exit(0);
}
if (bot === null) {
  // Tampoco es un fallo, pero aquí NO se sale: las credenciales pueden llegar después (el panel
  // las guarda en caliente, y al arrancar la máquina la base de identity todavía no responde).
  // Un `exit(0)` en ese momento dejaba el servicio «muerto en verde» —ni PM2 (`stop_exit_codes`)
  // ni systemd (`Restart=on-failure`) lo reinician— y el bot no volvía a escuchar hasta que
  // alguien lo arrancara a mano: `/estado` no respondía NUNCA aunque el resto funcionaba.
  console.log(
    'sin bot de administración todavía (sin credenciales, o la base de identity no responde): reintentaré cada 60 s',
  );
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

/* ── Licencia del consultorio (ADR 0075) ──────────────────────────────────── */

/** Estado de la licencia + instalación + solicitud para reenviar al proveedor. */
const responderLicencia = async () => {
  const resultado = await estadoLicencia();
  if (!resultado.ok) {
    await bot.sendMessage(`⚠ No pude leer el estado de la licencia: ${resultado.mensaje}`);
    return;
  }
  await bot.sendMessage(formatearLicenciaDetalle(resultado.vista));
};

/**
 * Activa la licencia que el dueño **reenvía como documento**. Solo se verifica la firma con la
 * clave pública de identity: el bot no firma nada (la clave privada vive en el proveedor).
 *
 * Se rechaza antes de llamar a identity lo que evidentemente no es una licencia (una foto, un
 * PDF, un token de sesión) para contestar al instante; el tamaño máximo es el de un JWT.
 */
const responderDocumentoLicencia = async (documento) => {
  const nombre =
    typeof documento.file_name === 'string' && documento.file_name !== ''
      ? documento.file_name
      : 'el archivo';

  if (typeof documento.file_id !== 'string' || documento.file_id === '') {
    await bot.sendMessage(`⚠ No pude descargar ${nombre}: Telegram no me dio su identificador.`);
    return;
  }
  if (typeof documento.file_size === 'number' && documento.file_size > MAX_LICENCIA_BYTES) {
    await bot.sendMessage(
      `⚠ ${nombre} pesa demasiado para ser una licencia (máximo ${String(
        Math.round(MAX_LICENCIA_BYTES / 1024),
      )} KB).`,
    );
    return;
  }

  const archivo = await bot.getFile(documento.file_id);
  if (archivo.file_path === undefined) {
    await bot.sendMessage(`⚠ Telegram no me dio la ruta de ${nombre}: no pude activarlo.`);
    return;
  }
  if (typeof archivo.file_size === 'number' && archivo.file_size > MAX_LICENCIA_BYTES) {
    await bot.sendMessage(`⚠ ${nombre} pesa demasiado para ser una licencia.`);
    return;
  }

  const contenido = await bot.descargarArchivo(archivo.file_path);
  if (contenido.length > MAX_LICENCIA_BYTES) {
    await bot.sendMessage(`⚠ ${nombre} pesa demasiado para ser una licencia.`);
    return;
  }

  // El `.lic` es el JWT compacto tal cual lo emitió el proveedor (puede traer saltos de línea).
  const token = contenido.toString('utf8').trim();
  if (!pareceLicencia(token)) {
    await bot.sendMessage(
      `⚠ ${nombre} no parece una licencia de OdontoCRM (.lic). ` +
        'Reenvía el archivo tal cual lo mandó el proveedor.',
    );
    return;
  }

  const resultado = await activarLicencia(token);
  if (!resultado.ok) {
    await bot.sendMessage(`⚠ No pude activar la licencia: ${resultado.mensaje}`);
    return;
  }

  // Ya está activa: el recordatorio de hoy no hace falta (y si tocaba, no importa).
  ultimoAvisoDeLicencia = diaEnCaracas();
  await bot.sendMessage(formatearActivacionLicencia(resultado.vista));
};

/** Hora local del consultorio (0–23), que es la que decide la franja del recordatorio. */
const horaEnCaracas = () =>
  Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'America/Caracas',
      hour: '2-digit',
      hour12: false,
    }).format(new Date()),
  );

/** `AAAA-MM-DD` en Caracas: la llave del «una vez al día». */
const diaEnCaracas = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Caracas',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

/** Franja en la que se puede mandar el recordatorio (no a las tres de la mañana). */
const AVISO_DESDE_HORA = 8;
const AVISO_HASTA_HORA = 21;

/** Estados en los que hay que empujar la renovación. */
const ESTADOS_QUE_AVISAN = new Set([
  'trial_por_vencer',
  'trial_vencida',
  'licencia_por_vencer',
  'licencia_vencida',
  'reloj_atrasado',
]);

/** Día (en Caracas) del último recordatorio enviado; en memoria, como acordó el plan. */
let ultimoAvisoDeLicencia = null;
/** Reintento del recordatorio si identity no responde (y que no se pregunte en cada ciclo). */
let proximoIntentoDeAviso = 0;

/**
 * Recordatorio **diario** de licencia: una vez al día, en la franja de 8 a 21, si la prueba o
 * la licencia están por vencer o vencidas. No sustituye al banner ni a `/licencia`: es el
 * empujón por Telegram para que la renovación no pille a nadie.
 *
 * No se apoya en el temporizador de alertas de 5 minutos a propósito: ese repetiría el aviso
 * cada cinco minutos. Aquí el estado se consulta a identity y el día queda marcado en memoria
 * (si el proceso se reinicia, como mucho se repite una vez).
 */
const revisarAvisoDeLicencia = async () => {
  if (bot === null) return;

  const hoy = diaEnCaracas();
  if (ultimoAvisoDeLicencia === hoy || Date.now() < proximoIntentoDeAviso) return;

  const hora = horaEnCaracas();
  if (hora < AVISO_DESDE_HORA || hora >= AVISO_HASTA_HORA) return;

  const resultado = await estadoLicencia();
  if (!resultado.ok) {
    // identity caída: se reintenta en un rato; no es un fallo del bot.
    proximoIntentoDeAviso = Date.now() + 5 * 60_000;
    return;
  }

  // El día queda mirado aunque no toque avisar: no se vuelve a preguntar hasta mañana.
  ultimoAvisoDeLicencia = hoy;
  const vista = resultado.vista;
  if (!ESTADOS_QUE_AVISAN.has(vista.estado)) return;

  // El reloj atrasado no se arregla con un `.lic`: lo que hay que decir es que se corrija la hora.
  const texto =
    vista.estado === 'reloj_atrasado'
      ? `⚠ Licencia: ${vista.mensaje}`
      : `${vista.soloLectura ? '⚠ Licencia' : '⏳ Licencia'}: ${vista.mensaje}\n\n` +
        'Cuando la tengas, reenvía a este chat el archivo .lic. También puedes verla con /licencia.';
  await bot.sendMessage(texto);
};

const atender = async (mensaje) => {
  // El candado: solo el chat anclado. Cualquier otro, ignorado en silencio.
  if (String(mensaje.chat?.id ?? '') !== bot.chatId) return;

  // Un documento reenviado a este chat es, por convención, la licencia que se quiere activar.
  if (mensaje.document !== undefined) {
    await responderDocumentoLicencia(mensaje.document);
    return;
  }

  switch (comandoDe(mensaje.text)) {
    case 'start':
      await bot.sendMessage(`OdontoCRM · bot de administración.\n\n${adminBotCommandsAsText()}`);
      break;
    case 'estado':
      await responderEstado();
      break;
    case 'licencia':
      await responderLicencia();
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
  if (bot === null) return;
  const updates = await bot.getUpdates(offset, timeoutSeconds);
  for (const update of updates) {
    offset = update.update_id + 1;
    const mensaje = update.message;
    if (mensaje === undefined) continue;
    // El bot atiende texto (comandos) y documentos (el `.lic` reenviado para activar).
    if (typeof mensaje.text !== 'string' && mensaje.document === undefined) continue;
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
  // `bot` puede ser `null` (arranque sin credenciales): en ese caso CUALQUIER novedad se adopta.
  // Antes `bot.firma` lanzaba `TypeError` aquí y el bot nunca llegaba a adoptar las credenciales
  // que aparecieran después: se quedaba sordo para siempre.
  if (nuevo === null || (bot !== null && nuevo.firma === bot.firma)) return;

  const primero = bot === null;
  bot = nuevo;
  console.log(
    primero
      ? `bot de administración disponible (chat ${bot.chatId}): escuchando`
      : 'credenciales del bot actualizadas desde el panel',
  );
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

  if (bot !== null) {
    console.log(`Bot de administración escuchando (chat ${bot.chatId}).`);
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
        // Sin credenciales todavía: sin este respiro el bucle giraría en vacío (el `ciclo`
        // devuelve enseguida) quemando CPU hasta que el panel tenga el token.
        await new Promise((seguir) => setTimeout(seguir, REVISAR_CREDENCIALES_MS));
        continue;
      }
      // El recordatorio diario va antes del sondeo: si toca, sale sin esperar un mensaje.
      await revisarAvisoDeLicencia();
      await ciclo(POLL_TIMEOUT);
    } catch (fallo) {
      console.error(`falló el sondeo: ${fallo instanceof Error ? fallo.message : fallo}`);
      await new Promise((seguir) => setTimeout(seguir, 5_000));
    }
  }
  console.log('Bot de administración detenido.');
};

await main();
