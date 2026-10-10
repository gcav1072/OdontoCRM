#!/usr/bin/env node
/**
 * Comprueba que la interfaz **no se rompe en pantallas pequeñas**.
 *
 *   npm run stack:fijo        (o npm run dev)
 *   npm run check:responsive
 *
 * Existe por un caso real: en un portátil de 1366 px y en un iPad, los formularios
 * salían apretados y algún cuadro de texto quedaba **encima** de la etiqueta o del
 * texto de al lado. La causa era que los breakpoints se medían contra la **ventana**
 * y no contra la columna de contenido (que pierde ~16 rem por el menú lateral), así
 * que `lg`/`xl` disparaban antes de tiempo. Este guion vigila las dos reglas que
 * rompían el diseño, en varios anchos y en las pantallas con más casillas:
 *
 *   1. **Sin desbordamiento horizontal**: el documento (y el contenido) no se sale
 *      del ancho de la ventana. Es lo que «descuadraba» la pantalla.
 *   2. **Sin solapes**: ningún bloque de texto (etiqueta, ayuda, columna) queda
 *      encima de un cuadro de entrada, ni dos controles se pisan.
 *
 * Recorre también un **diálogo** por pantalla (los modales son donde más duele, por
 * el teclado virtual) y, si la pila no está en pie, avisa y sale con error.
 *
 * ⚠️ Entra con el `admin` sembrado y, si trae contraseña temporal, la cambia. Al
 * terminar:  npm run seed:users -- --reset
 */
import { connect } from 'node:net';

import { chromium } from 'playwright';

const WEB = process.env['E2E_WEB_URL'] ?? 'http://127.0.0.1:5173';
const GATEWAY = process.env['E2E_GATEWAY_URL'] ?? 'http://127.0.0.1:8090';
const USERNAME = process.env['E2E_USERNAME'] ?? 'admin';
const PASSWORD = process.env['E2E_PASSWORD'] ?? 'admin-odontocrm-2026';
const NEW_PASSWORD = process.env['E2E_NEW_PASSWORD'] ?? 'responsivo-odontocrm-2026';
const ESPERA_MS = Number(process.env['E2E_TIMEOUT_MS'] ?? 25_000);

/** Anchos de referencia: teléfono, iPad en las dos posturas, portátil y escritorio. */
const ANCHOS = [
  { nombre: 'móvil 320', width: 320, height: 720 },
  { nombre: 'iPad vertical 768', width: 768, height: 1024 },
  { nombre: 'iPad apaisado 1024', width: 1024, height: 768 },
  { nombre: 'portátil 1366', width: 1366, height: 768 },
  { nombre: 'escritorio 1920', width: 1920, height: 1080 },
];

let pacienteId = '';
let token = '';

/**
 * Rutas que se auditan, con el nombre del botón que abre su diálogo principal (para
 * revisar también el modal). `scope` es el contenedor a medir: `main` dentro del
 * shell, `#root` en el acceso, que no tiene armazón.
 */
const RUTAS = [
  { path: '/login', scope: '#root' },
  { path: '/inicio' },
  { path: '/mi-perfil' },
  { path: '/registro' },
  { path: '/pacientes' },
  { path: () => `/pacientes/${pacienteId}`, nombre: '/pacientes/:id' },
  { path: '/programacion', dialogo: 'Nueva solicitud' },
  { path: '/notificaciones' },
  { path: '/secretaria' },
  { path: '/flujo' },
  { path: '/caja' },
  { path: '/pantallas', dialogo: 'Nueva pantalla' },
  { path: '/reportes' },
  { path: '/auditoria' },
  { path: '/usuarios', dialogo: 'Nuevo usuario' },
  { path: '/configuracion' },
  {
    path: () => `/consultorio?paciente=${pacienteId}`,
    nombre: '/consultorio',
    dialogo: 'Abrir sesión',
  },
];

let fallos = 0;
let avisos = 0;

const check = (etiqueta, condicion, detalle = '') => {
  if (!condicion) fallos += 1;
  console.log(`${condicion ? '✔' : '✖'} ${etiqueta}${detalle === '' ? '' : ` → ${detalle}`}`);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Petición al gateway con el token de la sesión de preparación. */
const call = async (path, options = {}) => {
  const response = await fetch(`${GATEWAY}${path}`, {
    ...options,
    signal: options.signal ?? AbortSignal.timeout(25_000),
    headers: {
      ...(token === '' ? {} : { authorization: `Bearer ${token}` }),
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.headers ?? {}),
    },
  });
  const texto = await response.text();
  let body;
  try {
    body = JSON.parse(texto);
  } catch {
    body = texto.slice(0, 200);
  }
  return { status: response.status, body };
};

/** ¿Hay alguien escuchando en el puerto de la URL? */
const escucha = async (url) => {
  const objetivo = new URL(url);
  return new Promise((resolve) => {
    const socket = connect({
      port: Number(
        objetivo.port === '' ? (objetivo.protocol === 'https:' ? 443 : 80) : objetivo.port,
      ),
      host: objetivo.hostname,
    });
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
};

/* ── 0) ¿Está la pila en pie? ──────────────────────────────────────────────── */

for (const [nombre, url] of [
  ['la interfaz', WEB],
  ['el gateway', GATEWAY],
]) {
  if (!(await escucha(url))) {
    console.error(
      `check:responsive: no hay nada escuchando en ${url} (${nombre}).\n` +
        '  · Arranca la pila:  npm run stack:fijo   (PM2)\n' +
        '                      npm run dev          (todo en una terminal)\n' +
        '  · Comprueba el modo: npm run stack:status',
    );
    process.exit(1);
  }
}

/* ── 1) Preparar: sesión de admin y un paciente para las rutas con `:id` ────── */

const intentarLogin = (password) =>
  call('/api/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: USERNAME, password }),
  });

let login = await intentarLogin(PASSWORD);
let claveValida = PASSWORD;
if (login.status === 401) {
  login = await intentarLogin(NEW_PASSWORD);
  claveValida = NEW_PASSWORD;
}
if (login.status !== 200) {
  console.error(
    `check:responsive: no se pudo entrar con «${USERNAME}» (status ${String(login.status)}).\n` +
      '  · Revisa E2E_USERNAME/E2E_PASSWORD o siembra:  npm run seed:users -- --reset',
  );
  process.exit(1);
}
token = login.body?.accessToken ?? '';

if (login.body?.user?.mustChangePassword === true) {
  const cambiada = await call('/api/v1/auth/password/change', {
    method: 'POST',
    body: JSON.stringify({
      currentPassword: claveValida,
      newPassword: NEW_PASSWORD,
      repeatPassword: NEW_PASSWORD,
    }),
  });
  if (cambiada.status !== 200) {
    console.error(`check:responsive: no se pudo cambiar la contraseña temporal.`);
    process.exit(1);
  }
  token = cambiada.body?.accessToken ?? token;
  claveValida = NEW_PASSWORD;
}

/** Un paciente cualquiera: el primero de la lista sirve para `/pacientes/:id`. */
const listado = await call('/api/v1/patients?page=1&pageSize=1');
pacienteId = listado.body?.items?.[0]?.id ?? '';
if (pacienteId === '') avisos += 1;

/* ── 2) El navegador ───────────────────────────────────────────────────────── */

let navegador;
try {
  navegador = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
} catch (fallo) {
  console.error(
    `check:responsive: no se pudo abrir Chromium.\n${String(fallo).slice(0, 400)}\n` +
      '  · Instálalo con:  npx playwright install chromium',
  );
  process.exit(1);
}

const contexto = await navegador.newContext({
  baseURL: WEB,
  viewport: { width: 1280, height: 900 },
  locale: 'es-VE',
});
const page = await contexto.newPage();
page.setDefaultTimeout(ESPERA_MS);

/**
 * Auditoría que corre **dentro de la página**: devuelve el desbordamiento y los
 * solapes entre texto y controles. Devuelve datos, no decide: quien compara es Node.
 */
/* eslint-disable no-undef -- esta función se serializa y corre en el navegador
   (`page.evaluate`), así que `document`, `window` y `getComputedStyle` existen allí
   aunque no en Node. */
const auditar = (selector) => {
  const scope = document.querySelector(selector);
  if (scope === null) return { overflow: false, desborde: 0, solapes: [] };

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none' || s.opacity === '0') return false;
    // Las barras fijas (cabecera, panel inferior, menú) flotan sobre el contenido a
    // propósito: no cuentan como solape.
    if (s.position === 'fixed') return false;
    return true;
  };

  const tieneTextoPropio = (el) => {
    for (const nodo of el.childNodes) {
      if (nodo.nodeType === 3 && (nodo.textContent ?? '').trim() !== '') return true;
    }
    return false;
  };

  const TEXTO = 'label,p,span,dt,dd,td,th,li,h1,h2,h3,h4,legend,summary';
  const CONTROL = 'input,select,textarea';

  const descartar = (el) => {
    if (el.closest('svg') !== null) return true;
    if (el.closest('[aria-hidden="true"]') !== null) return true;
    if (String(el.className ?? '').includes('sr-only')) return true;
    // Al medir el contenido no se cuenta lo que vive dentro de un diálogo abierto:
    // eso se mide aparte, con el diálogo como contenedor.
    if (selector === 'main' && el.closest('dialog') !== null) return true;
    return false;
  };

  const textos = [...scope.querySelectorAll(TEXTO)].filter(
    (el) => !descartar(el) && tieneTextoPropio(el) && visible(el),
  );
  const controles = [...scope.querySelectorAll(CONTROL)].filter((el) => {
    if (el.type === 'hidden') return false;
    return !descartar(el) && visible(el);
  });

  const inter = (a, b) => {
    const ancho = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const alto = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    return ancho > 2 && alto > 2;
  };

  const solapes = [];
  for (const texto of textos) {
    const rt = texto.getBoundingClientRect();
    for (const control of controles) {
      if (texto.contains(control) || control.contains(texto)) continue;
      if (!inter(rt, control.getBoundingClientRect())) continue;
      solapes.push(
        `«${(texto.textContent ?? '').trim().slice(0, 34)}» sobre <${control.tagName.toLowerCase()}${
          control.type === '' ? '' : `[${control.type}]`
        }>`,
      );
    }
  }

  const documento = document.documentElement;
  return {
    overflow: documento.scrollWidth - window.innerWidth > 1,
    desborde: Math.max(0, scope.scrollWidth - scope.clientWidth),
    solapes: [...new Set(solapes)].slice(0, 6),
  };
};
/* eslint-enable no-undef */

/** Mide un contenedor y anota las dos reglas. `etiqueta` sitúa el fallo. */
const revisar = async (etiqueta, selector) => {
  const resultado = await page.evaluate(auditar, selector);
  check(
    `${etiqueta}: sin desbordamiento horizontal`,
    !resultado.overflow && resultado.desborde <= 1,
    resultado.overflow ? 'el documento se sale de la ventana' : `desborde ${resultado.desborde}px`,
  );
  check(
    `${etiqueta}: sin solapes texto/control`,
    resultado.solapes.length === 0,
    resultado.solapes.join(' · '),
  );
};

/* ── 3) Entrar por la interfaz ─────────────────────────────────────────────── */

try {
  await page.goto('/login');
  await page.locator('input[autocomplete="username"]').fill(USERNAME);
  await page.locator('input[autocomplete="current-password"]').fill(claveValida);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await page.waitForURL(/\/inicio/);
  check('entra a la interfaz', page.url().includes('/inicio'), page.url());
} catch (fallo) {
  console.error(`check:responsive: falló el acceso.\n${String(fallo).slice(0, 400)}`);
  await navegador.close();
  process.exit(1);
}

/* ── 4) Recorrido por anchos y rutas ───────────────────────────────────────── */

for (const ancho of ANCHOS) {
  await page.setViewportSize({ width: ancho.width, height: ancho.height });
  console.log(`\n── ${ancho.nombre} (${String(ancho.width)}×${String(ancho.height)}) ──`);

  for (const ruta of RUTAS) {
    const destino = typeof ruta.path === 'function' ? ruta.path() : ruta.path;
    const nombre = ruta.nombre ?? destino;
    const scope = ruta.scope ?? 'main';

    try {
      await page.goto(destino);
      await page.locator(scope).first().waitFor();
      // Un respiro corto: las consultas pintan en cuanto resuelven y el diseño
      // definitivo (con datos) es el que hay que medir.
      await sleep(350);
    } catch {
      avisos += 1;
      console.log(`· ${nombre}: no se pudo abrir (se omite)`);
      continue;
    }

    await revisar(`${nombre}`, scope);

    if (typeof ruta.dialogo === 'string') {
      const boton = page.getByRole('button', { name: ruta.dialogo }).first();
      try {
        if ((await boton.count()) === 0) {
          avisos += 1;
          console.log(`· ${nombre}: sin botón «${ruta.dialogo}» (se omite el diálogo)`);
          continue;
        }
        await boton.click();
        const dialogo = page.locator('dialog[open]');
        await dialogo.waitFor();
        await sleep(250);
        await revisar(`${nombre} · diálogo «${ruta.dialogo}»`, 'dialog[open]');
        await page.keyboard.press('Escape');
        await sleep(150);
      } catch {
        avisos += 1;
        console.log(`· ${nombre}: no se pudo abrir «${ruta.dialogo}» (se omite)`);
      }
    }
  }
}

await navegador.close();

/* ── 5) Veredicto ──────────────────────────────────────────────────────────── */

console.log(`\ncheck:responsive: ${String(fallos)} fallo(s), ${String(avisos)} omisión(es).`);
if (fallos > 0) {
  console.error(
    '  · Revisa los dos puntos: que el contenedor de contenido esté marcado con `@container`\n' +
      '    y que los grids usen `minmax(0,1fr)` en vez de `1fr` (un track pelado no encoge).',
  );
}
if (avisos > 0) {
  console.log('  · Recuerda dejar los usuarios sembrados:  npm run seed:users -- --reset');
}
process.exit(fallos > 0 ? 1 : 0);
