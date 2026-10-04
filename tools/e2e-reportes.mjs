#!/usr/bin/env node
/**
 * Prueba de extremo a extremo de la **Fase 9** en un navegador de verdad:
 * `/reportes` y `/auditoria`, con Chromium y sobre la pila real.
 *
 *   npm run build && npm run db:migrate && npm run seed:demo
 *   npm run stack:fijo        # o: npm run dev
 *   npm run e2e:reportes
 *
 * Qué demuestra:
 *   1. El administrador entra por la interfaz y abre `/reportes` **desde el menú
 *      lateral**.
 *   2. La pantalla carga de verdad: tarjetas de KPI (las que declara el documento
 *      del reporte en la API), al menos una gráfica de Recharts, una tabla con
 *      filas y los botones de descarga en CSV y PDF.
 *   3. Se recorren **las seis pestañas** (o las que el rol tenga) y cada una pinta
 *      su reporte sin ensuciar la consola.
 *   4. Al cambiar el rango de fechas la pantalla vuelve a pedir el reporte con el
 *      rango nuevo y la tabla sigue con filas.
 *   5. `/auditoria` filtra por la acción `patient_updated` y el detalle muestra el
 *      teléfono anterior, el nuevo y el motivo del cambio (el cambio lo prepara
 *      esta misma prueba por la API).
 *   6. Deja una captura en `tmp/e2e-reportes.png` para revisarla a ojo.
 *
 * ⚠️ Cambia la contraseña temporal del administrador sembrado. Al terminar:
 *    npm run seed:users -- --reset
 */
import { connect } from 'node:net';

import { chromium } from 'playwright';

const WEB = process.env['E2E_WEB_URL'] ?? 'http://127.0.0.1:5173';
const GATEWAY = process.env['E2E_GATEWAY_URL'] ?? 'http://127.0.0.1:8090';
const USERNAME = process.env['E2E_USERNAME'] ?? 'admin';
const PASSWORD = process.env['E2E_PASSWORD'] ?? 'admin-odontocrm-2026';
const NEW_PASSWORD = process.env['E2E_NEW_PASSWORD'] ?? 'prueba-e2e-odontocrm-2026';
const MARK = 'PRUEBA E2E REPORTES';
/** El cambio auditado que la prueba prepara y después busca en `/auditoria`. */
const PHONE_BEFORE = '0414-1112233';
const PHONE_AFTER = '0414-4445566';
const REASON = 'Prueba e2e: el paciente cambió de teléfono';
/** Cédula ficticia del rango reservado 97.000.000+, nueva en cada corrida. */
const DOC = { type: 'V', number: `97${String(Date.now()).slice(-6)}` };
/** Milisegundos que se esperan a que la interfaz reaccione. */
const ESPERA_MS = Number(process.env['E2E_TIMEOUT_MS'] ?? 25_000);
/** Catálogo cerrado de reportes (`REPORT_KEYS` de `@odontocrm/contracts`). */
const REPORT_KEYS = [
  'funnel',
  'capacity',
  'demographics',
  'clinical-profile',
  'oral-health',
  'prescriptions',
];

let failures = 0;
let token = '';

const check = (etiqueta, condicion, detalle = '') => {
  if (!condicion) failures += 1;
  console.log(`${condicion ? '✔' : '✖'} ${etiqueta}${detalle === '' ? '' : ` → ${detalle}`}`);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Petición por el gateway (solo para preparar datos y leer el guion de la pantalla). */
const call = async (path, options = {}) => {
  try {
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
  } catch (error) {
    return { status: 0, body: String(error).slice(0, 200) };
  }
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

const hoy = new Date(Date.now() - 4 * 3_600_000).toISOString().slice(0, 10);
const haceDias = (dias) =>
  new Date(Date.parse(`${hoy}T00:00:00Z`) + dias * 86_400_000).toISOString().slice(0, 10);
/** Rango que se escribe en los filtros de la pantalla. */
const DESDE_FILTRO = haceDias(-7);
const DESDE_API = haceDias(-29);

/* ── 0) ¿Está la pila en pie? ──────────────────────────────────────────────── */

for (const [nombre, url] of [
  ['la interfaz', WEB],
  ['el gateway', GATEWAY],
]) {
  if (!(await escucha(url))) {
    console.error(
      `e2e:reportes: no hay nada escuchando en ${url} (${nombre}).\n` +
        '  · Arranca la pila:  npm run stack:fijo   (PM2)\n' +
        '                      npm run dev          (todo en una terminal)\n' +
        '  · Comprueba el modo: npm run stack:status',
    );
    process.exit(1);
  }
}

/* ── 1) Entrar por la API: los datos de la prueba y el guion de la pantalla ── */

const intentarLogin = (password) =>
  call('/api/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: USERNAME, password }),
  });

let login = await intentarLogin(PASSWORD);
/** Contraseña con la que entra hoy: la sembrada o la que dejó una corrida previa. */
let claveValida = PASSWORD;
if (login.status === 401) {
  login = await intentarLogin(NEW_PASSWORD);
  claveValida = NEW_PASSWORD;
}
check(
  `el administrador ${USERNAME} entra por la API`,
  login.status === 200,
  `status ${login.status}${login.status === 200 ? '' : ' · npm run seed:users -- --reset'}`,
);
if (login.status !== 200) process.exit(1);
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
  check('cambia la contraseña temporal', cambiada.status === 200, `status ${cambiada.status}`);
  token = cambiada.body?.accessToken ?? token;
  claveValida = NEW_PASSWORD;
  if (cambiada.status !== 200) process.exit(1);
}

/** Paciente de la corrida con su teléfono editado: es la fila que busca `/auditoria`. */
const paciente = await call('/api/v1/patients', {
  method: 'POST',
  body: JSON.stringify({
    docType: DOC.type,
    docNumber: DOC.number,
    fullName: `PACIENTE ${MARK}`,
    birthDate: '1980-03-10',
    sex: 'M',
    phone: PHONE_BEFORE,
    address: 'Dirección de la prueba e2e de reportes',
    notes: null,
  }),
});
check(
  'el paciente de la prueba se registra por la API',
  paciente.status === 201,
  `status ${paciente.status}`,
);
const patientId = paciente.body?.id;

if (typeof patientId === 'string') {
  const editado = await call(`/api/v1/patients/${patientId}`, {
    method: 'PATCH',
    body: JSON.stringify({ phone: PHONE_AFTER, reason: REASON }),
  });
  check(
    'el cambio de teléfono queda con su motivo (lo que verá la auditoría)',
    editado.status === 200 && editado.body?.phone === '+584144445566',
    `status ${editado.status} · ${String(editado.body?.phone)}`,
  );
}

/** El documento del reporte: es el guion de lo que la pantalla tiene que pintar. */
const documentos = {};
for (const key of REPORT_KEYS) {
  const respuesta = await call(`/api/v1/reports/${key}?from=${DESDE_API}&to=${hoy}`);
  documentos[key] = respuesta.status === 200 ? respuesta.body : null;
}
const reportesConDocumento = REPORT_KEYS.filter((key) => documentos[key] !== null);
check(
  'la API entrega los documentos de los seis reportes',
  reportesConDocumento.length === REPORT_KEYS.length,
  `${reportesConDocumento.length} de ${REPORT_KEYS.length} (la pantalla necesita el servicio de reportes)`,
);

/* ── 2) El navegador ───────────────────────────────────────────────────────── */

let navegador;
try {
  navegador = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
} catch (fallo) {
  console.error(
    `e2e:reportes: no se pudo abrir Chromium.\n${String(fallo).slice(0, 400)}\n` +
      '  · Instálalo con:  npx playwright install chromium',
  );
  process.exit(1);
}

const contexto = await navegador.newContext({
  baseURL: WEB,
  viewport: { width: 1440, height: 1000 },
  locale: 'es-VE',
});
const page = await contexto.newPage();
page.setDefaultTimeout(ESPERA_MS);
/** El área de contenido (la cabecera del shell repite el nombre del módulo). */
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

/* ── Ayudantes de pantalla ─────────────────────────────────────────────────── */

/** Estado de pintado de un reporte: filas, gráficas y el «sin datos» legible. */
const pintado = async () => {
  const filas = await page.locator('main table tbody tr').count();
  const tablas = await page.locator('main table').count();
  const graficas = await page.locator('main svg.recharts-surface, main canvas').count();
  const vacio = await page
    .getByText(/sin datos|no hay datos|sin resultados|sin informaci/i)
    .count();
  return {
    filas,
    tablas,
    graficas,
    vacio,
    listo: filas > 0 || tablas > 0 || graficas > 0 || vacio > 0,
  };
};

/** Espera a que la pantalla pinte (la proyección y la red tardan lo suyo). */
const esperarPintado = async () => {
  for (let intento = 0; intento < 40; intento += 1) {
    const estado = await pintado();
    if (estado.listo) return estado;
    await sleep(250);
  }
  return await pintado();
};

/** Botones o enlaces de descarga cuyo nombre menciona el formato. */
const descargas = async (formato) => {
  const botones = await page.getByRole('button', { name: formato }).count();
  const enlaces = await page.getByRole('link', { name: formato }).count();
  return botones + enlaces;
};

/**
 * Los selectores de reporte de la pantalla: pestañas `role=tab` y, si no las
 * hubiera, un desplegable de reportes. Devuelve cómo recorrerlos y nombrarlos.
 */
const recorridoDeReportes = async () => {
  const pestañas = page.getByRole('tab');
  const total = await pestañas.count();
  if (total > 0) {
    return {
      tipo: 'pestañas',
      total,
      ir: async (indice) => pestañas.nth(indice).click(),
      nombre: async (indice) => (await pestañas.nth(indice).innerText()).trim().slice(0, 40),
    };
  }
  const select = page.locator('main select').first();
  if ((await select.count()) > 0) {
    const opciones = await select.locator('option').allTextContents();
    return {
      tipo: 'desplegable',
      total: opciones.length,
      ir: async (indice) => select.selectOption({ index: indice }),
      nombre: async (indice) => (opciones[indice] ?? '').trim().slice(0, 40),
    };
  }
  return {
    tipo: 'ninguno',
    total: 0,
    ir: async () => undefined,
    nombre: async () => '(sin selector)',
  };
};

/** Filtra la auditoría por acción: desplegable, campo de acción o buscador. */
const filtrarAuditoria = async (accion) => {
  const selects = page.locator('main select');
  const totalSelects = await selects.count();
  for (let indice = 0; indice < totalSelects; indice += 1) {
    const select = selects.nth(indice);
    const opciones = await select
      .locator('option')
      .evaluateAll((nodos) => nodos.map((nodo) => `${nodo.value}|${nodo.textContent ?? ''}`));
    const elegida = opciones.find((opcion) => opcion.toLowerCase().includes(accion));
    if (elegida !== undefined) {
      await select.selectOption(elegida.split('|')[0]);
      return `desplegable (${elegida.split('|')[1] ?? accion})`;
    }
  }
  const campo = page.getByLabel(/acci[oó]n/i).first();
  if ((await campo.count()) > 0) {
    await campo.fill(accion);
    await campo.press('Enter');
    return 'campo de acción';
  }
  const buscador = page.getByRole('searchbox').first();
  if ((await buscador.count()) > 0) {
    await buscador.fill(`${DOC.type}-${DOC.number}`);
    return 'buscador por documento';
  }
  return null;
};

/** Abre el detalle de la primera fila (botón explícito o la fila entera). */
const abrirDetalle = async () => {
  const boton = page
    .getByRole('button', { name: /ver detalle|detalle|ver m[aá]s|ampliar|abrir/i })
    .first();
  if ((await boton.count()) > 0) {
    await boton.click();
  } else {
    const fila = page.locator('main table tbody tr').first();
    if ((await fila.count()) > 0) await fila.click();
  }
  await sleep(600);
  return (await page.getByRole('dialog').count()) > 0;
};

/** Texto visible de la pantalla, con los espacios colapsados. */
const textoVisible = async () => (await page.locator('body').innerText()).replace(/\s+/g, ' ');

/* ── 3) La prueba, paso a paso ─────────────────────────────────────────────── */

try {
  /* 3.1 Entrar por la interfaz. */
  paso = 'login';
  await page.goto('/login');
  await page.locator('input[autocomplete="username"]').fill(USERNAME);
  await page.locator('input[autocomplete="current-password"]').fill(claveValida);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await page.waitForURL(/\/inicio/);
  check('el administrador entra a la interfaz', page.url().includes('/inicio'), page.url());
  // El arranque en frío no trae cookie: el intento de restaurar la sesión responde
  // 401 y es el camino normal de «visita nueva», no un fallo de la pantalla.
  respuestasFallidas.length = 0;
  erroresConsola.length = 0;

  /* 3.2 `/reportes` desde el menú lateral. */
  paso = 'menú lateral';
  const enlaceReportes = page.getByRole('link', { name: 'Reportes' }).first();
  // El menú se pinta al hidratar la SPA: se **espera** el enlace antes de darlo por
  // bueno. Comprobarlo sin esperar convertía una carrera de milisegundos en un rojo.
  const hayEnlaceReportes = await enlaceReportes
    .waitFor({ state: 'visible', timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  check('el menú lateral ofrece «Reportes»', hayEnlaceReportes);
  await enlaceReportes.click();
  await page.waitForURL(/\/reportes/);
  check('el enlace lleva a `/reportes`', page.url().includes('/reportes'), page.url());

  paso = 'reportes';
  const estadoInicial = await esperarPintado();
  const recorrido = await recorridoDeReportes();
  check(
    'el módulo «Reportes» carga de verdad',
    estadoInicial.listo && recorrido.total > 0,
    `filas ${String(estadoInicial.filas)} · gráficas ${String(estadoInicial.graficas)} · ${String(recorrido.total)} ${recorrido.tipo}`,
  );

  /* Las tarjetas de KPI: los rótulos que declara el documento del reporte. */
  let mejorKpi = { key: '(ninguno)', visibles: 0, total: 0 };
  for (const key of REPORT_KEYS) {
    const etiquetas = (documentos[key]?.kpis ?? []).map((cifra) => cifra.label);
    if (etiquetas.length === 0) continue;
    let visibles = 0;
    for (const etiqueta of etiquetas) {
      if ((await page.getByText(etiqueta, { exact: false }).count()) > 0) visibles += 1;
    }
    if (visibles > mejorKpi.visibles) mejorKpi = { key, visibles, total: etiquetas.length };
  }
  check(
    'la pantalla pinta las tarjetas de KPI del reporte',
    mejorKpi.visibles >= 2 && mejorKpi.visibles >= Math.ceil(mejorKpi.total / 2),
    `reporte «${mejorKpi.key}»: ${String(mejorKpi.visibles)} de ${String(mejorKpi.total)} rótulos visibles`,
  );

  const graficas = await page.locator('main svg.recharts-surface, main canvas').count();
  check(
    'hay al menos una gráfica de Recharts visible',
    graficas >= 1,
    `${String(graficas)} gráfica(s)`,
  );
  const filasTabla = await page.locator('main table tbody tr').count();
  check('la tabla del reporte trae filas', filasTabla >= 1, `${String(filasTabla)} fila(s)`);

  const botonCsv = await descargas(/csv/i);
  const botonPdf = await descargas(/pdf/i);
  const botonesDescarga = await page.getByRole('button', { name: /descargar|exportar/i }).count();
  check(
    'la pantalla ofrece la descarga en CSV y en PDF',
    botonCsv >= 1 && botonPdf >= 1,
    `CSV ${String(botonCsv)} · PDF ${String(botonPdf)} · botones de descarga ${String(botonesDescarga)}`,
  );

  /* 3.3 Las seis pestañas (o las que el rol tenga). */
  paso = 'pestañas';
  check(
    'la pantalla tiene las seis pestañas de reporte',
    recorrido.total >= 6,
    `${String(recorrido.total)} ${recorrido.tipo}`,
  );
  for (let indice = 0; indice < recorrido.total; indice += 1) {
    const erroresAntes = erroresConsola.length;
    const nombre = await recorrido.nombre(indice);
    await recorrido.ir(indice);
    const estado = await esperarPintado();
    check(
      `la pestaña «${nombre}» pinta su reporte`,
      estado.listo,
      `filas ${String(estado.filas)} · gráficas ${String(estado.graficas)}`,
    );
    check(
      `la pestaña «${nombre}» no ensucia la consola`,
      erroresConsola.length === erroresAntes,
      erroresConsola.slice(erroresAntes, erroresAntes + 2).join(' | '),
    );
  }

  /* 3.4 Cambiar el rango de fechas y comprobar que vuelve a pintar. */
  paso = 'filtro de fechas';
  await recorrido.ir(0);
  await esperarPintado();
  const camposFecha = page.locator('main input[type="date"]');
  const totalFechas = await camposFecha.count();
  check(
    'la pantalla tiene los campos de fecha del filtro',
    totalFechas >= 2,
    `${String(totalFechas)} campo(s) de fecha`,
  );
  if (totalFechas >= 2) {
    const conRango = page
      .waitForResponse(
        (respuesta) =>
          respuesta.url().includes('/api/v1/reports/') &&
          respuesta.url().includes(`from=${DESDE_FILTRO}`) &&
          respuesta.status() === 200,
        { timeout: ESPERA_MS },
      )
      .catch(() => null);
    await camposFecha.nth(0).fill(DESDE_FILTRO);
    await camposFecha.nth(1).fill(hoy);
    const aplicar = page
      .getByRole('button', { name: /aplicar|actualizar|filtrar|buscar|consultar/i })
      .first();
    if ((await aplicar.count()) > 0) await aplicar.click();
    const respuesta = await conRango;
    check(
      'al cambiar el rango la pantalla vuelve a pedir el reporte',
      respuesta !== null,
      respuesta === null ? `no llegó ninguna petición con from=${DESDE_FILTRO}` : respuesta.url(),
    );
    const estado = await esperarPintado();
    check(
      'tras filtrar, la tabla sigue con filas',
      estado.filas >= 1,
      `filas ${String(estado.filas)}`,
    );
  }

  /* 3.5 `/auditoria`: el cambio de teléfono con su antes, su después y su motivo. */
  paso = 'auditoría';
  await page.goto('/auditoria');
  await principal.waitFor();
  check('la ruta `/auditoria` abre', page.url().includes('/auditoria'), page.url());

  const filtro = await filtrarAuditoria('patient_updated');
  check(
    'la auditoría se filtra por la acción del cambio de teléfono',
    filtro !== null,
    filtro ?? 'no encontré el filtro de acción en la pantalla',
  );

  let filasAuditoria = 0;
  for (let intento = 0; intento < 40; intento += 1) {
    filasAuditoria = await page.locator('main table tbody tr').count();
    if (filasAuditoria > 0) break;
    await sleep(250);
  }
  check(
    'la lista de auditoría trae el cambio de teléfono',
    filasAuditoria >= 1,
    `${String(filasAuditoria)} fila(s)`,
  );

  const abierto = await abrirDetalle();
  /** El detalle manda si está abierto; si no, se mira la lista (que ya trae el motivo). */
  const textoDialogo = abierto
    ? (await page.getByRole('dialog').first().innerText()).replace(/\s+/g, ' ')
    : await textoVisible();
  const texto = await textoVisible();
  const digitos = texto.replace(/\D/g, '');
  check(
    'el detalle muestra el teléfono anterior y el nuevo',
    digitos.includes('584141112233') && digitos.includes('584144445566'),
    abierto ? 'detalle abierto' : `${String(filasAuditoria)} fila(s), sin diálogo`,
  );
  check(
    'el detalle muestra el motivo del cambio',
    textoDialogo.includes(REASON),
    abierto ? textoDialogo.slice(0, 160) : 'sin diálogo: se buscó en la lista',
  );

  /* 3.6 Captura final para revisarla a ojo. */
  paso = 'captura';
  await page.goto('/reportes');
  await esperarPintado();
  await page.screenshot({ path: 'tmp/e2e-reportes.png', fullPage: true });
  console.log('· Captura final: tmp/e2e-reportes.png');

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
  await page.screenshot({ path: 'tmp/e2e-reportes-fallo.png' }).catch(() => undefined);
  console.error('  · captura: tmp/e2e-reportes-fallo.png');
} finally {
  await navegador.close().catch(() => undefined);
}

if (respuestasFallidas.length > 0) {
  console.error('\nRespuestas con error durante la prueba:');
  for (const linea of respuestasFallidas.slice(0, 10)) console.error(`  · ${linea}`);
}

console.log(
  failures === 0
    ? '\ne2e:reportes: `/reportes` y `/auditoria` funcionan de punta a punta ✔'
    : `\ne2e:reportes: ${String(failures)} comprobación(es) en rojo ✖`,
);
console.log('Recuerda restaurar las contraseñas sembradas:  npm run seed:users -- --reset');
process.exit(failures === 0 ? 0 : 1);
