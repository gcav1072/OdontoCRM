#!/usr/bin/env node
/**
 * Comprueba que la SPA **monta de verdad** en el navegador: abre la URL con un
 * Chromium sin interfaz, espera a que arranque y verifica que el contenedor
 * `#root` tiene contenido y que la consola no trae errores.
 *
 *   npm run check:web                       → http://127.0.0.1:5173/
 *   npm run check:web -- http://127.0.0.1:4173/
 *
 * Existe por un caso real: el navegador apuntaba a un servidor de Vite de una
 * sesión anterior con el grafo de módulos roto; el `#root` quedaba vacío y la
 * pantalla, en negro, sin ningún mensaje que lo explicara. Ninguna prueba unitaria
 * ni de integración puede ver eso: hay que abrir un navegador.
 *
 * Busca Chromium en `CHROME_PATH` o en la caché de Playwright. Si no lo encuentra,
 * avisa y termina sin error (no es una dependencia del proyecto todavía).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_OBJETIVO = process.argv[2] ?? process.env.WEB_URL ?? 'http://127.0.0.1:5173/';
/** Milisegundos de reloj virtual que se dejan para que arranque la SPA. */
const PRESUPUESTO_MS = Number(process.env.CHECK_WEB_MS ?? 20_000);

/** Lista recursiva de la caché; si la carpeta no se puede leer, no hay nada que buscar. */
const listarArchivos = (raiz) => {
  try {
    return readdirSync(raiz, { recursive: true, withFileTypes: true });
  } catch {
    return [];
  }
};

/** Chromium ya instalado: variable de entorno, caché de Playwright o el sistema. */
const buscarChromium = () => {
  if (process.env.CHROME_PATH !== undefined && existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }

  const cache = [
    join(homedir(), 'AppData', 'Local', 'ms-playwright'),
    join(homedir(), '.cache', 'ms-playwright'),
    join(homedir(), 'Library', 'Caches', 'ms-playwright'),
  ].filter((ruta) => existsSync(ruta));

  // La caché de Playwright guarda cada versión en su carpeta:
  //   chromium_headless_shell-1243/chrome-headless-shell-win64/chrome-headless-shell.exe
  //   chromium-1243/chrome-win64/chrome.exe
  const ejecutables = [
    'chrome-headless-shell.exe',
    'chrome-headless-shell',
    'chrome.exe',
    'chrome',
  ];

  const encontrados = [];
  for (const raiz of cache) {
    for (const entrada of listarArchivos(raiz)) {
      if (entrada.isFile() && ejecutables.includes(entrada.name)) {
        encontrados.push(join(entrada.parentPath ?? raiz, entrada.name));
      }
    }
  }

  // Se prefiere el binario sin interfaz (más rápido y sin dependencias gráficas).
  return encontrados.find((ruta) => ruta.includes('headless-shell')) ?? encontrados[0] ?? null;
};

const chromium = buscarChromium();
if (chromium === null) {
  console.warn(
    'check:web: no hay ningún Chromium disponible; se omite la comprobación.\n' +
      '  · Instálalo con  npx playwright install chromium   (a partir de la Fase 7)\n' +
      '  · O indica el binario en la variable CHROME_PATH',
  );
  process.exit(0);
}

// Antes de abrir nada: ¿hay alguien escuchando? Si no, el diagnóstico es otro.
const objetivo = new URL(URL_OBJETIVO);
const escucha = await new Promise((resolve) => {
  const socket = connect({ port: Number(objetivo.port || '80'), host: objetivo.hostname });
  const terminar = (valor) => {
    socket.removeAllListeners();
    socket.destroy();
    resolve(valor);
  };
  socket.setTimeout(1_500);
  socket.once('connect', () => terminar(true));
  socket.once('timeout', () => terminar(false));
  socket.once('error', () => terminar(false));
});

if (!escucha) {
  console.error(
    `check:web: no hay nada escuchando en ${URL_OBJETIVO}.\n` +
      '  · Arranca la interfaz:  npm run dev        (todo)\n' +
      '                          npm run dev:web    (solo la web, si los servicios están en PM2)',
  );
  process.exit(1);
}

console.log(`check:web: abriendo ${URL_OBJETIVO} con ${chromium}`);

let salida = '';
try {
  salida = execFileSync(
    chromium,
    [
      '--disable-gpu',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      `--user-data-dir=${join(tmpdir(), 'odontocrm-check-web')}`,
      `--virtual-time-budget=${String(PRESUPUESTO_MS)}`,
      '--dump-dom',
      URL_OBJETIVO,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 },
  );
} catch (error) {
  // Chromium escribe la consola del navegador en stderr, así que un error de
  // ejecución puede traer la pista dentro.
  const detalle = error instanceof Error ? error.message : String(error);
  console.error(`check:web: no se pudo abrir el navegador\n${detalle.slice(0, 600)}`);
  process.exit(1);
}

const consola = salida
  .split(/\r?\n/)
  .filter((linea) => linea.includes('CONSOLE') || linea.includes('Uncaught'))
  .map((linea) => linea.trim());
const dom = salida
  .split(/\r?\n/)
  .filter((linea) => !linea.includes('CONSOLE'))
  .join('\n');

const inicio = dom.indexOf('<div id="root"');
const contenido = inicio === -1 ? '' : dom.slice(inicio);
// El aviso de reserva de `index.html` no cuenta como aplicación montada.
const monto =
  contenido.length > 0 && !contenido.includes('id="arranque"') && contenido.length > 200;
const erroresDeConsola = consola.filter((linea) =>
  /Uncaught|Failed to load|ERR_|TypeError|ReferenceError/.test(linea),
);

if (!monto) {
  console.error('\ncheck:web: la aplicación NO montó (el contenedor #root quedó vacío).');
  console.error('  Suele ser un servidor de desarrollo viejo:  npm run dev:stop  y  npm run dev');
  if (consola.length > 0) {
    console.error('\n  Consola del navegador:');
    for (const linea of consola.slice(0, 10)) console.error(`    ${linea}`);
  }
  process.exit(1);
}

if (erroresDeConsola.length > 0) {
  console.error('\ncheck:web: la aplicación montó, pero la consola trae errores:');
  for (const linea of erroresDeConsola.slice(0, 10)) console.error(`  ${linea}`);
  process.exit(1);
}

console.log(
  `check:web: la aplicación montó correctamente (${String(contenido.length)} caracteres en #root) ✔`,
);
for (const linea of consola.slice(0, 5)) console.log(`  · ${linea}`);
