#!/usr/bin/env node
/**
 * Piezas comunes de las herramientas de consola: la raíz del repositorio, la
 * lectura de los `.env` (sin imprimir nunca un valor) y la lista de servicios.
 *
 * Vivían dentro de `modo-test.mjs`; se separaron cuando el tablero de estado
 * (`tools/estado.mjs`) necesitó las mismas tres cosas: son de todas las
 * herramientas, no del modo test.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Servicios con base de datos propia y su archivo de entorno. */
/**
 * Los servicios se DESCUBREN del repositorio: una carpeta `services/<x>/` con `migraciones/`,
 * y su puerto declarado en `.env.example` (`<X>_PORT`). Antes había aquí dos listas copiadas a
 * mano (una con las bases, otra con los puertos y las unidades) que se quedaban viejas cada vez
 * que entraba un servicio —con `billing` se quedaron atrás hasta en el respaldo—. El gateway
 * va aparte: no tiene base propia y su unidad es otra.
 */
const conMigraciones = readdirSync(join(ROOT, 'services'), { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(ROOT, 'services', d.name, 'migrations')))
  .map((d) => d.name);

const puertoEnEnvExample = (nombre) => {
  const envExample = readFileSync(join(ROOT, '.env.example'), 'utf8');
  const m = new RegExp(`^${nombre.toUpperCase()}_PORT=(\\d+)$`, 'm').exec(envExample);
  return m === null ? 0 : Number(m[1]);
};

export const SERVICIOS = conMigraciones
  .map((name) => ({ name, database: `odonto_${name}`, env: `services/${name}/.env` }))
  .sort((a, b) => puertoEnEnvExample(a.name) - puertoEnEnvExample(b.name));

export const PROCESOS = [
  ...SERVICIOS.map(({ name }) => ({
    name,
    variable: `${name.toUpperCase()}_PORT`,
    port: puertoEnEnvExample(name),
    unidad: `odontocrm@${name}`,
  })),
  {
    name: 'gateway',
    variable: 'GATEWAY_PORT',
    port: puertoEnEnvExample('gateway'),
    unidad: 'odontocrm-gateway',
  },
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
