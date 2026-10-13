#!/usr/bin/env node
/**
 * **Comprueba que el almacén se puede leer** (radiografías, PDF de récipes y facturas).
 *
 * ```
 * node tools/verificar-almacen.mjs            # verifica una muestra y sale 0/1
 * node tools/verificar-almacen.mjs --estado   # solo cuenta (en claro / cifrados)
 * node tools/verificar-almacen.mjs --todos    # descifra TODOS los cifrados (lento)
 * ```
 *
 * **Por qué existe.** Reimprimir un récipe no recompone el PDF: vuelve a leer el archivo
 * archivado. Si al recuperar un respaldo el almacén no se repuso, o se repuso con otra
 * `STORAGE_ENCRYPTION_KEY`, el sistema **parece** sano —las bases están, el récipe verifica
 * en `/verificar/<código>`— pero ningún documento se abre. Esto lo detecta en el acto: cuenta
 * lo que hay y **descifra una muestra de verdad** con la clave configurada.
 *
 * Es la misma forma de leer el entorno que `recifrar-almacen.mjs`: `STORAGE_DIR` y
 * `STORAGE_ENCRYPTION_KEY` de la terminal mandan sobre los `.env`, así que se puede apuntar a
 * otra carpeta para probar sin riesgo.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { decryptBlob, looksEncrypted, parseEncryptionKey } from '@odontocrm/storage';

import { entornoRaiz, leerEnv, ROOT, rutaEnvDe, SERVICIOS } from './lib/servicios.mjs';

const args = process.argv.slice(2);
const soloEstado = args.includes('--estado');
const todos = args.includes('--todos');
const ayuda = args.includes('--ayuda') || args.includes('--help');

if (ayuda) {
  console.log(
    'Uso: node tools/verificar-almacen.mjs [--estado | --todos]\n\n' +
      '  (sin banderas)  descifra una muestra de los archivos cifrados y sale 0/1\n' +
      '  --estado        solo informa cómo está el almacén, sin descifrar nada\n' +
      '  --todos         descifra TODOS los cifrados (puede tardar en un almacén grande)\n\n' +
      'Sale con 1 si algún archivo cifrado no se descifra con la clave configurada: eso es\n' +
      'lo que rompe la reimpresión de récipes tras un respaldo.\n',
  );
  process.exit(0);
}

/** ¿Este servicio guarda archivos? Lo dice su plantilla (`STORAGE_DIR`). */
const tieneAlmacen = (nombre) =>
  readFileSync(join(ROOT, 'services', nombre, '.env.example'), 'utf8').includes('STORAGE_DIR');

const huellaDe = (clave) => (clave === undefined ? null : clave.toString('hex'));

/** Una clave mal escrita (longitud mala) es un error claro, no un stack trace sin contexto. */
const claveSegura = (valor) => {
  try {
    return parseEncryptionKey(valor);
  } catch (error) {
    console.error(
      `✖ STORAGE_ENCRYPTION_KEY no es válida: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
};

/**
 * Los almacenes se DESCUBREN y se **agrupan por carpeta**: los servicios que guardan binarios
 * comparten una sola raíz (y una sola clave), así que recorrerla una vez por servicio daría un
 * recuento inflado. Dos claves distintas sobre la misma carpeta se paran: dejaría medio
 * historial ilegible.
 */
const almacenesDelEntorno = () => {
  const comun = entornoRaiz();
  const porCarpeta = new Map();

  for (const servicio of SERVICIOS) {
    if (!tieneAlmacen(servicio.name)) continue;
    const env = { ...comun, ...leerEnv(rutaEnvDe(servicio)) };
    const declarado = (process.env.STORAGE_DIR ?? env.STORAGE_DIR ?? '').trim();
    const dir = resolve(declarado === '' ? `./storage/${servicio.name}` : declarado);
    const clave = claveSegura(process.env.STORAGE_ENCRYPTION_KEY ?? env.STORAGE_ENCRYPTION_KEY);

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
    const definidas = [...grupo.claves].filter((huella) => huella !== null);
    if (definidas.length > 1) {
      console.error(
        `✖ ${grupo.servicios.join(', ')} comparten ${grupo.dir} con claves distintas. ` +
          'Con una sola clave no se puede comprobar: iguala STORAGE_ENCRYPTION_KEY y repite.',
      );
      process.exit(1);
    }
    encontrados.push(grupo);
  }
  return encontrados;
};

/** Rutas (relativas) de todos los archivos de un almacén, en orden estable. */
const archivosDe = (dir) => {
  const resultado = [];
  const recorrer = (actual) => {
    let entradas;
    try {
      entradas = readdirSync(actual, { withFileTypes: true });
    } catch {
      return; // todavía puede no existir: no es un error
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

/** Cuántos archivos cifrados se descifran de verdad cuando no se pide `--todos`. */
const MUESTRA = 25;

const almacenes = almacenesDelEntorno();
if (almacenes.length === 0) {
  console.error(
    '✖ no encontré ninguna carpeta de almacén (ni `STORAGE_DIR` ni `storage/<servicio>`)',
  );
  process.exit(1);
}

let totalEnClaro = 0;
let totalCifrados = 0;
let fallos = 0;
let revisados = 0;

for (const almacen of almacenes) {
  let existe = true;
  try {
    if (!statSync(almacen.dir).isDirectory()) existe = false;
  } catch {
    existe = false;
  }
  if (!existe) {
    console.log(
      `\n${almacen.servicios.join(' + ')}: la carpeta ${almacen.dir} no existe (nada guardado)`,
    );
    continue;
  }

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
    `\n${almacen.servicios.join(' + ')}: ${String(archivos.length)} archivo(s) en ${almacen.dir}` +
      `\n  · ${String(enClaro.length)} en claro · ${String(cifrados.length)} cifrados` +
      (almacen.clave === undefined ? ' · SIN clave de cifrado (STORAGE_ENCRYPTION_KEY)' : ''),
  );

  if (soloEstado) continue;

  if (cifrados.length === 0) {
    console.log('  · nada cifrado que comprobar');
    continue;
  }
  if (almacen.clave === undefined) {
    fallos += 1;
    console.error(
      '  ✖ hay archivos cifrados y no hay STORAGE_ENCRYPTION_KEY: no se pueden leer. ' +
        'Pon la clave con la que se escribieron (la del respaldo).',
    );
    continue;
  }

  const aProbar = todos ? cifrados : cifrados.slice(0, MUESTRA);
  console.log(
    `  · descifrando ${String(aProbar.length)} de ${String(cifrados.length)} cifrado(s)…`,
  );
  for (const archivo of aProbar) {
    revisados += 1;
    try {
      const claro = decryptBlob(readFileSync(join(almacen.dir, archivo)), almacen.clave);
      if (claro.byteLength === 0) throw new Error('el archivo descifrado está vacío');
    } catch (error) {
      fallos += 1;
      const crudo = error instanceof Error ? error.message : String(error);
      // El fallo de GCM llega con el texto del cifrado («unable to authenticate»); traducirlo
      // evita que el operador crea que el archivo está corrupto cuando lo que no cuadra es la clave.
      const motivo = /authenticate|Unsupported state/i.test(crudo)
        ? 'no se descifra con la clave configurada (¿es la misma con la que se guardó?)'
        : crudo;
      console.error(`    ✖ ${archivo}: ${motivo}`);
    }
  }
}

console.log(
  `\nresumen: ${String(totalEnClaro)} en claro · ${String(totalCifrados)} cifrados` +
    (soloEstado
      ? ' (solo lectura)'
      : ` · ${String(revisados)} descifrado(s) · ${String(fallos)} fallo(s)`),
);

if (fallos > 0) {
  console.error(
    '\n✖ el almacén NO se puede leer del todo: los documentos que dependan de esos archivos ' +
      '(récipes, radiografías, facturas) no se abrirán. Revisa STORAGE_ENCRYPTION_KEY.',
  );
  process.exit(1);
}
if (!soloEstado && totalCifrados > 0) {
  console.log('\n✔ los archivos comprobados se descifran con la clave configurada.');
}
process.exit(0);
