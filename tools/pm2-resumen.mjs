#!/usr/bin/env node
/**
 * OdontoCRM · el resumen mínimo de `pm2 jlist`, para los guiones de instalación.
 *
 * El JSON de `pm2 jlist` trae el `env` **completo** de cada proceso, y ahí conviven claves que
 * solo difieren en mayúsculas (`username` y `USERNAME`, visto el 2026-10-15): el
 * `ConvertFrom-Json` de PowerShell 5.1 las da por **duplicadas** y lanza… y el `catch` del
 * verificador se lo tragaba, con lo que los diez procesos salían como «no está en PM2»
 * estando todos en marcha. Este comando se traga el JSON con el parser de Node —que no se
 * inmuta— y deja SOLO lo que los guiones necesitan saber: cómo se llama cada proceso y en qué
 * estado está.
 *
 * ```
 * pm2 jlist | node tools/pm2-resumen.mjs     # [{"nombre":"…","estado":"online"}, …]
 * node tools/pm2-resumen.mjs salida.txt      # …o desde un archivo
 * ```
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const AYUDA =
  `Uso: pm2 jlist | node tools/pm2-resumen.mjs [archivo]\n\n` +
  `  Resume la salida de \`pm2 jlist\` a [{"nombre","estado"}, …], que sí puede\n` +
  `  parsear PowerShell 5.1 (el JSON completo de PM2, no).\n`;

/**
 * De la salida de `pm2 jlist` (con lo que sea que la rodee) a la lista de procesos.
 *
 * El recorte no vale con `indexOf('[')`: los avisos del CLI (`[PM2] Spawning…`) empiezan igual,
 * y dentro del `env` hay cadenas con corchetes. Se busca el comienzo del arreglo y se barre
 * contando llaves —sin contar las que van dentro de cadenas— hasta cerrarlo.
 */
export function resumir(entrada) {
  // El comienzo del arreglo: el primer `[` que de verdad abre una lista (`[{` o `[]`), no el
  // de un aviso `[PM2] …` ni el de una marca de tiempo `[2026-10-15]`.
  let desde = -1;
  for (let i = entrada.indexOf('['); i >= 0; i = entrada.indexOf('[', i + 1)) {
    const resto = entrada.slice(i + 1).trimStart();
    if (resto.startsWith('{') || resto.startsWith(']')) {
      desde = i;
      break;
    }
  }
  if (desde < 0) throw new Error('no veo la lista de procesos en la entrada');
  let profundidad = 0;
  let enCadena = false;
  let escapado = false;
  for (let i = desde; i < entrada.length; i++) {
    const caracter = entrada[i];
    if (escapado) {
      escapado = false;
      continue;
    }
    if (enCadena) {
      if (caracter === '\\') escapado = true;
      else if (caracter === '"') enCadena = false;
      continue;
    }
    if (caracter === '"') {
      enCadena = true;
    } else if (caracter === '[') {
      profundidad++;
    } else if (caracter === ']') {
      profundidad--;
      if (profundidad === 0) {
        const lista = JSON.parse(entrada.slice(desde, i + 1));
        return lista.map((proceso) => ({
          nombre: proceso.name,
          estado: proceso.pm2_env?.status ?? 'desconocido',
        }));
      }
    }
  }
  throw new Error('no veo la lista de procesos en la entrada');
}

// El final solo corre cuando se invoca por la línea de comandos: quien importe `resumir` no
// tiene por qué quedarse esperando la entrada estándar (que es lo que pasaba en las pruebas).
const soyCLI = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (soyCLI) {
  const args = process.argv.slice(2);
  if (args.some((arg) => ['--ayuda', '-h', '--help'].includes(arg))) {
    console.log(AYUDA);
    process.exit(0);
  }

  const entrada = args[0] ? readFileSync(args[0], 'utf8') : readFileSync(0, 'utf8');
  try {
    console.log(JSON.stringify(resumir(entrada)));
  } catch (error) {
    console.error(`no pude leer la salida de pm2 jlist: ${error.message}`);
    process.exit(1);
  }
}
