/**
 * PM2 — **emisor de licencias del proveedor** (NO es un proceso del consultorio).
 *
 *   pm2 start infra/licencias/ecosystem.config.cjs
 *   pm2 logs odontocrm-licencias
 *   pm2 restart odontocrm-licencias
 *   pm2 save
 *
 * Este proceso corre en la máquina del proveedor porque necesita la **clave
 * privada** con la que se firman las licencias ([ADR 0075]). No se instala en el
 * servidor del consultorio: allí el bot que existe es otro (`odontocrm-admin-bot`,
 * que solo muestra el estado y activa reenviando un `.lic`).
 *
 * - Sin `instances`: en PM2 eso cambia a modo cluster y en Windows revienta con
 *   `ERR_UNSUPPORTED_ESM_URL_SCHEME` (mismo motivo que el ecosistema de la app).
 * - Las credenciales del bot y la clave privada **no** están aquí: viven en
 *   `licencia-bot.env` y en el directorio de configuración del usuario, fuera del
 *   repo (`tools/lib/licencia-config.mjs`).
 *
 * Ver `infra/licencias/INSTALL.md` para la instalación completa.
 */
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');

module.exports = {
  apps: [
    {
      name: 'odontocrm-licencias',
      script: 'tools/licencia-bot.mjs',
      cwd: root,
      interpreter: 'node',
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 20,
      restart_delay: 5000,
      kill_timeout: 15_000,
      max_memory_restart: '256M',
      merge_logs: true,
      time: true,
      out_file: path.join(root, 'logs', 'licencias.out.log'),
      error_file: path.join(root, 'logs', 'licencias.error.log'),
      env: {
        NODE_ENV: 'production',
        TZ: 'America/Caracas',
      },
    },
  ],
};
