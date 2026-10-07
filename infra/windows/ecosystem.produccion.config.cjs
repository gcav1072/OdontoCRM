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
 * `EADDRINUSE` (ADR 0037).
 *
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
  env: { NODE_ENV: 'production' },
  instances: 1,
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

module.exports = {
  apps: [
    // La puerta primero (no tiene base propia): responde /health y reintenta por su cuenta.
    servicio('gateway', 'apps/gateway/dist/index.js'),
    ...servicios.map((nombre) => servicio(nombre, `services/${nombre}/dist/index.js`)),
  ],
};
