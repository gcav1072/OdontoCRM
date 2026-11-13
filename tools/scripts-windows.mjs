#!/usr/bin/env node
/**
 * **Verificador de los guiones de Windows** (`npm run windows:check`).
 *
 * Existe por un fallo real: `infra/windows/odontocrm.ps1` se guardó como UTF-8
 * **sin BOM** y en la PC del consultorio `odontocrm` dejó de arrancar con
 * `MissingEndCurlyBrace`. Windows PowerShell 5.1 (la que trae Windows, no la
 * `pwsh` moderna) lee un `.ps1` sin BOM con la página de códigos ANSI del sistema:
 * los acentos y las flechas del texto se convierten en bytes que el tokenizador
 * interpreta como comillas tipográficas y el parser se descoloca. Con BOM no pasa.
 *
 * La regla ya estaba escrita en `infra/windows/DESARROLLO.md` §7; lo que faltaba era
 * una comprobación que la hiciera cumplir. Esta es:
 *
 * 1. Todo `*.ps1` empieza con BOM UTF-8 y, quitándolo, es UTF-8 válido.
 * 2. Todo `*.cmd` / `*.bat` es ASCII puro y sin BOM (`cmd.exe` los lee con la página
 *    OEM de la consola; un acento ahí es basura y un BOM puede confundir al primer
 *    comando).
 *
 * Sin tocar el sistema: solo lee los archivos del repositorio. Corre dentro de
 * `npm run verify`, así que un guion nuevo con la codificación mal se detecta antes
 * de instalarlo en una PC.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BOM_UTF8 = [0xef, 0xbb, 0xbf];
const DIRECTORIO = 'infra/windows';

const tieneBom = (bytes) =>
  bytes.length >= 3 &&
  bytes[0] === BOM_UTF8[0] &&
  bytes[1] === BOM_UTF8[1] &&
  bytes[2] === BOM_UTF8[2];

/** Texto del guion (sin el BOM) para revisar patrones que no son de codificación. */
const textoDeGuion = (bytes) => (tieneBom(bytes) ? bytes.subarray(3) : bytes).toString('utf8');

/**
 * Problemas de un `.ps1`: el BOM es obligatorio y el contenido tiene que ser UTF-8
 * válido (un archivo doblemente codificado también rompe la salida aunque lleve BOM).
 */
export const problemasDeGuionPs1 = (ruta, bytes) => {
  const problemas = [];
  if (!tieneBom(bytes)) {
    problemas.push(
      `${ruta}: no empieza con BOM UTF-8. Windows PowerShell 5.1 lo leerá como ANSI y el parser se romperá (fue el fallo de «odontocrm» de 2026-11).`,
    );
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(tieneBom(bytes) ? bytes.subarray(3) : bytes);
  } catch {
    problemas.push(
      `${ruta}: el contenido no es UTF-8 válido (¿se guardó dos veces con otra codificación?).`,
    );
  }
  return problemas;
};

/** Problemas de un `.cmd`/`.bat`: ASCII puro y sin BOM. */
export const problemasDeGuionCmd = (ruta, bytes) => {
  const problemas = [];
  if (tieneBom(bytes)) {
    problemas.push(`${ruta}: tiene BOM; un .cmd/.bat no debe llevarlo.`);
  }
  if (bytes.some((byte) => byte > 0x7f)) {
    problemas.push(
      `${ruta}: tiene bytes no ASCII. cmd.exe lo lee con la página OEM de la consola: los acentos salen como basura; escribe los comentarios en ASCII.`,
    );
  }
  return problemas;
};

/** Archivos del directorio de Windows, incluidos los todavía sin confirmar en git. */
const listarGuiones = () => {
  const listar = (args) =>
    execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  const todos = [
    ...listar(['ls-files', DIRECTORIO]),
    ...listar(['ls-files', '--others', '--exclude-standard', DIRECTORIO]),
  ];
  return todos
    .filter((ruta) => /\.(ps1|cmd|bat)$/i.test(ruta))
    .filter((ruta) => existsSync(join(ROOT, ruta)));
};

/**
 * Fallos de **argumentos** que ya han roto la consola y no queremos repetir:
 *
 * 1. `$args[1..N]` devuelve un **escalar** cuando queda un solo argumento; si luego se
 *    splatea con `@Resto`, PowerShell manda cada carácter como argumento y el hijo
 *    muere con `PSArgumentException` («argumento 'name' no es válido»). Pasó con
 *    `odontocrm restaurar --list` el 2026-11-13. Se usa `@($args | Select-Object -Skip 1)`.
 * 2. Leer una opción comparando a mano `-like '--opcion=*'` se deja fuera la forma
 *    documentada con espacio (`--opcion valor`) y la de un solo guion. Para eso están
 *    `Get-Argumento` y `Test-Bandera` de `comun.ps1`.
 */
const PATRONES_DE_ARGUMENTOS = [
  {
    patron: /\$args\[\s*1\s*\.\./,
    mensaje:
      '`$args[1..N]` devuelve un ESCALAR cuando queda un solo argumento y `@Resto` manda cada carácter. Usa `@($args | Select-Object -Skip 1)`.',
  },
  {
    patron: /-like\s+'--[A-Za-z0-9-]+=\*'/,
    mensaje:
      "no leas opciones con `-like '--x=*'`: usa `Get-Argumento`/`Test-Bandera` (aceptan `--x=v`, `--x v`, `-x v` y `-x`).",
  },
];

/** Problemas de argumentos de un `.ps1` (recibe el texto ya decodificado). */
export const problemasDeArgumentos = (ruta, texto) =>
  PATRONES_DE_ARGUMENTOS.filter(({ patron }) => patron.test(texto)).map(
    ({ mensaje }) => `${ruta}: ${mensaje}`,
  );

/** Revisa la lista de rutas (relativas al repositorio) y devuelve los problemas. */
export const verificarGuionesWindows = (rutas) => {
  const problemas = [];
  for (const ruta of rutas) {
    const bytes = readFileSync(join(ROOT, ruta));
    if (/\.ps1$/i.test(ruta)) {
      problemas.push(...problemasDeGuionPs1(ruta, bytes));
      problemas.push(...problemasDeArgumentos(ruta, textoDeGuion(bytes)));
    } else {
      problemas.push(...problemasDeGuionCmd(ruta, bytes));
    }
  }
  return problemas;
};

const main = () => {
  const rutas = listarGuiones();
  const problemas = verificarGuionesWindows(rutas);

  if (problemas.length > 0) {
    console.error('Guiones de Windows con problemas:');
    for (const problema of problemas) console.error(`  - ${problema}`);
    console.error('');
    console.error('Reglas (infra/windows/DESARROLLO.md §7): los .ps1 van en UTF-8 CON BOM,');
    console.error(
      'los .cmd/.bat en ASCII puro, y las opciones se leen con los helpers de comun.ps1.',
    );
    process.exit(1);
  }

  console.log(
    `Guiones de Windows revisados: ${rutas.length} (UTF-8 con BOM / ASCII puro / argumentos con helpers) ✔`,
  );
};

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
