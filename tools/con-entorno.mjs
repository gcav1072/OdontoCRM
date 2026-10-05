#!/usr/bin/env node
/**
 * Ejecuta un comando con el entorno de un servicio del despliegue.
 *
 * **Por qué no se usa `source`.** Los `.env` de `/etc/odontocrm` **no son archivos de
 * shell**, pero bash los interpretaba como si lo fueran (`set -a; source …`), y eso rompe
 * en silencio justo los valores que más importan:
 *
 * - `WEB_ORIGIN=https://odontocrm.local, https://192.168.1.50` → el espacio hace que bash
 *   tome `https://192.168.1.50` como una orden: la variable queda **vacía** y el gateway
 *   pierde el CORS sin decir nada.
 * - Una contraseña con `$` se expande: `p4$$w0rd` se convierte en `p4<pid>w0rd` y la
 *   conexión falla con «password authentication failed» sobre una credencial que en el
 *   archivo está bien.
 *
 * Este cargador lee las líneas `CLAVE=VALOR` tal cual (comillas simples o dobles
 * envolventes se quitan; **nada** se expande ni se divide) y lanza el comando con ese
 * entorno. Es el mismo criterio con el que Node lee `--env-file-if-exists`.
 *
 * Uso:
 *   node tools/con-entorno.mjs <dir-env> <servicio> -- <comando> [args…]
 *   node tools/con-entorno.mjs /etc/odontocrm identity -- node services/identity/dist/db/migrate.js
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

const [dirEnv, servicio, ...resto] = process.argv.slice(2);

if (!dirEnv || !servicio || resto[0] !== '--' || resto.length < 2) {
  console.error(
    'uso: node tools/con-entorno.mjs <dir-env> <servicio> -- <comando> [args…]\n' +
      'ej.: node tools/con-entorno.mjs /etc/odontocrm clinical -- node services/clinical/dist/db/migrate.js',
  );
  process.exit(2);
}

const comando = resto.slice(1);

/** Lee un `.env` sin interpretarlo: `CLAVE=VALOR`, comillas envolventes fuera, nada más. */
const leerEnv = (ruta) => {
  if (!existsSync(ruta)) return {};
  const valores = {};
  for (const linea of readFileSync(ruta, 'utf8').split('\n')) {
    const limpia = linea.trim();
    if (limpia === '' || limpia.startsWith('#')) continue;
    const corte = limpia.indexOf('=');
    if (corte <= 0) continue;
    const clave = limpia.slice(0, corte).trim();
    let valor = limpia.slice(corte + 1).trim();
    if (
      (valor.startsWith('"') && valor.endsWith('"') && valor.length >= 2) ||
      (valor.startsWith("'") && valor.endsWith("'") && valor.length >= 2)
    ) {
      valor = valor.slice(1, -1);
    }
    valores[clave] = valor;
  }
  return valores;
};

const archivos = [join(dirEnv, 'odontocrm.env'), join(dirEnv, `${servicio}.env`)];
const faltan = archivos.filter((archivo) => !existsSync(archivo));
if (faltan.length === archivos.length) {
  console.error(`no encuentro el entorno de «${servicio}» en ${dirEnv}`);
  process.exit(1);
}

// El entorno del proceso se conserva (PATH, HOME, TZ…): solo se añaden/sobrescriben las
// claves de los archivos. Así `node` y las herramientas del sistema siguen encontrándose.
const entorno = { ...process.env };
for (const archivo of archivos) Object.assign(entorno, leerEnv(archivo));

const [ejecutable, ...argumentos] = comando;
const resultado = spawnSync(ejecutable, argumentos, {
  stdio: 'inherit',
  env: entorno,
  cwd: isAbsolute(process.cwd()) ? process.cwd() : undefined,
});

if (resultado.error) {
  console.error(`no pude ejecutar «${ejecutable}»: ${resultado.error.message}`);
  process.exit(127);
}
process.exit(resultado.status ?? 1);
