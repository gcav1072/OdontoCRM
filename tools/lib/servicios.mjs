#!/usr/bin/env node
/**
 * Piezas comunes de las herramientas de consola: la raíz del repositorio, la
 * lectura de los `.env` (sin imprimir nunca un valor) y la lista de servicios.
 *
 * Vivían dentro de `modo-test.mjs`; se separaron cuando el tablero de estado
 * (`tools/estado.mjs`) necesitó las mismas tres cosas: son de todas las
 * herramientas, no del modo test.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Servicios con base de datos propia y su archivo de entorno. */
export const SERVICIOS = [
  { name: 'patients', database: 'odonto_patients', env: 'services/patients/.env' },
  { name: 'scheduling', database: 'odonto_scheduling', env: 'services/scheduling/.env' },
  { name: 'clinical', database: 'odonto_clinical', env: 'services/clinical/.env' },
  { name: 'odontogram', database: 'odonto_odontogram', env: 'services/odontogram/.env' },
  { name: 'notifications', database: 'odonto_notifications', env: 'services/notifications/.env' },
  { name: 'screens', database: 'odonto_screens', env: 'services/screens/.env' },
  { name: 'identity', database: 'odonto_identity', env: 'services/identity/.env' },
  { name: 'reporting', database: 'odonto_reporting', env: 'services/reporting/.env' },
  { name: 'billing', database: 'odonto_billing', env: 'services/billing/.env' },
];

/**
 * Los diez procesos de la pila con su puerto y la variable que lo configura. El
 * orden es el de arranque (la base, los servicios, la puerta al final).
 */
export const PROCESOS = [
  { name: 'identity', variable: 'IDENTITY_PORT', port: 4001, unidad: 'odontocrm@identity' },
  { name: 'patients', variable: 'PATIENTS_PORT', port: 4002, unidad: 'odontocrm@patients' },
  { name: 'scheduling', variable: 'SCHEDULING_PORT', port: 4003, unidad: 'odontocrm@scheduling' },
  {
    name: 'notifications',
    variable: 'NOTIFICATIONS_PORT',
    port: 4004,
    unidad: 'odontocrm@notifications',
  },
  { name: 'clinical', variable: 'CLINICAL_PORT', port: 4005, unidad: 'odontocrm@clinical' },
  { name: 'odontogram', variable: 'ODONTOGRAM_PORT', port: 4006, unidad: 'odontocrm@odontogram' },
  { name: 'screens', variable: 'SCREENS_PORT', port: 4007, unidad: 'odontocrm@screens' },
  { name: 'reporting', variable: 'REPORTING_PORT', port: 4008, unidad: 'odontocrm@reporting' },
  { name: 'billing', variable: 'BILLING_PORT', port: 4009, unidad: 'odontocrm@billing' },
  { name: 'gateway', variable: 'GATEWAY_PORT', port: 8090, unidad: 'odontocrm-gateway' },
];

/** Lee un archivo `.env` sin imprimir jamás sus valores en un mensaje de error. */
export const leerEnv = (ruta) => {
  const absoluta = isAbsolute(ruta) ? ruta : resolve(ROOT, ruta);
  if (!existsSync(absoluta)) return {};

  const valores = {};
  for (const linea of readFileSync(absoluta, 'utf8').split(/\r?\n/)) {
    const limpia = linea.trim();
    if (limpia === '' || limpia.startsWith('#')) continue;
    const separador = limpia.indexOf('=');
    if (separador <= 0) continue;
    const clave = limpia.slice(0, separador).trim();
    const valor = limpia.slice(separador + 1).trim();
    valores[clave] = valor.replace(/^['"]|['"]$/g, '');
  }
  return valores;
};

/**
 * Dónde viven los `.env`. En desarrollo, dentro del repositorio (`services/<s>/.env`
 * y el `.env` de la raíz); **en producción**, en `/etc/odontocrm`, que es donde
 * `systemd` los lee. El tablero de estado funciona en los dos sitios sin cambiar
 * nada más que esta variable (`ODONTOCRM_ENV_DIR=/etc/odontocrm`).
 */
export const dirDeEntornos = () => process.env.ODONTOCRM_ENV_DIR ?? null;

/** Ruta del archivo de entorno de un servicio, según dónde estemos. */
export const rutaEnvDe = (servicio) => {
  const dir = dirDeEntornos();
  return dir === null ? servicio.env : join(dir, `${servicio.name}.env`);
};

/** Ruta del archivo común (`odontocrm.env` en producción). */
export const rutaEnvRaiz = () => {
  const dir = dirDeEntornos();
  return dir === null ? '.env' : join(dir, 'odontocrm.env');
};

export const entornoRaiz = () => leerEnv(rutaEnvRaiz());

/** Puerto efectivo de un proceso: el del `.env` de la raíz o el de por defecto. */
export const puertoDe = (proceso, entorno = entornoRaiz()) => {
  // El entorno manda sobre el archivo (convención del proyecto): así se puede
  // apuntar el tablero a otra pila sin tocar el `.env`.
  const valor = process.env[proceso.variable] ?? entorno[proceso.variable];
  const puerto = valor === undefined ? Number.NaN : Number(valor);
  return Number.isInteger(puerto) && puerto > 0 ? puerto : proceso.port;
};
