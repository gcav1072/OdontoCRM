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
import { readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import {
  decryptBlob,
  encryptBlob,
  looksEncrypted,
  parseEncryptionKey,
  sha256OfPlain,
} from '@odontocrm/storage';

import { leerEnv } from './lib/servicios.mjs';

/* ── Los almacenes de los servicios que guardan archivos ───────────────────── */

/**
 * Los almacenes se **descubren**, no se listan: para cada servicio se toma el `STORAGE_DIR`
 * de su `.env` y, si no lo declara (lo normal: solo el despliegue lo escribe, en desarrollo
 * manda el valor por defecto del código), la carpeta `storage/<servicio>`, que es la
 * convención del repositorio. Así esta herramienta vale igual en desarrollo y en el
 * servidor, y añadir un servicio con almacén no exige tocarla.
 */
const almacenesDelEntorno = () => {
  const encontrados = [];
  for (const carpeta of readdirSync('services', { withFileTypes: true })) {
    if (!carpeta.isDirectory()) continue;

    const env = leerEnv(`services/${carpeta.name}/.env`);
    const declarado = (env.STORAGE_DIR ?? '').trim();
    const candidatos = declarado === '' ? [`./storage/${carpeta.name}`] : [declarado];

    for (const candidato of candidatos) {
      const dir = resolve(candidato);
      // Solo cuenta si la carpeta existe: un servicio sin archivos no es un almacén.
      try {
        if (!readdirSync(dir).length && declarado === '') continue;
      } catch {
        continue;
      }
      encontrados.push({
        servicio: carpeta.name,
        dir,
        clave: parseEncryptionKey(env.STORAGE_ENCRYPTION_KEY),
      });
    }
  }
  return encontrados;
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
      'podrá leer después por más que se recuerde la nueva.\n',
  );
  process.exit(0);
}

const almacenes = almacenesDelEntorno();
if (almacenes.length === 0) {
  console.error('✖ no encontré ningún servicio con STORAGE_DIR en su .env');
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
    `\n${almacen.servicio}: ${String(archivos.length)} archivo(s) en ${almacen.dir}\n` +
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
