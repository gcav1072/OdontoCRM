#!/usr/bin/env node
/**
 * Configuración del **emisor de licencias** (la máquina del proveedor).
 *
 * El software de licencias vive en este mismo repositorio, pero sus datos **no**:
 *
 *   · la **clave privada** con la que se firman las licencias,
 *   · el **token del bot** de Telegram del proveedor, y
 *   · el **registro** de lo emitido y los `.lic` que se entregaron
 *
 * viven en los directorios de configuración y datos del usuario que emite, fuera
 * del repo ([ADR 0075](../../docs/adr/0075-licenciamiento-offline-y-modo-consulta.md)).
 * Así es imposible que un `git add -A` los versiones y que el consultorio los
 * reciba con el código: el cliente ya tiene la app, pero nunca la clave.
 *
 * Las rutas son las del usuario en las dos plataformas donde corre el proveedor:
 *
 *   Linux/Fedora   config: $XDG_CONFIG_HOME/odontocrm/licencias (o ~/.config/…)
 *                  datos:  $XDG_DATA_HOME/odontocrm/licencias (o ~/.local/share/…)
 *   Windows        config: %APPDATA%\odontocrm\licencias
 *                  datos:  %LOCALAPPDATA%\odontocrm\licencias
 *
 * Se pueden forzar con `ODONTOCRM_LICENCIAS_CONFIG_DIR` y
 * `ODONTOCRM_LICENCIAS_DATA_DIR` (pruebas, otro disco, un host dedicado). El
 * destino de `claves --publicar` también admite override
 * (`ODONTOCRM_LICENCIAS_PUBLICA_DESTINO`), pensado para pruebas y clones: lo
 * normal es publicar en `assets/licencias/licencia-publica.pem` del repo.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Raíz del repositorio, calculada desde este archivo (sirve en cualquier cwd). */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const NOMBRE_PRIVADA = 'licencia-privada.pem';
export const NOMBRE_PUBLICA = 'licencia-publica.pem';
export const NOMBRE_BOT_ENV = 'licencia-bot.env';
export const NOMBRE_REGISTRO = 'registro.jsonl';
export const NOMBRE_EMITIDAS = 'emitidas';

/** API de Telegram por defecto; `TELEGRAM_API_BASE` permite apuntar a un proxy. */
export const TELEGRAM_API_BASE_POR_DEFECTO = 'https://api.telegram.org';

/**
 * Directorio de configuración por defecto del usuario (contiene la clave privada).
 * En Windows se usa `%APPDATA%` (perfil móvil); en el resto, `$XDG_CONFIG_HOME`.
 */
export const configDirPorDefecto = ({
  plataforma = process.platform,
  entorno = process.env,
  home = homedir(),
} = {}) => {
  if (plataforma === 'win32') {
    return join(entorno.APPDATA ?? join(home, 'AppData', 'Roaming'), 'odontocrm', 'licencias');
  }
  return join(entorno.XDG_CONFIG_HOME ?? join(home, '.config'), 'odontocrm', 'licencias');
};

/**
 * Directorio de datos por defecto del usuario (registro y `.lic` emitidos). En
 * Windows se usa `%LOCALAPPDATA%` (no viaja con el perfil); en el resto,
 * `$XDG_DATA_HOME`.
 */
export const dataDirPorDefecto = ({
  plataforma = process.platform,
  entorno = process.env,
  home = homedir(),
} = {}) => {
  if (plataforma === 'win32') {
    return join(entorno.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'odontocrm', 'licencias');
  }
  return join(entorno.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'odontocrm', 'licencias');
};

/**
 * Todas las rutas que usa el emisor, ya resueltas y absolutas.
 *
 * `publicaDelRepo` es el **destino de publicación** de la clave pública: el
 * asset que viaja con la app. Se puede sobreescribir con
 * `ODONTOCRM_LICENCIAS_PUBLICA_DESTINO` (pruebas o un clon del repo), pero el
 * camino normal es `assets/licencias/licencia-publica.pem`.
 */
export const rutasDeLicencias = ({
  plataforma = process.platform,
  entorno = process.env,
  home = homedir(),
} = {}) => {
  const configDir =
    entorno.ODONTOCRM_LICENCIAS_CONFIG_DIR ?? configDirPorDefecto({ plataforma, entorno, home });
  const dataDir =
    entorno.ODONTOCRM_LICENCIAS_DATA_DIR ?? dataDirPorDefecto({ plataforma, entorno, home });
  const publicaDelRepo =
    entorno.ODONTOCRM_LICENCIAS_PUBLICA_DESTINO ??
    join(ROOT, 'assets', 'licencias', NOMBRE_PUBLICA);

  return {
    configDir,
    dataDir,
    privada: join(configDir, NOMBRE_PRIVADA),
    publica: join(configDir, NOMBRE_PUBLICA),
    botEnv: join(configDir, NOMBRE_BOT_ENV),
    registro: join(dataDir, NOMBRE_REGISTRO),
    emitidas: join(dataDir, NOMBRE_EMITIDAS),
    publicaDelRepo,
  };
};

/** Crea los directorios del emisor si faltan (config 0700 y datos 0700). */
export const asegurarDirectorios = (rutas = rutasDeLicencias()) => {
  mkdirSync(rutas.configDir, { recursive: true, mode: 0o700 });
  mkdirSync(rutas.dataDir, { recursive: true, mode: 0o700 });
  mkdirSync(rutas.emitidas, { recursive: true, mode: 0o700 });
  return rutas;
};

/** ¿Ya hay claves generadas en la configuración? (para pedir `--force`). */
export const existenClaves = (rutas = rutasDeLicencias()) =>
  existsSync(rutas.privada) || existsSync(rutas.publica);

/**
 * Lector de un archivo `.env` en `CLAVE=valor`. No imprime nada nunca: devuelve
 * el mapa y el que lo use decide qué mostrar (jamás la clave privada ni el token).
 */
export const parsearEnv = (texto) => {
  const valores = {};
  for (const linea of String(texto ?? '').split(/\r?\n/u)) {
    const limpia = linea.trim();
    if (limpia === '' || limpia.startsWith('#')) continue;
    const separador = limpia.indexOf('=');
    if (separador <= 0) continue;
    const clave = limpia.slice(0, separador).trim();
    const valor = limpia.slice(separador + 1).trim();
    valores[clave] = valor.replace(/^['"]|['"]$/gu, '');
  }
  return valores;
};

/** Lee un `.env` (vacío si no existe). */
export const leerEnvFile = (ruta) => {
  if (!existsSync(ruta)) return {};
  return parsearEnv(readFileSync(ruta, 'utf8'));
};

/**
 * Credenciales del bot de Telegram del proveedor. Las variables de entorno
 * mandan sobre el archivo `licencia-bot.env` (la convención del proyecto).
 *
 * Devuelve `null` cuando no hay token o chat: sin ellos no hay bot que
 * escuchar, y eso **no es un fallo** (el proceso sale con 0 para que PM2/systemd
 * no lo reinicien en bucle).
 */
export const credencialesBot = (rutas = rutasDeLicencias(), entorno = process.env) => {
  const archivo = leerEnvFile(rutas.botEnv);
  const token = String(entorno.LICENCIA_BOT_TOKEN ?? archivo.LICENCIA_BOT_TOKEN ?? '').trim();
  const chatId = String(entorno.LICENCIA_BOT_CHAT_ID ?? archivo.LICENCIA_BOT_CHAT_ID ?? '').trim();
  if (token === '' || chatId === '') return null;
  // Marcador de plantilla sin rellenar: se trata como «sin configurar».
  if (/^CAMBIAR/iu.test(token) || /^CAMBIAR/iu.test(chatId)) return null;

  return {
    token,
    chatId,
    apiBase: String(
      entorno.TELEGRAM_API_BASE ?? archivo.TELEGRAM_API_BASE ?? TELEGRAM_API_BASE_POR_DEFECTO,
    )
      .trim()
      .replace(/\/+$/u, ''),
  };
};

/**
 * Rutas en texto, para la ayuda del CLI y del bot. Muestra dónde vive todo sin
 * enseñar ningún valor sensible (las rutas no lo son).
 */
export const resumenRutas = (rutas = rutasDeLicencias()) =>
  [
    `  config (clave privada, pública y licencia-bot.env): ${rutas.configDir}`,
    `  datos (registro.jsonl y .lic emitidos):             ${rutas.dataDir}`,
    `  clave pública que viaja con la app:                 ${rutas.publicaDelRepo}`,
    '',
    '  Overrides: ODONTOCRM_LICENCIAS_CONFIG_DIR · ODONTOCRM_LICENCIAS_DATA_DIR',
  ].join('\n');
