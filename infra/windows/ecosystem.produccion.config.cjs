/**
 * PM2 — procesos de OdontoCRM en el servidor **Windows** de producción (ADR 0050).
 *
 *   pm2 start infra\windows\ecosystem.produccion.config.cjs
 *   pm2 save                       # fija la lista para el servicio de Windows
 *   pm2 status
 *   pm2 logs odontocrm-clinical
 *
 * Es el equivalente en Windows de `infra/fedora/ecosystem.config.cjs`. **El
 * `infra/windows/ecosystem.config.cjs` NO sirve para producción**: aquel usa rutas
 * relativas al repositorio y los `.env` del propio clon (desarrollo). Aquí las rutas son
 * absolutas y los secretos viven en `C:\ProgramData\OdontoCRM\env`.
 *
 * ── Regla de oro: UN SOLO SUPERVISOR ─────────────────────────────────────────
 * Si usas PM2 (el supervisor de Windows), **no** levantes la pila de desarrollo
 * (`stack:fijo`) a la vez: los dos quieren los mismos puertos y uno falla con
 * `EADDRINUSE` (ADR 0037). *
 * ── Regla de oro 2: `exec_mode: 'fork'` y NUNCA `instances` ─────────────
 * Cada app lo declara explícitamente más abajo. En PM2, poner `instances` (aunque sea `1`)
 * cambia el modo a **cluster**, y el contenedor de cluster de PM2 5.2.2 hace
 * `import(process.env.pm_exec_path)` con una **ruta** en vez de una URL `file://`: en Windows
 * el cargador ESM de Node lee `C:\…` como el esquema `c:` y falla con
 * `ERR_UNSUPPORTED_ESM_URL_SCHEME`. El proceso queda «online» **sin cargar la aplicación**:
 * ningún puerto escucha y no hay nada en los registros (el síntoma que costó una tarde).
 * En Fedora el cluster funciona por casualidad, porque una ruta POSIX (`/opt/…`) sí es válida.
 * Los servicios son de UNA instancia, así que `fork` no renuncia a nada. *
 * ── Variables de entorno: los DOS archivos, como en desarrollo ───────────────
 * El arranque real usa dos archivos:
 *   node --env-file-if-exists=…\odontocrm.env --env-file-if-exists=…\<servicio>.env
 * En producción esos dos son:
 *   C:\ProgramData\OdontoCRM\env\odontocrm.env   COMÚN a los servicios (puertos, URLs, TZ…)
 *   C:\ProgramData\OdontoCRM\env\<servicio>.env  PROPIO del servicio (DATABASE_URL, …)
 *
 * PM2 corre como `NT AUTHORITY\LocalService`, así que los `.env` tienen que ser legibles
 * por esa cuenta: el instalador les pone una ACL de lectura (LocalService) y control total
 * (Administradores), SIN herencia, para que no entren «Users».
 *
 * Los secretos NUNCA están en este archivo.
 */
const path = require('node:path');
const { existsSync, readdirSync } = require('node:fs');

/** Código desplegado y compilado (lo compila el instalador como Administrador). */
const codigo = process.env.ODONTOCRM_CODE_DIR ?? 'C:\\OdontoCRM';
/** Configuración y secretos. */
const etc = process.env.ODONTOCRM_ETC_DIR ?? 'C:\\ProgramData\\OdontoCRM';
const envDir = path.join(etc, 'env');
/**
 * Datos escribibles por el servicio (almacén, navegador, temporales): `data`.
 * La misma regla que `$OdontoDatos` de `instalar\comun.ps1` (y que `--data-dir` del
 * aprovisionador), para que los tres apunten a la MISMA carpeta aunque se sobrescriba
 * por entorno (`ODONTOCRM_DATA_DIR`).
 */
const datos = process.env.ODONTOCRM_DATA_DIR ?? path.join(codigo, 'data');
/**
 * La carpeta temporal del SERVICIO (`data\tmp`, con permiso de escritura para
 * LocalService — la crea `10-preparar.ps1`). Es donde Playwright hace `mkdtemp`; ver la
 * nota de `servicio()` más abajo.
 */
const tmp = path.join(datos, 'tmp');
/** Logs en archivo (PM2 los rota con pm2-logrotate; los instala `servicios\instalar-pm2.ps1`). */
const logs = path.join(codigo, 'logs');

/**
 * Un proceso por servicio.
 *
 * @param {string} nombre  nombre corto del servicio (`gateway`, `identity`, …)
 * @param {string} entrada ruta relativa al punto de entrada compilado (`dist/index.js`;
 *                         `dist/server.js` es un módulo interno, no se arranca con `node`)
 * @returns {object} definición de app para PM2
 */
const servicio = (nombre, entrada) => ({
  name: `odontocrm-${nombre}`,
  script: path.join(codigo, entrada),
  cwd: codigo,
  interpreter: 'node',
  // Los MISMOS dos archivos, en el mismo orden (el segundo pisa al primero).
  node_args: [
    `--env-file-if-exists=${path.join(envDir, 'odontocrm.env')}`,
    `--env-file-if-exists=${path.join(envDir, `${nombre}.env`)}`,
  ],
  env: {
    NODE_ENV: 'production',
    /**
     * **Los temporales del servicio, fijados a `data\tmp`.** Playwright crea
     * `playwright-artifacts-…` con `mkdtemp` en el `os.tmpdir()` del proceso, y los
     * procesos heredan el entorno de la consola que hizo `pm2 start` —en el `pm2 jlist`
     * se ven a la vez `username` y `USERNAME`, de dos consolas distintas—: al arrancar
     * desde una consola de Administrador, `%TEMP%` apuntaba a
     * `C:\Users\Admin\AppData\Local\Temp`, donde `LocalService` (la cuenta del servicio
     * de PM2) NO puede escribir. Resultado (2026-10-15): los imprimibles —récipe, factura
     * y reportes— fallaban con «EPERM … mkdtemp …playwright-artifacts…». Al fijarlo AQUÍ
     * manda sobre lo que traiga la consola, y `pm2 save` lo queda para los arranques con
     * Windows. `data\tmp` la crea `10-preparar.ps1` con permiso de escritura para el
     * servicio (la misma carpeta que usa el bot de administración para sus volcados).
     */
    TMPDIR: tmp,
    TMP: tmp,
    TEMP: tmp,
  },
  /**
   * **`fork`, explícito, y NUNCA `instances`.** En PM2, poner `instances` (aunque sea `1`) cambia
   * el modo a **cluster**, y el contenedor de cluster de PM2 5.2.2 carga las apps con
   * `import(process.env.pm_exec_path)` —una RUTA, no una URL—, que en Windows el cargador ESM de
   * Node rechaza con `ERR_UNSUPPORTED_ESM_URL_SCHEME` (lee `C:\…` como el esquema `c:`). El hijo
   * queda «online» sin cargar la app: **ningún puerto escucha y no hay nada en los registros**.
   * El contenedor de `fork` sí lo hace bien (`url.pathToFileURL`). En Fedora el modo cluster
   * funciona por casualidad (una ruta POSIX `/opt/…` sí es válida para el cargador).
   * Como cada servicio es de UNA instancia, `fork` no renuncia a nada.
   */
  exec_mode: 'fork',
  autorestart: true,
  max_restarts: 20,
  restart_delay: 3000,
  kill_timeout: 8000,
  max_memory_restart: '400M',
  merge_logs: true,
  time: true,
  out_file: path.join(logs, `${nombre}.out.log`),
  error_file: path.join(logs, `${nombre}.error.log`),
});

/**
 * Los servicios se DESCUBREN, no se listan a mano: una carpeta `services\<x>\` con
 * `migrations\`. Es la misma regla que en Fedora y evita que al añadir un servicio (pasó
 * con `billing`) se quede fuera de la supervisión.
 */
const servicios = existsSync(path.join(codigo, 'services'))
  ? readdirSync(path.join(codigo, 'services'), { withFileTypes: true })
      .filter(
        (entrada) =>
          entrada.isDirectory() &&
          existsSync(path.join(codigo, 'services', entrada.name, 'migrations')),
      )
      .map((entrada) => entrada.name)
      .sort()
  : [];

/**
 * El **bot de administración** (`/estado`, `/respaldos`, `/respaldo` por Telegram) NO es un
 * servicio: no sirve HTTP ni tiene base propia, es una herramienta de consola que escucha
 * Telegram. Se supervisa igual (para que reviva solo) pero con sus propias variables:
 *   · `ODONTOCRM_ENV_DIR`: de dónde saca el token del bot y los `DATABASE_URL` a volcar.
 *   · `ODONTOCRM_ADMIN_TMP_DIR`: dónde escribe los volcados que manda por chat —`%TEMP%` no es
 *     escribible por LocalService, así que se le da la carpeta `data\tmp` (creada con permiso
 *     de escritura por `10-preparar.ps1`).
 *   · `ODONTOCRM_BACKUP_MANUAL_DIR`: dónde deja el respaldo COMPLETO de `/respaldo` (bases,
 *     configuración y almacén). Va dentro de `data` —que LocalService ya puede escribir— y no en
 *     `backups`, que es solo de Administradores: el bot NO puede escribir ahí.
 * `stop_exit_codes: [0]`: si no hay bot configurado, la herramienta SALE CON 0 (no es un
 * fallo); sin esto, PM2 la reiniciaría en bucle.
 */
const botAdmin = () => ({
  name: 'odontocrm-admin-bot',
  script: path.join(codigo, 'tools', 'admin-bot.mjs'),
  cwd: codigo,
  interpreter: 'node',
  env: {
    NODE_ENV: 'production',
    ODONTOCRM_ENV_DIR: envDir,
    ODONTOCRM_ADMIN_TMP_DIR: tmp,
    ODONTOCRM_BACKUP_MANUAL_DIR: path.join(datos, 'respaldo-manual'),
    // Mismo motivo que en `servicio()`: el bot también hace `mkdtemp` (pg_dump, Playwright
    // de los informes) y corre como LocalService.
    TMPDIR: tmp,
    TMP: tmp,
    TEMP: tmp,
  },
  exec_mode: 'fork',
  autorestart: true,
  stop_exit_codes: [0],
  max_restarts: 20,
  restart_delay: 5000,
  kill_timeout: 8000,
  merge_logs: true,
  time: true,
  out_file: path.join(logs, 'admin-bot.out.log'),
  error_file: path.join(logs, 'admin-bot.error.log'),
});

module.exports = {
  apps: [
    // La puerta primero (no tiene base propia): responde /health y reintenta por su cuenta.
    servicio('gateway', 'apps/gateway/dist/index.js'),
    ...servicios.map((nombre) => servicio(nombre, `services/${nombre}/dist/index.js`)),
    // El bot de administración, al final: no sirve HTTP ni depende de los servicios.
    botAdmin(),
  ],
};
