#!/usr/bin/env node
/**
 * **Migra el almacén al cifrado** (mejora 4.B del plan post-Fase 11).
 *
 * ```
 * npm run recifrar:almacen -- --estado      # solo informa: cuántos en claro, cuántos cifrados
 * npm run recifrar:almacen                  # cifra los que están en claro
 * npm run recifrar:almacen -- --todos       # los re-cifra todos (cambiar la clave)
 * ```
 *
 * **No se ejecuta solo, a propósito.** Activar el cifrado no necesita migrar nada —el
 * almacén lee las dos formas—, así que migrar es una decisión del operador: puede esperar a
 * la noche, hacerse por tandas o no hacerse nunca. Lo que **no** se puede es dejar que un
 * instalador recorra el historial clínico entero sin que nadie mire.
 *
 * El archivo se reescribe **en el sitio** (mismo nombre, mismo tamaño en la base), así que
 * las rutas guardadas siguen valiendo. La huella `sha256` de la base es la del contenido en
 * claro y no cambia: eso es lo que hace segura la migración —si algo se corrompiera, la
 * comprobación de integridad lo delata—.
 *
 * Es **idempotente**: lo que ya está cifrado no se toca (salvo con `--todos`), así que se
 * puede cortar y volver a correr.
 */
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import {
  decryptBlob,
  encryptBlob,
  looksEncrypted,
  parseEncryptionKey,
  sha256OfPlain,
} from '@odontocrm/storage';

import { entornoRaiz, leerEnv, ROOT, rutaEnvDe, SERVICIOS } from './lib/servicios.mjs';

/* ── Los almacenes de los servicios que guardan archivos ───────────────────── */

/**
 * ¿Este servicio guarda archivos? Se mira su **plantilla**: la que documenta `STORAGE_DIR` es
 * la que tiene almacén. Es la misma clase de descubrimiento que la carpeta `migrations/` para
 * las bases o el `<X>_PORT` del `.env.example` de la raíz para los puertos —una lista copiada a
 * mano se queda vieja—, y no hay que adivinar nada: si un servicio empieza a guardar archivos,
 * lo documenta ahí.
 */
const tieneAlmacen = (nombre) =>
  readFileSync(join(ROOT, 'services', nombre, '.env.example'), 'utf8').includes('STORAGE_DIR');

/**
 * Con qué se comparan dos claves: su **huella**, no el `Buffer`. Dos `Buffer` con los mismos
 * bytes son objetos distintos, así que un `Set` de claves daría «dos claves distintas» donde solo
 * hay una —y esa comprobación existe justo para no destruir archivos—.
 */
const huellaDe = (clave) => (clave === undefined ? null : clave.toString('hex'));

/**
 * Los almacenes se **descubren**, no se listan: para cada servicio con almacén se resuelve su
 * `STORAGE_DIR` y, si no lo declara, la carpeta `storage/<servicio>`, que es la convención del
 * repositorio. Así esta herramienta vale igual en desarrollo y en el servidor, y añadir un
 * servicio con almacén no exige tocarla.
 *
 * **El entorno se lee como lo leen los servicios**: primero el común y después el del servicio,
 * que manda. No es un detalle: el `.env` de la raíz declara `STORAGE_DIR=./storage/patients`
 * —una raíz **compartida**, y cada servicio escribe en su subcarpeta—, así que mirando solo el
 * `.env` de cada servicio esta herramienta se quedaba con las carpetas antiguas
 * (`storage/clinical`, `storage/billing`), que ya nadie lee, y **no tocaba ni uno de los
 * archivos vivos**. En el servidor era peor: los entornos viven en `/etc/odontocrm`
 * (`ODONTOCRM_ENV_DIR`), así que no encontraba ninguno.
 *
 * Los tres servicios comparten la raíz también en producción, así que el resultado se
 * **agrupa por carpeta**: sin agrupar se recorrería la misma tres veces y el recuento mentiría.
 */
const almacenesDelEntorno = () => {
  const comun = entornoRaiz();
  const porCarpeta = new Map();

  for (const servicio of SERVICIOS) {
    if (!tieneAlmacen(servicio.name)) continue;

    // El entorno manda sobre el archivo (convención del proyecto, la misma que usa el tablero
    // para los puertos): así se puede apuntar la migración a otro almacén sin tocar los `.env`,
    // que es lo que hace falta para probarla sobre una copia.
    const env = { ...comun, ...leerEnv(rutaEnvDe(servicio)) };
    const declarado = (process.env.STORAGE_DIR ?? env.STORAGE_DIR ?? '').trim();
    const dir = resolve(declarado === '' ? `./storage/${servicio.name}` : declarado);
    const clave = parseEncryptionKey(
      process.env.STORAGE_ENCRYPTION_KEY ?? env.STORAGE_ENCRYPTION_KEY,
    );

    const previo = porCarpeta.get(dir);
    if (previo === undefined) {
      porCarpeta.set(dir, {
        dir,
        servicios: [servicio.name],
        claves: new Set([huellaDe(clave)]),
        clave,
      });
      continue;
    }
    previo.servicios.push(servicio.name);
    previo.claves.add(huellaDe(clave));
  }

  const encontrados = [];
  for (const grupo of porCarpeta.values()) {
    // Solo cuenta si la carpeta existe: un servicio sin archivos no es un almacén.
    if (!existsSync(grupo.dir)) continue;

    // Dos claves distintas sobre la MISMA carpeta no es una configuración rara: es una forma
    // silenciosa de dejar medio historial ilegible. Se para y se dice. Se comparan por su
    // huella y no por el `Buffer`: dos `Buffer` con los mismos bytes no son el mismo objeto, y
    // el `Set` los contaría como dos claves distintas.
    const definidas = [...grupo.claves].filter((huella) => huella !== null);
    if (definidas.length > 1) {
      console.error(
        `✖ ${grupo.servicios.join(', ')} comparten la carpeta ${grupo.dir} con claves de ` +
          'cifrado distintas. Cifrar ahí sería destruir archivos: iguala las claves y repite.',
      );
      process.exit(1);
    }

    encontrados.push({
      servicios: grupo.servicios,
      dir: grupo.dir,
      // Si el grupo tiene clave, `clave` es la del primer servicio que la declaró; da igual cuál,
      // porque el paso anterior ya garantiza que todas las del grupo son la misma.
      clave: definidas.length === 0 ? undefined : grupo.clave,
    });
  }
  return encontrados.sort((a, b) => a.servicios[0].localeCompare(b.servicios[0]));
};

/** Todos los archivos de un directorio, recursivo (rutas relativas). */
const archivosDe = (dir) => {
  const resultado = [];
  const recorrer = (actual) => {
    let entradas;
    try {
      entradas = readdirSync(actual, { withFileTypes: true });
    } catch {
      return; // el directorio puede no existir todavía: no es un error
    }
    for (const entrada of entradas) {
      const camino = join(actual, entrada.name);
      if (entrada.isDirectory()) recorrer(camino);
      else if (entrada.isFile()) resultado.push(relative(dir, camino));
    }
  };
  recorrer(dir);
  return resultado.sort();
};

const args = process.argv.slice(2);
const soloEstado = args.includes('--estado');
const todos = args.includes('--todos');
const ayuda = args.includes('--ayuda') || args.includes('--help');

if (ayuda) {
  console.log(
    'Uso: npm run recifrar:almacen [-- --estado | --todos]\n\n' +
      '  (sin banderas)  cifra los archivos que están en claro\n' +
      '  --estado        solo informa de cómo está el almacén, sin escribir nada\n' +
      '  --todos         re-cifra TODOS los archivos (al cambiar la clave)\n\n' +
      'Antes de --todos: guarda la clave vieja. Sin ella, lo que se re-cifre aquí no se\n' +
      'podrá leer después por más que se recuerde la nueva.\n\n' +
      'El entorno manda sobre los `.env`: `STORAGE_DIR` y `STORAGE_ENCRYPTION_KEY` puestas en\n' +
      'la terminal apuntan la migración a otra carpeta, que es como se prueba sin riesgo.\n',
  );
  process.exit(0);
}

const almacenes = almacenesDelEntorno();
if (almacenes.length === 0) {
  console.error(
    '✖ no encontré ninguna carpeta de almacén (ni `STORAGE_DIR` ni `storage/<servicio>`)',
  );
  process.exit(1);
}

let totalEnClaro = 0;
let totalCifrados = 0;
let migrados = 0;
let fallos = 0;

for (const almacen of almacenes) {
  const archivos = archivosDe(almacen.dir);
  const enClaro = [];
  const cifrados = [];

  for (const archivo of archivos) {
    const bytes = readFileSync(join(almacen.dir, archivo));
    (looksEncrypted(bytes) ? cifrados : enClaro).push(archivo);
  }

  totalEnClaro += enClaro.length;
  totalCifrados += cifrados.length;

  console.log(
    `\n${almacen.servicios.join(' + ')}: ${String(archivos.length)} archivo(s) en ${almacen.dir}\n` +
      `  · ${String(enClaro.length)} en claro · ${String(cifrados.length)} cifrados` +
      (almacen.clave === undefined ? ' · SIN clave de cifrado (STORAGE_ENCRYPTION_KEY)' : ''),
  );

  if (soloEstado) continue;

  if (almacen.clave === undefined) {
    if (enClaro.length > 0) {
      console.log('  · se omite: sin clave no se puede cifrar (ponla y repite)');
    }
    continue;
  }

  const aMigrar = todos ? [...enClaro, ...cifrados] : enClaro;
  if (aMigrar.length === 0) {
    console.log('  · nada que hacer: todo está cifrado');
    continue;
  }

  console.log(`  · migrando ${String(aMigrar.length)} archivo(s)…`);
  for (const archivo of aMigrar) {
    const ruta = join(almacen.dir, archivo);
    try {
      const bytes = readFileSync(ruta);
      // Se lee **siempre** antes de escribir: un archivo cifrado con otra clave (o uno
      // ilegible) tiene que detener la migración en vez de destruir el original.
      const claro = looksEncrypted(bytes) ? decryptBlob(bytes, almacen.clave) : bytes;
      const huellaAntes = sha256OfPlain(claro);

      // Se escribe en un temporal y se renombra: un corte a mitad de la escritura no puede
      // dejar el archivo a medias (el original sigue intacto hasta el `rename`).
      const temporal = `${ruta}.recifrando`;
      writeFileSync(temporal, encryptBlob(claro, almacen.clave));
      renameSync(temporal, ruta);

      // Comprobación por efecto: se vuelve a leer del disco y tiene que dar el mismo
      // contenido. Mejor saberlo aquí que dentro de un mes.
      const releido = decryptBlob(readFileSync(ruta), almacen.clave);
      if (sha256OfPlain(releido) !== huellaAntes) {
        throw new Error('el archivo re-cifrado no coincide con el original');
      }
      migrados += 1;
    } catch (error) {
      fallos += 1;
      console.error(`    ✖ ${archivo}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

console.log(
  `\nresumen: ${String(totalEnClaro)} en claro · ${String(totalCifrados)} cifrados` +
    (soloEstado
      ? ' (solo lectura)'
      : ` · ${String(migrados)} migrado(s) · ${String(fallos)} fallo(s)`),
);

if (fallos > 0) process.exitCode = 1;
if (!soloEstado && migrados === 0 && totalEnClaro > 0) process.exitCode = 1;
