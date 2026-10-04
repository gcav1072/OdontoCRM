#!/usr/bin/env node
/**
 * Prueba de extremo a extremo de la **Fase 8** en un navegador de verdad: la
 * odontóloga lleva el día completo desde `/flujo`, sin salir de la pantalla.
 *
 *   npm run stack:fijo        (o npm run dev)
 *   npm run e2e:flujo
 *
 * Qué demuestra, con Chromium y sobre la pila real:
 *   1. La doctora entra con su usuario (`odontologo`) y abre `/flujo`.
 *   2. El paciente de la cita aparece en la cola del día y, al pulsar su fila, su
 *      expediente se abre en el centro de la misma pantalla.
 *   3. Registra la llegada, **llama con `F4`** (el llamado que sale en la pantalla
 *      del lobby), lo pasa a consulta y escribe la sesión del día.
 *   4. **`F8`** cierra la sesión con la pregunta del récipe, y la cita se marca
 *      atendida desde la barra superior.
 *   5. La URL nunca deja de ser `/flujo`, y `/secretaria` y `/consultorio` siguen
 *      funcionando (no hay regresión en las rutas individuales).
 *   6. La misma pantalla se ve y se maneja en tamaño tableta (vertical).
 *
 * Todo el trabajo previo (paciente, solicitud y cita) lo hace la propia doctora por
 * la API: es la prueba de que el rol `odontologo` puede escribir el flujo del día
 * (decisión de la Fase 8) y no solo mirarlo.
 *
 * ⚠️ Cambia la contraseña temporal del odontólogo sembrado. Al terminar:
 *    npm run seed:users -- --reset
 */
import { connect } from 'node:net';

import { chromium } from 'playwright';

const WEB = process.env['E2E_WEB_URL'] ?? 'http://127.0.0.1:5173';
const GATEWAY = process.env['E2E_GATEWAY_URL'] ?? 'http://127.0.0.1:8090';
const USERNAME = process.env['E2E_USERNAME'] ?? 'egomez';
const PASSWORD = process.env['E2E_PASSWORD'] ?? 'consultorio-odontocrm-2026';
const NEW_PASSWORD = process.env['E2E_NEW_PASSWORD'] ?? 'flujo-odontocrm-2026';
const MARK = 'PRUEBA E2E FLUJO';
/** Milisegundos que se esperan a que la interfaz reaccione. */
const ESPERA_MS = Number(process.env['E2E_TIMEOUT_MS'] ?? 25_000);

let failures = 0;
let token = '';

const check = (label, condition, detail = '') => {
  if (!condition) failures += 1;
  console.log(`${condition ? '✔' : '✖'} ${label}${detail === '' ? '' : ` → ${detail}`}`);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Petición por el gateway, con token opcional (la usuaria normal de la prueba). */
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
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text.slice(0, 200);
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
      `e2e:flujo: no hay nada escuchando en ${url} (${nombre}).\n` +
        '  · Arranca la pila:  npm run stack:fijo   (PM2)\n' +
        '                      npm run dev          (todo en una terminal)\n' +
        '  · Comprueba el modo: npm run stack:status',
    );
    process.exit(1);
  }
}

/* ── 1) Entrar como la doctora (por la API, para preparar el día) ──────────── */

const intentarLogin = (password) =>
  call('/api/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: USERNAME, password }),
  });

let login = await intentarLogin(PASSWORD);
/** Contraseña con la que entra hoy: la temporal o la que dejó una corrida previa. */
let claveValida = PASSWORD;
if (login.status === 401) {
  login = await intentarLogin(NEW_PASSWORD);
  claveValida = NEW_PASSWORD;
}
check(
  `la odontóloga ${USERNAME} entra por la API`,
  login.status === 200,
  `status ${login.status}${login.status === 200 ? '' : ' · npm run seed:users -- --reset'}`,
);
if (login.status !== 200) process.exit(1);
token = login.body?.accessToken ?? '';

check(
  'su rol es `odontologo` y escribe la agenda del día (decisión de la fase 8)',
  Array.isArray(login.body?.user?.roles) &&
    login.body.user.roles.includes('odontologo') &&
    Array.isArray(login.body?.user?.permissions) &&
    login.body.user.permissions.includes('scheduling:write'),
  `roles ${String(login.body?.user?.roles?.join(',') ?? '')}`,
);

if (login.body?.user?.mustChangePassword === true) {
  const cambiada = await call('/api/v1/auth/password/change', {
    method: 'POST',
    body: JSON.stringify({
      currentPassword: claveValida,
      newPassword: NEW_PASSWORD,
      repeatPassword: NEW_PASSWORD,
    }),
  });
  check('cambia la contraseña temporal', cambiada.status === 200, `status ${cambiada.status}`);
  token = cambiada.body?.accessToken ?? token;
  claveValida = NEW_PASSWORD;
  if (cambiada.status !== 200) process.exit(1);
}

/* ── 2) El día de hoy: paciente, solicitud y cita ──────────────────────────── */

/** Hoy en la zona del consultorio (UTC−4), con la hora local para elegir franja. */
const ahoraCaracas = new Date(Date.now() - 4 * 3_600_000);
const hoy = ahoraCaracas.toISOString().slice(0, 10);
const minutosAhora = ahoraCaracas.getUTCHours() * 60 + ahoraCaracas.getUTCMinutes();

const aMinutos = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const enHora = (minutos) =>
  `${String(Math.floor(minutos / 60)).padStart(2, '0')}:${String(minutos % 60).padStart(2, '0')}`;

/** Cédula ficticia distinta en cada corrida (rango reservado 90.000.000+). */
const DOC = `90${String(Date.now()).slice(-6)}`;

const buscado = await call(`/api/v1/patients/lookup?document=V-${DOC}`);
let patientId = buscado.body?.patient?.id;
if (typeof patientId !== 'string') {
  const creado = await call('/api/v1/patients', {
    method: 'POST',
    body: JSON.stringify({
      docType: 'V',
      docNumber: DOC,
      fullName: `PACIENTE ${MARK}`,
      birthDate: '1990-05-17',
      sex: 'F',
      phone: '0414-0000000',
      address: 'Dirección de la prueba de flujo',
      notes: null,
    }),
  });
  check(
    'la doctora registra al paciente de la prueba',
    creado.status === 201,
    `status ${creado.status}`,
  );
  patientId = creado.body?.id;
}
check('paciente de prueba disponible', typeof patientId === 'string', patientId);
if (typeof patientId !== 'string') process.exit(1);

const solicitud = await call('/api/v1/requests', {
  method: 'POST',
  body: JSON.stringify({
    patientId,
    patientName: `PACIENTE ${MARK}`,
    patientDocument: `V-${DOC}`,
    patientPhone: '0414-0000000',
    channel: 'presencial',
    reason: `${MARK}: control`,
    notes: MARK,
  }),
});
check('la solicitud nace con su ticket', solicitud.status === 201, `status ${solicitud.status}`);

/** Hora libre de hoy: las corridas anteriores dejan sus citas en la jornada. */
const citasDeHoy = await call(`/api/v1/appointments?date=${hoy}&pageSize=200`);
const ocupadas = citasDeHoy.body?.items ?? [];
const libre = (minuto) =>
  !ocupadas.some(
    (cita) => aMinutos(cita.startTime) < minuto + 30 && aMinutos(cita.endTime) > minuto,
  );

let hora = null;
for (let minuto = Math.max(0, minutosAhora) + 30; minuto <= 19 * 60; minuto += 30) {
  if (libre(minuto)) {
    hora = enHora(minuto);
    break;
  }
}
for (let minuto = 7 * 60; hora === null && minuto <= 19 * 60; minuto += 30) {
  if (libre(minuto)) hora = enHora(minuto);
}
check('hay una hora libre hoy para la cita', hora !== null, String(hora));
if (hora === null) process.exit(1);

/** El cupo del día puede estar lleno: lo amplía la propia doctora. */
const jornada = await call(`/api/v1/agenda/days/${hoy}`);
const cupo = jornada.body?.capacity;
if (
  typeof cupo?.assigned === 'number' &&
  typeof cupo?.capacity === 'number' &&
  cupo.assigned + 1 > cupo.capacity
) {
  const ampliado = await call('/api/v1/agenda/capacity', {
    method: 'PUT',
    body: JSON.stringify({ date: hoy, capacity: cupo.assigned + 2, reason: MARK }),
  });
  check('la doctora amplía el cupo del día', ampliado.status === 200, `status ${ampliado.status}`);
}

const cita = await call('/api/v1/appointments', {
  method: 'POST',
  body: JSON.stringify({
    requestId: solicitud.body?.id,
    date: hoy,
    startTime: hora,
    slotKind: 'manual',
    durationMinutes: 30,
    notes: MARK,
  }),
});
check(
  'la doctora formaliza la cita del día',
  cita.status === 201,
  `status ${cita.status} · ${hora}`,
);
const appointmentId = cita.body?.id;
if (typeof appointmentId !== 'string') process.exit(1);

const nombrePaciente = `PACIENTE ${MARK}`;

/** Estado de la cita según el servidor: es lo que la interfaz tiene que reflejar. */
const estadoCita = async () => (await call(`/api/v1/appointments/${appointmentId}`)).body?.status;

const esperarEstado = async (esperado) => {
  for (let intento = 0; intento < 40; intento += 1) {
    if ((await estadoCita()) === esperado) return true;
    await sleep(250);
  }
  return false;
};

/* ── 3) El navegador ───────────────────────────────────────────────────────── */

let navegador;
try {
  navegador = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
} catch (fallo) {
  console.error(
    `e2e:flujo: no se pudo abrir Chromium.\n${String(fallo).slice(0, 400)}\n` +
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
 * El área de contenido. La cabecera del shell repite el nombre del módulo, así que
 * las comprobaciones de títulos se hacen dentro de `main` para no ser ambiguas.
 */
const principal = page.locator('main');

/** Errores de la consola del navegador: la pantalla no puede ir sucia. */
const erroresConsola = [];
page.on('console', (mensaje) => {
  if (mensaje.type() === 'error') erroresConsola.push(mensaje.text().slice(0, 200));
});
page.on('pageerror', (error) => erroresConsola.push(String(error).slice(0, 200)));

/** Respuestas con error: cuando algo falla, aquí está el porqué sin adivinar. */
const respuestasFallidas = [];
/** Paso en curso: sitúa cada respuesta con error dentro de la prueba. */
let paso = 'preparación';
page.on('response', (respuesta) => {
  if (respuesta.status() < 400) return;
  const metodo = respuesta.request().method();
  const ruta = new URL(respuesta.url()).pathname;
  respuestasFallidas.push(`${String(respuesta.status())} ${metodo} ${ruta} (${paso})`);
});

const rutas = new Set();
/** Guarda la ruta actual: la prueba comprueba al final que nunca se salió de `/flujo`. */
const recordarRuta = () => rutas.add(new URL(page.url()).pathname);

try {
  /* 3.1 Entrar por la interfaz. */
  paso = 'login';
  await page.goto('/login');
  await page.locator('input[autocomplete="username"]').fill(USERNAME);
  await page.locator('input[autocomplete="current-password"]').fill(claveValida);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await page.waitForURL(/\/inicio/);
  check('la doctora entra a la interfaz', page.url().includes('/inicio'), page.url());
  recordarRuta();
  // El arranque en frío no trae cookie, así que el intento de restaurar la sesión
  // responde 401: es el camino normal de «visita nueva» y no un fallo de la pantalla.
  // A partir de aquí la sesión está abierta y nada puede quedar en error.
  respuestasFallidas.length = 0;
  erroresConsola.length = 0;

  /* 3.2 `/flujo`: la cola del día y el paciente en curso. */
  paso = 'cola del día';
  await page.goto('/flujo');
  await principal.getByRole('heading', { name: 'Flujo del día' }).waitFor();
  // Desde aquí la prueba vigila que no se salga de la pantalla unificada.
  rutas.clear();
  recordarRuta();
  check(
    'el módulo «Flujo del día» está en el menú',
    await page.getByRole('link', { name: 'Flujo del día' }).first().isVisible(),
  );

  const cola = page.getByRole('list', { name: 'Cola del día' });
  await cola.waitFor();
  await page.getByRole('searchbox', { name: 'Buscar paciente' }).fill(DOC);
  const fila = cola.getByRole('button', { name: new RegExp(DOC) });
  await fila.waitFor();
  check('la cita del día aparece en la cola', await fila.isVisible());

  // El botón del lobby solo aparece si la cita admite el llamado ahora mismo; se
  // registra la llegada desde la barra superior.
  await page.getByRole('button', { name: `Registrar llegada: ${nombrePaciente}` }).click();
  check(
    'la llegada se registra desde la barra superior',
    await esperarEstado('en_sala_espera'),
    String(await estadoCita()),
  );
  recordarRuta();

  /* 3.3 `F4` llama al paciente: sale en la pantalla del lobby. */
  await page.keyboard.press('F4');
  check(
    'el atajo F4 llama al paciente (aviso al lobby)',
    await esperarEstado('llamado'),
    String(await estadoCita()),
  );
  recordarRuta();

  await page.getByRole('button', { name: `Pasar a consulta: ${nombrePaciente}` }).click();
  check(
    'pasa a consulta desde la misma pantalla',
    await esperarEstado('en_consulta'),
    String(await estadoCita()),
  );
  recordarRuta();

  /* 3.4 El expediente se abre en el centro, sin cambiar de ruta. */
  paso = 'expediente';
  await fila.click();
  await page.getByRole('tab', { name: /Sesión clínica/ }).waitFor();
  check(
    'el expediente del paciente se abre en el centro de `/flujo`',
    await page.getByText(nombrePaciente).first().isVisible(),
  );

  /* 3.5 La sesión del día: se abre, se escribe y `F8` la cierra. */
  paso = 'sesión del día';
  await page.getByRole('button', { name: 'Abrir sesión' }).click();
  const motivo = page.getByPlaceholder('Qué trae hoy al paciente');
  await motivo.waitFor();
  await motivo.fill('Control de la prueba de flujo: sin dolor, se revisa la obturación.');
  check('la sesión del día se abre desde la pestaña', await motivo.isVisible());

  await page.keyboard.press('F8');
  const dialogoCierre = page.getByRole('dialog');
  await dialogoCierre.waitFor();
  check(
    'F8 abre el cierre de la sesión con la pregunta del récipe',
    (await dialogoCierre.innerText()).includes('¿Desea guardar el récipe?'),
  );
  await dialogoCierre.getByRole('button', { name: 'Cerrar la sesión' }).click();

  const sesionesCerradas = await (async () => {
    for (let intento = 0; intento < 40; intento += 1) {
      const lista = await call(`/api/v1/clinical/patients/${patientId}/sessions`);
      const cerrada = (lista.body?.items ?? []).find((sesion) => sesion.status === 'cerrada');
      if (cerrada !== undefined) return cerrada;
      await sleep(250);
    }
    return null;
  })();
  check(
    'la sesión queda cerrada y con el documento del día',
    sesionesCerradas !== null,
    String(sesionesCerradas?.sessionNumber ?? ''),
  );

  /* 3.6 La cita se marca atendida desde la barra superior. */
  paso = 'atendido';
  await page.getByRole('button', { name: `Marcar atendido: ${nombrePaciente}` }).click();
  const dialogoAtendido = page.getByRole('dialog');
  await dialogoAtendido.waitFor();
  const textoDialogo = await dialogoAtendido.innerText();
  await dialogoAtendido.getByRole('button', { name: 'Marcar atendido' }).click();
  const atendida = await esperarEstado('atendido');
  check(
    'la cita se marca atendida sin salir de la pantalla',
    atendida,
    atendida
      ? ''
      : `${String(await estadoCita())} · diálogo: ${textoDialogo.replace(/\s+/g, ' ').slice(0, 160)}`,
  );

  /* 3.7 La jornada se cerró sin cambiar de ruta ni una vez. */
  recordarRuta();
  check(
    'la URL nunca dejó de ser `/flujo`',
    [...rutas].every((ruta) => ruta === '/flujo'),
    [...rutas].join(', '),
  );

  /* 3.8 Las rutas individuales siguen funcionando. */
  paso = 'rutas individuales';
  await page.goto('/secretaria');
  await principal.getByRole('heading', { name: 'Secretaría del día' }).waitFor();
  const contadores = page.getByText('Programadas').first();
  await contadores.waitFor();
  check('`/secretaria` sigue en pie', await contadores.isVisible());

  await page.goto('/consultorio');
  await principal.getByRole('heading', { name: 'Consultorio' }).waitFor();
  check('`/consultorio` sigue en pie', await page.getByRole('textbox').first().isVisible());

  /* 3.9 La misma pantalla, en tamaño tableta (vertical, 820 px). */
  paso = 'tableta';
  //
  // Se cambia el tamaño de la ventana en lugar de abrir otra pestaña: con la rotación
  // estricta del refresco (ADR 0005), la segunda pestaña reusa el token ya rotado y
  // revoca la familia —un hallazgo de esta fase, ajeno a `/flujo`—, así que la prueba
  // del modo tableta se queda en una sola pestaña.
  await page.setViewportSize({ width: 820, height: 1180 });
  await page.goto('/flujo');
  await principal.getByRole('heading', { name: 'Flujo del día' }).waitFor();
  await page.getByRole('list', { name: 'Cola del día' }).waitFor();
  const botonAtajo = page.getByRole('button', { name: 'Buscar paciente' });
  const botonLlamar = page.getByRole('button', { name: 'Llamar al paciente' });
  check(
    'en la tableta la cola y los atajos como botón siguen a mano',
    (await botonAtajo.isVisible()) && (await botonLlamar.isVisible()),
  );
  await botonAtajo.click();
  await page.getByRole('dialog').waitFor();
  check(
    'el buscador de pacientes se abre con el botón (tableta sin teclado)',
    await page.getByRole('dialog').isVisible(),
  );
  await page.keyboard.press('Escape');

  check(
    'la consola del navegador queda sin errores',
    erroresConsola.length === 0,
    erroresConsola.slice(0, 3).join(' | '),
  );
  check(
    'ninguna petición de la pantalla quedó en error',
    respuestasFallidas.length === 0,
    respuestasFallidas.slice(0, 5).join(' | '),
  );
} catch (fallo) {
  failures += 1;
  console.error(`✖ la prueba se detuvo: ${String(fallo).split('\n')[0]}`);
  await page.screenshot({ path: 'tmp/e2e-flujo-fallo.png' }).catch(() => undefined);
  console.error('  · captura: tmp/e2e-flujo-fallo.png');
} finally {
  await navegador.close().catch(() => undefined);
}

if (respuestasFallidas.length > 0) {
  console.error('\nRespuestas con error durante la prueba:');
  for (const linea of respuestasFallidas.slice(0, 10)) console.error(`  · ${linea}`);
}

console.log(
  failures === 0
    ? '\ne2e:flujo: la doctora llevó el día completo desde `/flujo` ✔'
    : `\ne2e:flujo: ${failures} comprobación(es) en rojo ✖`,
);
if (failures === 0) {
  console.log('  · Recuerda restaurar las contraseñas:  npm run seed:users -- --reset');
}
process.exit(failures === 0 ? 0 : 1);
