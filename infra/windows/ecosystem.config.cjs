/**
 * PM2 — procesos de OdontoCRM.
 *
 *   pm2 start infra/windows/ecosystem.config.cjs
 *   pm2 status
 *   pm2 logs odontocrm-gateway
 *   pm2 save
 *
 * Cada servicio lee su configuración de dos archivos `.env` (el de la raíz para
 * lo común y el suyo propio para su base de datos). Los secretos nunca están en
 * este archivo.
 *
 * Los servicios que aún no existen se añaden al final de su fase correspondiente
 * (ver docs/PLAN_MAESTRO_FASES.md §13).
 */
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');

/** @param {string} name @param {string} entry @param {string} envFile */
const service = (name, entry, envFile) => ({
  name: `odontocrm-${name}`,
  script: entry,
  cwd: root,
  interpreter: 'node',
  node_args: [
    `--env-file-if-exists=${path.join(root, '.env')}`,
    `--env-file-if-exists=${path.join(root, envFile)}`,
  ],
  autorestart: true,
  max_restarts: 20,
  restart_delay: 3000,
  kill_timeout: 8000,
  max_memory_restart: '400M',
  merge_logs: true,
  time: true,
  out_file: path.join(root, 'logs', `${name}.out.log`),
  error_file: path.join(root, 'logs', `${name}.error.log`),
});

module.exports = {
  apps: [
    service('gateway', 'apps/gateway/dist/index.js', 'apps/gateway/.env'),
    service('identity', 'services/identity/dist/index.js', 'services/identity/.env'),
    service('patients', 'services/patients/dist/index.js', 'services/patients/.env'),
    service('scheduling', 'services/scheduling/dist/index.js', 'services/scheduling/.env'),
    service('notifications', 'services/notifications/dist/index.js', 'services/notifications/.env'),
    service('screens', 'services/screens/dist/index.js', 'services/screens/.env'),
    service('clinical', 'services/clinical/dist/index.js', 'services/clinical/.env'),
    // Fase 6 (sesión B): odontogram · Fase 9: reporting
  ],
};
