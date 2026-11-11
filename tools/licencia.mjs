#!/usr/bin/env node
/**
 * **CLI del proveedor** para emitir, renovar y verificar licencias offline
 * ([ADR 0075](../../docs/adr/0075-licenciamiento-offline-y-modo-consulta.md)).
 *
 *   npm run licencia -- --ayuda
 *   npm run licencia -- claves --publicar
 *   npm run licencia -- emitir --instalacion <uuid> --cliente "Clínica X" --tipo mensual
 *   npm run licencia -- renovar --instalacion <uuid> --tipo anual
 *   npm run licencia -- pendientes [--dias 30]
 *   npm run licencia -- verificar <archivo.o.lic | token>
 *
 * Corre **solo en la máquina del proveedor**: la clave privada, el token del bot
 * y el registro viven fuera del repo (`tools/lib/licencia-config.mjs`). El
 * consultorio nunca ejecuta esto; su app solo verifica la firma con la clave
 * pública que viaja en `assets/licencias/licencia-publica.pem`.
 *
 * Códigos de salida: 0 = bien, 1 = error de uso o de ejecución.
 */
import { LICENSE_KINDS, LICENSE_KIND_DAYS, LICENSE_REQUEST_PREFIX } from '@odontocrm/contracts';
import { generateKeyPairPem, verifyLicenseToken } from '@odontocrm/kernel';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  asegurarDirectorios,
  existenClaves,
  resumenRutas,
  rutasDeLicencias,
} from './lib/licencia-config.mjs';
import {
  cargarClavePrivada,
  cargarClavePublica,
  emitirLicencia,
  formatearEmision,
  formatearVerificacion,
} from './lib/licencia-emision.mjs';
import {
  formatearPendientes,
  leerRegistro,
  pendientes,
  textoDias,
  ultimaPorInstalacion,
} from './lib/licencia-registro.mjs';

/** Error de uso (argumentos que faltan o sobran): se muestra y sale con 1. */
class ErrorUso extends Error {}

const TIPOS = LICENSE_KINDS.map((tipo) => `${tipo} (${textoDias(LICENSE_KIND_DAYS[tipo])})`).join(
  ' · ',
);

const AYUDA = [
  'OdontoCRM · emisor de licencias offline (máquina del proveedor)',
  '',
  'Uso:',
  '  npm run licencia -- <comando> [opciones]',
  '  node tools/licencia.mjs <comando> [opciones]',
  '',
  'Comandos:',
  '  claves [--force] [--publicar]',
  '      Genera el par Ed25519. La privada se queda fuera del repo (0600);',
  '      --publicar copia la pública a assets/licencias/licencia-publica.pem.',
  '  emitir --instalacion <uuid> --cliente "<nombre>" --tipo <tipo>',
  '         [--rif <rif>] [--desde <ISO>] [--notas "<texto>"]',
  '      Emite la primera licencia de una instalación (si ya tenía, suma días).',
  '  renovar --instalacion <uuid> --tipo <tipo> [--desde <ISO>] [--notas "<texto>"]',
  '      Renueva usando el consultorio de la licencia anterior del registro.',
  '  pendientes [--dias 30]',
  '      Licencias que vencen en los próximos N días (y las ya vencidas).',
  '  verificar <archivo-o-token> [--publica <pem>]',
  '      Comprueba firma, formato y vencimiento de una licencia.',
  '',
  `Tipos: ${TIPOS}`,
  '',
  'Rutas:',
  resumenRutas(),
  '',
  'El código de solicitud que manda el consultorio empieza por: ' + LICENSE_REQUEST_PREFIX,
].join('\n');

/* ── Argumentos ───────────────────────────────────────────────────────────── */

/**
 * Parser mínimo de `--clave valor` / `--clave=valor` / `--bandera`. Devuelve los
 * posicionales (el archivo de `verificar`) y el mapa de opciones.
 */
const parsearArgumentos = (argv) => {
  const posicionales = [];
  const opciones = {};

  for (let indice = 0; indice < argv.length; indice += 1) {
    const argumento = argv[indice];
    if (!argumento.startsWith('--')) {
      posicionales.push(argumento);
      continue;
    }
    const igual = argumento.indexOf('=');
    if (igual !== -1) {
      opciones[argumento.slice(2, igual)] = argumento.slice(igual + 1);
      continue;
    }
    const clave = argumento.slice(2);
    const siguiente = argv[indice + 1];
    if (siguiente === undefined || siguiente.startsWith('--')) {
      opciones[clave] = true;
      continue;
    }
    opciones[clave] = siguiente;
    indice += 1;
  }

  return { posicionales, opciones };
};

/** Falla si hay una opción que el comando no conoce (evita erratas silenciosas). */
const comprobarOpciones = (opciones, permitidas) => {
  const desconocidas = Object.keys(opciones).filter((clave) => !permitidas.includes(clave));
  if (desconocidas.length > 0) {
    throw new ErrorUso(
      `Opción(es) desconocida(s): ${desconocidas.map((clave) => `--${clave}`).join(', ')}.\n` +
        `Opciones válidas: ${permitidas.map((clave) => `--${clave}`).join(', ')}.`,
    );
  }
};

/** Lee una opción obligatoria como texto. */
const exigir = (opciones, clave) => {
  const valor = opciones[clave];
  if (typeof valor !== 'string' || valor.trim() === '') {
    throw new ErrorUso(`Falta --${clave}. Consulta \`npm run licencia -- --ayuda\`.`);
  }
  return valor.trim();
};

/** Lee una opción opcional como texto (o `undefined`). */
const opcional = (opciones, clave) => {
  const valor = opciones[clave];
  return typeof valor === 'string' && valor.trim() !== '' ? valor.trim() : undefined;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const validarInstalacion = (valor) => {
  if (!UUID.test(valor)) {
    throw new ErrorUso(
      `La instalación no es un UUID válido: «${valor}». ` +
        'Es el que muestra el consultorio en /licencia (o en el bot, /licencia).',
    );
  }
  return valor.toLowerCase();
};

const validarTipo = (valor) => {
  if (!Object.hasOwn(LICENSE_KIND_DAYS, valor)) {
    throw new ErrorUso(`Tipo no válido: «${valor}». Usa: ${LICENSE_KINDS.join(' / ')}.`);
  }
  return valor;
};

const avisarLineasInvalidas = (invalidas, ruta) => {
  if (invalidas.length === 0) return;
  console.error(
    `⚠ El registro ${ruta} tiene ${String(invalidas.length)} línea(s) ilegible(s) ` +
      `(líneas ${invalidas.slice(0, 10).join(', ')}${invalidas.length > 10 ? '…' : ''}); ` +
      'se ignoran para esta operación.',
  );
};

/* ── Comandos ─────────────────────────────────────────────────────────────── */

/** Publica la clave pública en el asset que viaja con la app. */
const publicarClavePublica = (rutas) => {
  mkdirSync(dirname(rutas.publicaDelRepo), { recursive: true });
  const anterior = existsSync(rutas.publicaDelRepo)
    ? readFileSync(rutas.publicaDelRepo, 'utf8')
    : null;
  const contenido = readFileSync(rutas.publica, 'utf8');
  writeFileSync(rutas.publicaDelRepo, contenido, { encoding: 'utf8' });

  console.log(`✔ Clave pública publicada en ${rutas.publicaDelRepo}`);
  if (anterior !== null && anterior !== contenido) {
    console.log(
      '  Reemplazó a la anterior: commitéala y despliégala. Las licencias emitidas con la\n' +
        '  clave vieja dejan de verificar; si era una rotación, hay que reemitirlas.',
    );
  }
  console.log('  Commitear el asset y desplegar la app en los consultorios.');
};

const cmdClaves = async (_posicionales, opciones) => {
  comprobarOpciones(opciones, ['force', 'publicar']);
  const rutas = rutasDeLicencias();
  const yaExisten = existenClaves(rutas);

  if (yaExisten && opciones.force !== true) {
    // Volver a publicar la clave que ya existe es inofensivo y útil (clon nuevo
    // del repo, asset perdido); regenerar no: invalida todas las licencias.
    if (opciones.publicar === true && existsSync(rutas.publica)) {
      console.log('Las claves ya existen: no se regeneran; se publica la pública actual.');
      publicarClavePublica(rutas);
      return;
    }
    throw new ErrorUso(
      `Ya existen claves en ${rutas.configDir}.\n` +
        'Si las regeneras, las licencias emitidas con la anterior dejan de verificar y hay que\n' +
        'reemitirlas: usa --force para confirmarlo.',
    );
  }

  asegurarDirectorios(rutas);
  const { privatePem, publicPem } = await generateKeyPairPem();
  writeFileSync(rutas.privada, privatePem, { encoding: 'utf8', mode: 0o600 });
  writeFileSync(rutas.publica, publicPem, { encoding: 'utf8', mode: 0o644 });
  try {
    chmodSync(rutas.privada, 0o600);
    chmodSync(rutas.publica, 0o644);
  } catch {
    // En Windows los permisos POSIX no aplican; el perfil del usuario ya protege.
  }

  const huella = createHash('sha256').update(publicPem).digest('hex').slice(0, 16);
  console.log('✔ Claves generadas');
  console.log(`  privada: ${rutas.privada} (0600; NO se imprime ni se versiona)`);
  console.log(`  pública: ${rutas.publica} (0644)`);
  console.log(`  huella de la clave pública: ${huella}`);

  if (opciones.publicar === true) {
    publicarClavePublica(rutas);
  } else {
    console.log(`  Publícala en la app con:  npm run licencia -- claves --publicar`);
  }
  console.log('\nRespalda la privada aparte: sin ella no se pueden emitir más licencias.');
};

const cmdEmitir = async (posicionales, opciones) => {
  comprobarOpciones(opciones, ['instalacion', 'cliente', 'rif', 'tipo', 'desde', 'notas']);
  if (posicionales.length > 0)
    throw new ErrorUso(`Argumentos inesperados: ${posicionales.join(' ')}.`);

  const instalacion = validarInstalacion(exigir(opciones, 'instalacion'));
  const tipo = validarTipo(exigir(opciones, 'tipo'));
  const cliente = exigir(opciones, 'cliente');
  const rif = opcional(opciones, 'rif');
  const desde = opcional(opciones, 'desde');
  const notas = opcional(opciones, 'notas');

  const rutas = rutasDeLicencias();
  const { entradas, invalidas } = leerRegistro(rutas.registro);
  avisarLineasInvalidas(invalidas, rutas.registro);
  const clavePrivada = await cargarClavePrivada(rutas.privada);

  const resultado = await emitirLicencia({
    tipo,
    instalacion,
    cliente,
    rif,
    desde,
    notas,
    emitidaPor: 'cli',
    entradas,
    clavePrivada,
    rutas,
  });

  console.log(formatearEmision(resultado));
  console.log(`\nEnvíale el archivo .lic al consultorio:\n  ${resultado.archivo}`);
};

const cmdRenovar = async (posicionales, opciones) => {
  comprobarOpciones(opciones, ['instalacion', 'tipo', 'desde', 'notas']);
  if (posicionales.length > 0)
    throw new ErrorUso(`Argumentos inesperados: ${posicionales.join(' ')}.`);

  const instalacion = validarInstalacion(exigir(opciones, 'instalacion'));
  const tipo = validarTipo(exigir(opciones, 'tipo'));
  const desde = opcional(opciones, 'desde');
  const notas = opcional(opciones, 'notas');

  const rutas = rutasDeLicencias();
  const { entradas, invalidas } = leerRegistro(rutas.registro);
  avisarLineasInvalidas(invalidas, rutas.registro);

  const previa = ultimaPorInstalacion(entradas, instalacion);
  if (previa === null) {
    throw new ErrorUso(
      `No hay licencia previa para la instalación ${instalacion} en el registro.\n` +
        'Emite la primera con:  npm run licencia -- emitir --instalacion ' +
        `${instalacion} --cliente "<consultorio>" --tipo ${tipo}`,
    );
  }

  const clavePrivada = await cargarClavePrivada(rutas.privada);
  const resultado = await emitirLicencia({
    tipo,
    instalacion,
    cliente: previa.cliente.nombre,
    rif: previa.cliente.rif,
    desde,
    notas,
    emitidaPor: 'cli',
    entradas,
    clavePrivada,
    rutas,
  });

  console.log(formatearEmision(resultado));
  console.log(`\nEnvíale el archivo .lic al consultorio:\n  ${resultado.archivo}`);
};

const cmdPendientes = async (posicionales, opciones) => {
  comprobarOpciones(opciones, ['dias']);
  if (posicionales.length > 0)
    throw new ErrorUso(`Argumentos inesperados: ${posicionales.join(' ')}.`);

  const crudo = opciones.dias ?? '30';
  const dias = Number(crudo);
  if (!Number.isInteger(dias) || dias < 0) {
    throw new ErrorUso(
      `--dias debe ser un número entero mayor o igual que 0 (recibido: «${String(crudo)}»).`,
    );
  }

  const rutas = rutasDeLicencias();
  const { entradas, invalidas } = leerRegistro(rutas.registro);
  avisarLineasInvalidas(invalidas, rutas.registro);

  const ahora = new Date();
  const filas = pendientes(entradas, { ahora, dias });
  console.log(formatearPendientes(filas, { ahora, dias }));
  if (filas.length > 0) {
    console.log(`\nRenovar una:  npm run licencia -- renovar --instalacion <uuid> --tipo <tipo>`);
  }
};

const cmdVerificar = async (posicionales, opciones) => {
  comprobarOpciones(opciones, ['publica']);
  if (posicionales.length !== 1) {
    throw new ErrorUso('Uso: verificar <archivo.lic | token> [--publica <pem>].');
  }

  const fuente = posicionales[0];
  const token = existsSync(fuente) ? readFileSync(fuente, 'utf8').trim() : fuente.trim();
  if (token === '')
    throw new ErrorUso('No hay ninguna licencia que verificar (archivo vacío o argumento vacío).');

  const rutas = rutasDeLicencias();
  const rutaPublica = opcional(opciones, 'publica') ?? rutas.publica;
  const clavePublica = await cargarClavePublica(rutaPublica);
  const claims = await verifyLicenseToken(token, clavePublica);
  if (claims === null) {
    throw new Error(
      'La licencia NO es válida: firma rota, emisor/audiencia ajenos o formato desconocido.\n' +
        'Comprueba que sea la clave pública correcta (--publica) y que el archivo esté completo.',
    );
  }

  console.log(formatearVerificacion(claims));
  console.log(`  Archivo: ${existsSync(fuente) ? fuente : '(token pegado a mano)'}`);
};

/* ── Punto de entrada ─────────────────────────────────────────────────────── */

const COMANDOS = {
  claves: cmdClaves,
  emitir: cmdEmitir,
  renovar: cmdRenovar,
  pendientes: cmdPendientes,
  verificar: cmdVerificar,
};

const main = async () => {
  const argv = process.argv.slice(2);

  if (argv.includes('--ayuda') || argv.includes('--help') || argv.includes('-h')) {
    console.log(AYUDA);
    return 0;
  }
  if (argv.length === 0) {
    console.log(AYUDA);
    return 1;
  }

  const [comando, ...resto] = argv;
  const { posicionales, opciones } = parsearArgumentos(resto);
  const ejecutar = COMANDOS[comando];
  if (ejecutar === undefined) {
    throw new ErrorUso(
      `Comando desconocido: «${comando}». Consulta \`npm run licencia -- --ayuda\`.`,
    );
  }

  await ejecutar(posicionales, opciones);
  return 0;
};

try {
  process.exitCode = await main();
} catch (fallo) {
  const mensaje = fallo instanceof Error ? fallo.message : String(fallo);
  console.error(`✖ ${mensaje}`);
  process.exitCode = 1;
}
