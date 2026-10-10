#!/usr/bin/env node
/**
 * Prueba de extremo a extremo del **panel de configuración** (ADR 0060).
 *
 *   npm run build && npm run seed:users -- --reset && npm run stack:dev
 *   npm run e2e:config
 *
 * Qué demuestra, sobre la pila real:
 *   1. El admin entra y abre `/configuracion`.
 *   2. El **acento** que guarda en el panel llega al CSS de la interfaz (`--color-primary`).
 *   3. La **marca de los imprimibles** (paleta) que guarda llega a `--brand-primary`: es la
 *      variable que usan el récipe, el dossier, el reporte y la factura.
 *   4. Un **texto del kiosko** se guarda y se sirve a la pantalla.
 *   5. Una **fuente `.woff2`** se sube con su **peso y estilo** y aparece en la marca
 *      (y su `@font-face` sale con el peso elegido) y luego se quita.
 *   6. Se crea un **consultorio (sillón)** y aparece en el catálogo de la agenda.
 *   7. Un **token de Telegram** se guarda y el API lo devuelve **enmascarado** (nunca el
 *      token completo): el secreto no viaja hacia el navegador.
 *   8. Al terminar se deja la configuración **de fábrica** (la base es la de desarrollo).
 *
 * ⚠️ Cambia la contraseña temporal del `admin`. Al terminar:
 *    npm run seed:users -- --reset
 */
import { readFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const WEB = process.env['E2E_WEB_URL'] ?? 'http://127.0.0.1:5173';
const GATEWAY = process.env['E2E_GATEWAY_URL'] ?? 'http://127.0.0.1:8090';
const USERNAME = process.env['E2E_USERNAME'] ?? 'admin';
const PASSWORD = process.env['E2E_PASSWORD'] ?? 'admin-odontocrm-2026';
const NEW_PASSWORD = process.env['E2E_NEW_PASSWORD'] ?? 'config-odontocrm-2026';

const MARCA = 'Sillón E2E';
const TOKEN_PRUEBA = '1234567890:token-simulado-de-la-prueba-de-configuracion';
const ACENTO_ID = 'azul';
const ACENTO_PRIMARIO_CLARO = '#1d4ed8';
const MARCA_PRIMARIO = '#7f1d1d';
const TEXTO_KIOSKO = 'Recepción E2E';
/** Peso que **no** usa ninguna fuente del repositorio (así el alta no pisa la de fábrica). */
const PESO_FUENTE = 500;
/** `.woff2` real del repositorio, para subirlo como si fuera del consultorio. */
const FUENTE_REPO = fileURLToPath(
  new URL('../assets/clinic/fonts/montserrat-latin-400-normal.woff2', import.meta.url),
);

const ESPERA_MS = Number(process.env['E2E_TIMEOUT_MS'] ?? 25_000);

let failures = 0;
let token = '';
let clave = PASSWORD;

const check = (label, condition, detail = '') => {
  if (!condition) failures += 1;
  console.log(`${condition ? '✔' : '✖'} ${label}${detail === '' ? '' : ` → ${detail}`}`);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Petición por el gateway con el token de la prueba. */
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
  return { status: response.status, body, texto };
};

/** Sube una fuente `.woff2` como multipart (el navegador pondría el `boundary`). */
const subirFuente = async (ruta, { family, weight, style }) => {
  const data = await readFile(ruta);
  const form = new FormData();
  form.append('family', family);
  form.append('weight', String(weight));
  form.append('style', style);
  form.append(
    'file',
    new Blob([data], { type: 'font/woff2' }),
    'montserrat-latin-400-normal.woff2',
  );
  const response = await fetch(`${GATEWAY}/api/v1/settings/brand/fonts`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
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
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
};

const esperarPila = async () => {
  for (let intento = 0; intento < 60; intento += 1) {
    if ((await escucha(GATEWAY)) && (await escucha(WEB))) return true;
    await sleep(500);
  }
  return false;
};

if (!(await esperarPila())) {
  console.error(
    `e2e:config: la pila no responde.\n  · Arranca el gateway (${GATEWAY}) y la web (${WEB}) con "npm run stack:dev".`,
  );
  process.exit(1);
}

/* ── 1) Entrar por el API ──────────────────────────────────────────────────── */

const entrar = async () => {
  const login = await call('/api/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: USERNAME, password: clave }),
  });
  if (login.status === 401 && login.body?.detail && /bloquead|intentos/i.test(login.body.detail)) {
    throw new Error('La cuenta está bloqueada: ejecuta "npm run seed:users -- --reset"');
  }
  if (login.status !== 200) {
    throw new Error(`No se pudo entrar (${login.status}): ${JSON.stringify(login.body)}`);
  }
  token = login.body.accessToken;

  // Contraseña temporal: hay que cambiarla antes de que el servidor deje usar nada
  // (el aviso vive en `user.mustChangePassword`, no en la raíz de la respuesta).
  if (login.body.user?.mustChangePassword === true) {
    const cambio = await call('/api/v1/auth/password/change', {
      method: 'POST',
      body: JSON.stringify({
        currentPassword: clave,
        newPassword: NEW_PASSWORD,
        repeatPassword: NEW_PASSWORD,
      }),
    });
    if (cambio.status !== 200) {
      throw new Error(`No se pudo cambiar la contraseña temporal (${cambio.status})`);
    }
    token = cambio.body.accessToken;
    clave = NEW_PASSWORD;
  }
};

try {
  await entrar();
} catch (fallo) {
  console.error(`e2e:config: ${fallo instanceof Error ? fallo.message : String(fallo)}`);
  process.exit(1);
}
check('el admin entra por el API', token !== '');

/* ── 2) La configuración por el API ────────────────────────────────────────── */

const settings = async () => (await call('/api/v1/settings')).body;
const inicial = await settings();
check('el API de configuración responde', inicial?.themeCss !== undefined);

const defaults = inicial.defaults;

const guardarApp = await call('/api/v1/settings/app', {
  method: 'PUT',
  body: JSON.stringify({
    accent: ACENTO_ID,
    screenTexts: { 'pantalla.lobby.titulo': TEXTO_KIOSKO },
  }),
});
check(
  'guarda el acento y el texto del kiosko',
  guardarApp.status === 200,
  `status ${guardarApp.status}`,
);

const trasApp = await settings();
check(
  'el acento queda guardado',
  trasApp?.accentEffective === ACENTO_ID,
  String(trasApp?.accentEffective),
);
check(
  'el texto del kiosko queda guardado',
  trasApp?.screenTexts?.['pantalla.lobby.titulo'] === TEXTO_KIOSKO,
);

const guardarMarca = await call('/api/v1/settings/brand', {
  method: 'PUT',
  body: JSON.stringify({
    ...defaults.brand,
    palette: { ...defaults.brand.palette, primary: MARCA_PRIMARIO },
  }),
});
check(
  'guarda la marca de los imprimibles',
  guardarMarca.status === 200,
  `status ${guardarMarca.status}`,
);

const trasMarca = await settings();
check(
  'la marca queda aplicada al CSS',
  String(trasMarca?.themeCss).includes(`--brand-primary: ${MARCA_PRIMARIO};`),
);

/* Fuente subida con familia, peso y estilo elegidos: se comprueba que entra en la marca,
   que el `@font-face` sale con ese peso y que quitarla la devuelve a como estaba. La
   familia es una del catálogo (Montserrat), que las pilas ya referencian, así que su
   `@font-face` se resuelve en el `themeCss`. */
const subida = await subirFuente(FUENTE_REPO, {
  family: 'Montserrat',
  weight: PESO_FUENTE,
  style: 'normal',
});
check('sube una fuente .woff2', subida.status === 200, `status ${subida.status}`);
/** Todos los archivos de todas las familias (la marca ya no es una sola familia). */
const archivosFuente = (marca) =>
  (marca?.fonts?.families ?? []).flatMap((familia) => familia.files ?? []);
check(
  'la fuente aparece en la marca como subida',
  archivosFuente(subida.body).some(
    (file) => file.weight === PESO_FUENTE && file.source === 'subido',
  ),
);

const trasFuente = await settings();
check(
  'el @font-face de la fuente subida sale con su peso',
  String(trasFuente?.themeCss).includes(`font-weight: ${String(PESO_FUENTE)}`),
);

const rutaSubida = archivosFuente(trasFuente?.brand).find(
  (file) => file.weight === PESO_FUENTE && file.source === 'subido',
)?.path;
if (typeof rutaSubida === 'string') {
  const quitada = await call(
    `/api/v1/settings/brand/fonts?path=${encodeURIComponent(rutaSubida)}`,
    { method: 'DELETE' },
  );
  check('quita la fuente subida', quitada.status === 200, `status ${quitada.status}`);
  check(
    'la fuente subida deja de estar en la marca',
    archivosFuente(quitada.body).some((file) => file.weight === PESO_FUENTE) === false,
  );
} else {
  check('la fuente subida tiene ruta para quitarla', false);
}

const sillonesAntes = (await call('/api/v1/agenda/chairs?todos=true')).body;
const yaExiste = (sillonesAntes?.items ?? []).some((sillon) => sillon.label === MARCA);
let sillonId = (sillonesAntes?.items ?? []).find((sillon) => sillon.label === MARCA)?.id;
if (!yaExiste) {
  const creado = await call('/api/v1/agenda/chairs', {
    method: 'POST',
    body: JSON.stringify({ label: MARCA, shortLabel: null, isActive: true, sortOrder: 99 }),
  });
  check('crea un consultorio (sillón)', creado.status === 201, `status ${creado.status}`);
  sillonId = creado.body?.id;
}
const sillones = (await call('/api/v1/agenda/chairs?todos=true')).body;
check(
  'el consultorio aparece en el catálogo de la agenda',
  (sillones?.items ?? []).some((sillon) => sillon.label === MARCA),
);

const guardarCanales = await call('/api/v1/settings/channels', {
  method: 'PUT',
  body: JSON.stringify({ telegramBotToken: TOKEN_PRUEBA, telegramBotUsername: 'bot_e2e' }),
});
check(
  'guarda el token de Telegram',
  guardarCanales.status === 200,
  `status ${guardarCanales.status}`,
);

const trasCanales = await settings();
check('el token queda configurado', trasCanales?.channels?.telegramBotToken?.configured === true);
check(
  'el token NO viaja completo al navegador',
  JSON.stringify(trasCanales).includes(TOKEN_PRUEBA) === false,
);
check(
  'la vista solo enseña la pista enmascarada',
  typeof trasCanales?.channels?.telegramBotToken?.preview === 'string' &&
    trasCanales.channels.telegramBotToken.preview.startsWith('…'),
);

/* ── 3) El navegador ───────────────────────────────────────────────────────── */

let navegador;
try {
  navegador = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
} catch (fallo) {
  console.error(
    `e2e:config: no se pudo abrir Chromium.\n${String(fallo).slice(0, 400)}\n` +
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

const erroresConsola = [];
page.on('pageerror', (error) => erroresConsola.push(String(error).slice(0, 200)));

try {
  await page.goto('/login');
  await page.locator('input[autocomplete="username"]').fill(USERNAME);
  await page.locator('input[autocomplete="current-password"]').fill(clave);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await page.waitForURL(/\/inicio/);
  check('el admin entra a la interfaz', page.url().includes('/inicio'), page.url());

  await page.goto('/configuracion');
  const principal = page.locator('main');
  await principal.getByRole('heading', { name: 'Configuración de la aplicación' }).waitFor();
  check('el panel de configuración se abre', true);

  // El acento y la marca se inyectan en `<html>` **cuando llega** la configuración (la
  // consulta se resuelve después de montar): se espera a que el CSS los refleje en vez
  // de leer a carrera.
  await page.waitForFunction(
    (esperado) =>
      getComputedStyle(document.documentElement)
        .getPropertyValue('--brand-primary')
        .trim()
        .toLowerCase() === esperado,
    MARCA_PRIMARIO,
  );
  await page.waitForFunction(
    (esperado) =>
      getComputedStyle(document.documentElement)
        .getPropertyValue('--color-primary')
        .trim()
        .toLowerCase() === esperado,
    ACENTO_PRIMARIO_CLARO,
  );

  const colores = await page.evaluate(() => {
    const estilos = getComputedStyle(document.documentElement);
    return {
      acento: estilos.getPropertyValue('--color-primary').trim(),
      marca: estilos.getPropertyValue('--brand-primary').trim(),
    };
  });
  check(
    'el acento del panel llega al CSS de la interfaz',
    colores.acento.toLowerCase() === ACENTO_PRIMARIO_CLARO,
    colores.acento,
  );
  check(
    'la marca del panel llega al CSS de los imprimibles',
    colores.marca.toLowerCase() === MARCA_PRIMARIO,
    colores.marca,
  );
} finally {
  await navegador.close();
}

check(
  'la consola del navegador no queda con errores',
  erroresConsola.length === 0,
  erroresConsola[0] ?? '',
);

/* ── 4) Dejar la configuración de fábrica ──────────────────────────────────── */

await call('/api/v1/settings/brand', {
  method: 'PUT',
  body: JSON.stringify(defaults.brand),
});
await call('/api/v1/settings/app', {
  method: 'PUT',
  body: JSON.stringify({ accent: null, screenTexts: {} }),
});
await call('/api/v1/settings/channels', {
  method: 'PUT',
  body: JSON.stringify({
    telegramBotToken: '',
    telegramBotUsername: '',
    adminTelegramBotToken: '',
    adminTelegramChatId: '',
    whatsappToken: '',
    whatsappPhoneId: '',
    whatsappVerifyToken: '',
    whatsappAppSecret: '',
  }),
});
if (typeof sillonId === 'string') {
  await call(`/api/v1/agenda/chairs/${sillonId}`, {
    method: 'PATCH',
    body: JSON.stringify({ isActive: false }),
  });
}

const final = await settings();
check('la configuración queda de fábrica', final?.accent === null);

console.log(
  failures === 0
    ? '\ne2e:config OK (aconsejable: npm run seed:users -- --reset)'
    : `\ne2e:config: ${String(failures)} comprobación(es) fallaron`,
);
process.exit(failures === 0 ? 0 : 1);
