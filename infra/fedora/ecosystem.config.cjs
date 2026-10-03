/**
 * PM2 — procesos de OdontoCRM en el servidor Fedora de producción.
 *
 *   cd /opt/odontocrm
 *   pm2 start infra/fedora/ecosystem.config.cjs     # arranca los procesos
 *   pm2 save                                        # fija la lista para el reinicio
 *   pm2 status
 *   pm2 logs odontocrm-clinical
 *
 * Este archivo es el equivalente en Fedora de `infra/windows/ecosystem.config.cjs`
 * (aquel usa rutas relativas al repositorio y solo sirve para desarrollo en
 * Windows). Aquí las rutas son ABSOLUTAS porque el código vive en /opt/odontocrm
 * y el usuario de sistema `odontocrm` lo tiene de solo lectura.
 *
 * ── Regla de oro: UN SOLO SUPERVISOR ─────────────────────────────────────────
 * Si usas PM2, **no** habilites las unidades `odontocrm@*.service` ni
 * `odontocrm-gateway.service` (dos supervisores enlazando los mismos puertos dan
 * `EADDRINUSE`). Elige PM2 **o** systemd, nunca los dos (INSTALL.md §10.1).
 *
 * ── Variables de entorno: los DOS archivos, como en desarrollo ───────────────
 * El arranque real del proyecto usa dos archivos:
 *   node --env-file-if-exists=.env --env-file-if-exists=services/<servicio>/.env \
 *        services/<servicio>/dist/index.js
 * En producción esos dos archivos son:
 *   /etc/odontocrm/odontocrm.env   COMÚN a los 9 servicios (puertos, URLs, TZ…)
 *   /etc/odontocrm/<servicio>.env  PROPIO del servicio (DATABASE_URL,
 *                                  INTERNAL_SERVICE_SECRET…)
 * Node NO pisa una variable que ya exista en el entorno: el `env` de PM2 (y el
 * `Environment=` de systemd) tienen prioridad sobre lo que digan los archivos.
 *
 * PM2 corre como el usuario `odontocrm`, así que para leer esos archivos hace
 * falta que sean legibles por su grupo: `0640 root:odontocrm` y el directorio
 * /etc/odontocrm en 0750 root:odontocrm (INSTALL.md §7.2 y §10.4). Con el
 * endurecimiento por defecto `0600 root:root` PM2 NO puede leerlos: en ese caso
 * usa systemd como supervisor.
 *
 * Los secretos NUNCA están en este archivo.
 *
 * > PENDIENTE FASE 10: confirmar en el Fedora real que `pm2 start` levanta los
 *   servicios con los dos `--env-file-if-exists` (y que no hay `EADDRINUSE` por
 *   tener también las unidades systemd habilitadas). INSTALL.md §10.4 y P-10.
 */
const path = require('node:path');

/** Código desplegado y compilado (INSTALL.md §9). */
const root = '/opt/odontocrm';
/** Configuración y secretos (INSTALL.md §8). */
const etcDir = '/etc/odontocrm';
/** Logs en archivo, además del journal si algún día se usa systemd. */
const logDir = '/var/log/odontocrm';

/**
 * Un proceso por servicio.
 *
 * @param {string} name  nombre corto del servicio (`gateway`, `identity`, …)
 * @param {string} entry ruta ABSOLUTA al punto de entrada compilado
 *                       (`dist/index.js`; `dist/server.js` es un módulo interno)
 * @returns {object} definición de app para PM2
 */
const service = (name, entry) => ({
  name: `odontocrm-${name}`,
  script: path.join(root, entry),
  cwd: root,
  interpreter: 'node',
  // Los MISMOS dos archivos que carga systemd con dos `EnvironmentFile=`.
  node_args: [
    `--env-file-if-exists=${path.join(etcDir, 'odontocrm.env')}`,
    `--env-file-if-exists=${path.join(etcDir, `${name}.env`)}`,
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
  out_file: path.join(logDir, `${name}.out.log`),
  error_file: path.join(logDir, `${name}.error.log`),
});

module.exports = {
  apps: [
    service('gateway', 'apps/gateway/dist/index.js'),
    service('identity', 'services/identity/dist/index.js'),
    // Al cerrar cada fase se añade aquí su servicio (misma llamada `service()`),
    // y se reinstala con: pm2 start infra/fedora/ecosystem.config.cjs && pm2 save
    //   Fase 2: patients       Fase 3: scheduling     Fase 4: notifications
    //   Fase 5: screens        Fase 6: clinical, odontogram
    //   Fase 9: reporting
  ],
};
