#!/usr/bin/env node
/**
 * Prueba de humo de la Fase 11, sesión B (facturación: emitir y cobrar) contra el gateway real.
 *
 * Recorre el mostrador de punta a punta:
 *  1. cierra una **sesión clínica** y espera el **borrador** que deja el consumidor por el evento;
 *  2. **precia** sus líneas (el catálogo entra en 0 y la caja lo resuelve);
 *  3. da de alta el **lote de formas libres** (si no quedaba ninguno) y la **tasa del día**;
 *  4. **emite**: los dos números, la tasa congelada, el PDF archivado con su `sha256`;
 *  5. **cobra** en bolívares (parcial, con la tasa del pago) y en divisas (el resto);
 *  6. comprueba el **saldo**, el **estado**, la **auditoría** y el PDF en el **almacén**.
 *
 *   npm run build && npm run db:migrate && npm run seed:users
 *   npm run stack:fijo        # o: npm run dev
 *   npm run smoke:billing
 *
 * ⚠️ Cambia la contraseña del administrador sembrada. Al terminar, restáurala:
 *    npm run seed:users -- --reset
 *
 * Lo que deja: la **factura emitida** y sus cobros (un documento fiscal no se borra: se anula con nota
 * de crédito, no se elimina), el lote de formas y la tasa del día. El paciente de la prueba queda con
 * **borrado lógico** al final, como en las demás pruebas de humo.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { decryptBlob, looksEncrypted, parseEncryptionKey } from '@odontocrm/storage';

import { entornoRaiz, leerEnv, rutaEnvDe, SERVICIOS } from './lib/servicios.mjs';

/* ── Configuración ─────────────────────────────────────────────────────────── */

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GATEWAY = process.env.SMOKE_GATEWAY_URL ?? 'http://127.0.0.1:8090';
const credentials = {
  username: process.env.SMOKE_USERNAME ?? 'admin',
  password: process.env.SMOKE_PASSWORD ?? 'admin-odontocrm-2026',
};
const NEW_PASSWORD = process.env.SMOKE_NEW_PASSWORD ?? 'prueba-e2e-odontocrm-2026';
const MARK = 'PRUEBA DE HUMO FACTURACIÓN';
/** Cédula ficticia del rango reservado 98.000.000+, distinta en cada corrida. */
const DOC = { type: 'V', number: `98${String(Date.now()).slice(-6)}` };
/** Dónde archiva `billing` los documentos (ADR 0036/0048): `STORAGE_DIR` es una raíz **compartida**
 * (`./storage/patients` por defecto), así que la búsqueda del PDF va sobre `storage/`. */
const ALMACEN = process.env.SMOKE_BILLING_STORAGE_DIR ?? resolve(RAIZ, 'storage');
/**
 * La clave del almacén, si la hay. Los PDF pueden estar **cifrados en reposo** y la huella que guarda
 * la base es la del texto en claro, así que sin descifrar el archivo no se reconocería (y la prueba
 * diría que no está archivado cuando sí lo está). Se lee el entorno como lo leen los servicios:
 * primero el común y después el suyo, que manda.
 */
const CLAVE_ALMACEN = parseEncryptionKey(
  process.env.STORAGE_ENCRYPTION_KEY ??
    (() => {
      const billing = SERVICIOS.find((servicio) => servicio.name === 'billing');
      const env = { ...entornoRaiz(), ...(billing ? leerEnv(rutaEnvDe(billing)) : {}) };
      return env.STORAGE_ENCRYPTION_KEY;
    })(),
);
/** Hasta cuánto se espera a que el consumidor deje el borrador de la sesión cerrada. */
const ESPERA_BORRADOR_MS = Number(process.env.SMOKE_BILLING_WAIT_MS ?? 20_000);
/** Hasta cuánto se espera a que la auditoría proyecte los eventos (el outbox no es instantáneo). */
const ESPERA_AUDITORIA_MS = Number(process.env.SMOKE_BILLING_AUDIT_WAIT_MS ?? 10_000);
/** El arancel que la caja teclea para el procedimiento (US$ 35,00): el catálogo entra en 0. */
const PRECIO_CENTIMOS = 3500;
/** La tasa como se teclea en el mostrador; si ya hay una de hoy, se reutiliza. */
const TASA = process.env.SMOKE_BILLING_RATE ?? '36,5420';
/** Numeración propia del lote (9 dígitos: no choca con los lotes de 6 de la clínica). */
const LOTE_BASE = 900_000_000 + (Date.now() % 90_000_000);
/** Formas del lote de la prueba: por encima del umbral de aviso (20) para que no salga `isLow`. */
const FORMAS_POR_LOTE = 25;
/** RIF propio de la imprenta: la suite de emisión usa otro, y compartirlo le rompía su limpieza. */
const RIF_IMPRENTA = `J-${String(Date.now()).slice(-8)}-1`;

let token = '';
let failures = 0;

/* ── Utilidades ────────────────────────────────────────────────────────────── */

const call = async (path, options = {}) => {
  try {
    const response = await fetch(`${GATEWAY}${path}`, {
      ...options,
      signal: options.signal ?? AbortSignal.timeout(30_000),
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

const check = (etiqueta, condicion, detalle = '') => {
  if (!condicion) failures += 1;
  console.log(`${condicion ? '✔' : '✖'} ${etiqueta}${detalle === '' ? '' : ` → ${detalle}`}`);
};

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

/** ¿Hay alguien escuchando en el puerto del gateway? */
const escucha = async (url) => {
  const objetivo = new URL(url);
  return new Promise((resolveSocket) => {
    const socket = connect({
      port: Number(
        objetivo.port === '' ? (objetivo.protocol === 'https:' ? 443 : 80) : objetivo.port,
      ),
      host: objetivo.hostname,
    });
    const terminar = (valor) => {
      socket.removeAllListeners();
      socket.destroy();
      resolveSocket(valor);
    };
    socket.setTimeout(1_500);
    socket.once('connect', () => terminar(true));
    socket.once('timeout', () => terminar(false));
    socket.once('error', () => terminar(false));
  });
};

/** Hoy en la zona del consultorio (America/Caracas, UTC−4), como lo hace el servidor. */
const hoy = new Date(Date.now() - 4 * 3_600_000).toISOString().slice(0, 10);

/** Sondea hasta que `listo` se cumpla o se agote el tiempo. Devuelve la última respuesta. */
const esperar = async (path, listo, limiteMs) => {
  const limite = Date.now() + limiteMs;
  let ultima = await call(path);
  while (!(ultima.status === 200 && listo(ultima.body))) {
    if (Date.now() >= limite) return ultima;
    await sleep(500);
    ultima = await call(path);
  }
  return ultima;
};

/** Espera a que la auditoría muestre el evento (identity lo recibe por el outbox). */
const esperarAuditoria = async (query) => {
  const limite = Date.now() + ESPERA_AUDITORIA_MS;
  for (;;) {
    const respuesta = await call(`/api/v1/audit/events?${query}`);
    const items = respuesta.body?.items ?? [];
    if (items.length > 0) return items;
    if (Date.now() >= limite) return items;
    await sleep(250);
  }
};

const esHuella = (valor) => typeof valor === 'string' && /^[0-9a-f]{64}$/.test(valor);

/** Todos los archivos bajo una carpeta (con tope, para no recorrer un almacén entero). */
const archivosBajo = (dir, tope = 5_000) => {
  const encontrados = [];
  const pila = [dir];
  while (pila.length > 0 && encontrados.length < tope) {
    const actual = pila.pop();
    let entradas;
    try {
      entradas = readdirSync(actual, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entrada of entradas) {
      const ruta = join(actual, entrada.name);
      if (entrada.isDirectory()) pila.push(ruta);
      else if (entrada.isFile() && !encontrados.includes(ruta)) encontrados.push(ruta);
    }
  }
  return encontrados;
};

/**
 * La ruta del archivo archivado cuya huella es la pedida (`null` si el almacén no lo tiene).
 * Se recorre el almacén **en cada llamada**: los documentos aparecen a lo largo de la prueba (la
 * factura al emitir, los recibos al cobrar) y un índice cacheado se quedaría corto.
 */
/**
 * Los bytes **en claro** de un archivo del almacén. Los PDF pueden estar cifrados en reposo: la
 * huella que guarda la base es la del texto en claro, y en disco el archivo empieza por la cabecera
 * del cifrado, no por `%PDF`, así que sin descifrar no se reconocería nada. `null` si está cifrado y
 * no hay clave: entonces no se puede comprobar, pero tampoco se da por perdido.
 */
const claroDe = (ruta) => {
  const bytes = readFileSync(ruta);
  if (!looksEncrypted(bytes)) return bytes;
  return CLAVE_ALMACEN === undefined ? null : decryptBlob(bytes, CLAVE_ALMACEN);
};

const buscarPdf = (sha256) => {
  try {
    const rutas = archivosBajo(ALMACEN);
    // Los documentos de facturación van en su propia carpeta: se miran primero.
    const deBilling = rutas.filter((ruta) => ruta.includes('billing'));
    for (const ruta of deBilling.length > 0 ? deBilling : rutas) {
      if (statSync(ruta).size === 0) continue;
      const contenido = claroDe(ruta);
      if (contenido === null) continue;
      if (createHash('sha256').update(contenido).digest('hex') === sha256) return ruta;
    }
  } catch {
    return null;
  }
  return null;
};

/* ── 0) ¿Está la pila en pie? ──────────────────────────────────────────────── */

if (!(await escucha(GATEWAY))) {
  console.error(
    `smoke:billing: no hay nada escuchando en ${GATEWAY}.\n` +
      '  · Arranca la pila:  npm run stack:fijo   (PM2)\n' +
      '                      npm run dev          (todo en una terminal)\n' +
      '  · Comprueba el modo: npm run stack:status\n' +
      '  · Si faltan migraciones: npm run build && npm run db:migrate',
  );
  process.exit(1);
}

/* ── 1) Sesión del administrador ───────────────────────────────────────────── */

const intentarLogin = async (username, password) =>
  call('/api/v1/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });

let login = await intentarLogin(credentials.username, credentials.password);
if (login.status === 401 && credentials.password !== NEW_PASSWORD) {
  const segundo = await intentarLogin(credentials.username, NEW_PASSWORD);
  if (segundo.status === 200) {
    console.log('· La contraseña del administrador ya se había cambiado: se usa la de prueba.');
    login = segundo;
  }
}
check('login del administrador', login.status === 200, `status ${login.status}`);
if (login.status !== 200) {
  console.error(
    '\nNo se pudo iniciar sesión. Restaura las contraseñas con:  npm run seed:users -- --reset',
  );
  process.exit(1);
}
token = login.body?.accessToken ?? '';

if (login.body?.user?.mustChangePassword === true) {
  const cambiada = await call('/api/v1/auth/password/change', {
    method: 'POST',
    body: JSON.stringify({
      currentPassword: credentials.password,
      newPassword: NEW_PASSWORD,
      repeatPassword: NEW_PASSWORD,
    }),
  });
  check('cambio de la contraseña temporal', cambiada.status === 200, `status ${cambiada.status}`);
  token = cambiada.body?.accessToken ?? token;
}

/* ── 2) Paciente de la prueba ──────────────────────────────────────────────── */

const creado = await call('/api/v1/patients', {
  method: 'POST',
  body: JSON.stringify({
    docType: DOC.type,
    docNumber: DOC.number,
    fullName: `PACIENTE ${MARK}`,
    birthDate: '1985-05-20',
    sex: 'F',
    phone: '0414-1234567',
    address: 'Dirección de la prueba de humo de facturación',
    notes: null,
  }),
});
check('el paciente de la prueba se registra', creado.status === 201, `status ${creado.status}`);
const patientId = creado.body?.id;
if (typeof patientId !== 'string') {
  console.error('\nSin paciente no hay sesión ni factura: se detiene la prueba.');
  process.exit(1);
}

/* ── 3) La sesión clínica, cerrada (lo que dispara el borrador) ────────────── */

const abierta = await call(`/api/v1/clinical/patients/${patientId}/sessions`, {
  method: 'POST',
  body: JSON.stringify({ appointmentId: null, motivo: `${MARK}: dolor en la 36` }),
});
check(
  'la sesión clínica se abre',
  (abierta.status === 201 || abierta.status === 200) && typeof abierta.body?.id === 'string',
  `status ${abierta.status}`,
);
const sessionId = abierta.body?.id;
if (typeof sessionId !== 'string') {
  console.error('\nSin sesión no se cierra nada: se detiene la prueba.');
  process.exit(1);
}

const guardada = await call(`/api/v1/clinical/sessions/${sessionId}`, {
  method: 'PUT',
  body: JSON.stringify({
    content: {
      motivo: 'Dolor a la masticación en la pieza 36',
      anamnesis: 'Sin antecedentes de interés para la prueba de humo.',
      vitals: {
        taSistolica: 120,
        taDiastolica: 80,
        fc: 72,
        temperatura: null,
        spo2: null,
        peso: null,
      },
      exam: {
        tejidosBlandos: 'normal',
        encias: 'normal',
        sondaje: null,
        oclusion: 'normal',
        higiene: 'buena',
        hallazgos: 'Caries oclusal profunda en la 36',
      },
      procedimientos: [
        { code: 'obturacion_resina', toothNumber: 36, surfaces: ['occlusal'], notas: MARK },
      ],
      materiales: [],
      diagnostico: 'Caries oclusal en la pieza 36',
      indicaciones: 'No comer del lado derecho por 24 horas.',
      proximaCitaFecha: null,
      proximaCitaNota: null,
      notasInternas: MARK,
    },
  }),
});
check(
  'la sesión se guarda con su procedimiento del catálogo',
  guardada.status === 200 && guardada.body?.content?.procedimientos?.length === 1,
  `status ${guardada.status} · ${JSON.stringify(guardada.body).slice(0, 160)}`,
);

const cerrada = await call(`/api/v1/clinical/sessions/${sessionId}/close`, {
  method: 'POST',
  body: JSON.stringify({ confirm: true, closureNote: `${MARK}: sin molestias` }),
});
check(
  'la sesión clínica se cierra (y publica el evento del borrador)',
  cerrada.status === 200 && cerrada.body?.status === 'cerrada',
  `status ${cerrada.status} · ${String(cerrada.body?.status)}`,
);

/* ── 4) El borrador que deja el consumidor ─────────────────────────────────── */

const borrador = await esperar(
  '/api/v1/billing/drafts?pageSize=200',
  (body) => (body?.items ?? []).some((item) => item.patientId === patientId),
  ESPERA_BORRADOR_MS,
);
const resumen = (borrador.body?.items ?? []).find((item) => item.patientId === patientId);
check(
  'el cierre de la sesión deja el borrador en la caja',
  resumen !== undefined,
  resumen === undefined
    ? `status ${borrador.status} · ${JSON.stringify(borrador.body).slice(0, 160)}`
    : '',
);
if (resumen === undefined) {
  console.error('\nSin borrador no hay nada que emitir: se detiene la prueba.');
  process.exit(1);
}
check(
  'nace sin precio y marcado para que la caja lo resuelva (M3)',
  resumen.status === 'borrador' && resumen.needsPricing === true,
  `status ${resumen.status} · needsPricing ${String(resumen.needsPricing)}`,
);
const series = resumen.series;
console.log(`· Borrador ${resumen.id} · serie ${series} · ${String(resumen.itemCount)} partida(s)`);

const detalle = await call(`/api/v1/billing/drafts/${resumen.id}`);
const partidas = detalle.body?.items ?? [];
check('el borrador se lee con sus partidas', partidas.length > 0, `${partidas.length} partida(s)`);
if (partidas.length === 0) {
  console.error('\nEl borrador no trae partidas: se detiene la prueba.');
  process.exit(1);
}

/* ── 5) Preciar el borrador ────────────────────────────────────────────────── */

const precio = await call(`/api/v1/billing/drafts/${resumen.id}/items`, {
  method: 'PUT',
  body: JSON.stringify({
    items: partidas.map((item, indice) => ({
      code: item.code,
      quantity: item.quantity,
      // La primera partida se precia; si hubiera más, también, para no dejar ninguna en 0.
      unitPriceCentsUsd: PRECIO_CENTIMOS + indice,
      description: item.description,
      toothNumber: item.toothNumber,
      surfaces: item.surfaces ?? [],
    })),
  }),
});
const precioTotal = precio.body?.totals?.totalCentsUsd ?? 0;
check(
  'el borrador se precia y deja de estar marcado',
  precio.status === 200 && precio.body?.needsPricing === false && precioTotal > 0,
  `status ${precio.status} · total US$ ${(precioTotal / 100).toFixed(2)}`,
);
// Los servicios odontológicos son EXENTOS (Art. 19.6): el total va por lo exento, sin IVA.
check(
  'el servicio odontológico queda exento, sin IVA',
  precio.body?.totals?.ivaAmountCentsUsd === 0 &&
    precio.body?.totals?.exemptAmountCentsUsd === precioTotal,
  `exento ${String(precio.body?.totals?.exemptAmountCentsUsd)} · IVA ${String(precio.body?.totals?.ivaAmountCentsUsd)}`,
);

/* ── 6) El lote de formas libres ───────────────────────────────────────────── */

/** El lote del que se consume: el más antiguo que todavía tenga formas (`activeLot`). */
const listaLotes = async () =>
  (await call(`/api/v1/billing/forms?series=${series}`)).body?.items ?? [];
const lotes = await listaLotes();
let loteActivo = lotes.find((item) => item.remaining > 0) ?? null;

if (loteActivo === null) {
  // Sin formas no se puede facturar: el alta es parte del recorrido cuando el lote se agotó.
  const lote = await call('/api/v1/billing/forms', {
    method: 'POST',
    body: JSON.stringify({
      series,
      controlFrom: String(LOTE_BASE),
      controlTo: String(LOTE_BASE + FORMAS_POR_LOTE - 1),
      printerName: `Imprenta ${MARK}`,
      printerRif: RIF_IMPRENTA,
      authorizationRef: 'providencia 0071/2026',
      authorizationDate: hoy,
      printDate: hoy,
    }),
  });
  check(
    'el alta del lote de formas libres (rango, imprenta y providencia)',
    lote.status === 201 &&
      lote.body?.remaining === FORMAS_POR_LOTE &&
      lote.body?.series === series &&
      lote.body?.isLow === false,
    `status ${lote.status} · restantes ${String(lote.body?.remaining)}`,
  );
  loteActivo = lote.body ?? null;
} else {
  // Lo que hace la caja de verdad: consume del lote más antiguo que todavía tenga formas.
  console.log(
    `· El lote ${String(loteActivo.controlFrom)}–${String(loteActivo.controlTo)} ya tenía ` +
      `${String(loteActivo.remaining)} forma(s): se reutiliza, como en el mostrador.`,
  );
}

check(
  'hay un lote con formas para consumir',
  loteActivo !== null,
  `próximo control ${String(loteActivo?.nextControl)}`,
);

/* ── 7) La tasa del día ────────────────────────────────────────────────────── */

const tasaDeHoy = await call('/api/v1/billing/rates/today');
let tasa = tasaDeHoy.body?.current ?? null;
if (tasa === null || tasa.rateDate !== hoy) {
  const puesta = await call('/api/v1/billing/rates', {
    method: 'POST',
    body: JSON.stringify({
      rateDate: hoy,
      rate: TASA,
      note: `${MARK}: tasa del día de la prueba`,
    }),
  });
  check(
    'el alta de la tasa del día',
    puesta.status === 201 && puesta.body?.rateDate === hoy,
    `status ${puesta.status} · ${String(puesta.body?.rateMicros)} micros`,
  );
  tasa = puesta.body ?? null;
} else {
  console.log(`· La tasa de hoy ya estaba publicada (${tasa.rateDate}): se reutiliza.`);
}
check(
  'hay una tasa publicada y vigente para hoy',
  typeof tasa?.rateMicros === 'number' && tasa.rateMicros > 0,
  `${String(tasa?.rateMicros)} micros · ${String(tasa?.rateDate)}`,
);

/* ── 8) Emitir ─────────────────────────────────────────────────────────────── */

const emitida = await call(`/api/v1/billing/drafts/${resumen.id}/issue`, {
  method: 'POST',
  body: JSON.stringify({ confirm: true }),
});
check('la factura se emite', emitida.status === 200, `status ${emitida.status}`);
if (emitida.status !== 200) {
  console.error(`\nNo se pudo emitir: ${JSON.stringify(emitida.body).slice(0, 300)}`);
  process.exit(1);
}

const invoiceId = emitida.body?.id;
const numero = emitida.body?.numberLabel;
check(
  'toma los dos números: el correlativo de la serie y el control de la forma',
  emitida.body?.invoiceNumber > 0 &&
    numero === `${series}-${String(emitida.body?.invoiceNumber).padStart(6, '0')}` &&
    typeof emitida.body?.controlNumber === 'string' &&
    emitida.body.controlNumber === loteActivo?.nextControl,
  `${String(numero)} · control ${String(emitida.body?.controlNumber)}`,
);
check(
  'congela la tasa y calcula los bolívares con ella',
  emitida.body?.exchangeRateMicros === tasa.rateMicros && emitida.body?.totalVesCentimos > 0,
  `tasa ${String(emitida.body?.exchangeRateMicros)} micros · Bs. ${(emitida.body?.totalVesCentimos / 100).toFixed(2)}`,
);
check(
  'archiva el PDF con su huella',
  esHuella(emitida.body?.pdfSha256),
  String(emitida.body?.pdfSha256),
);

const loteDespues = (await listaLotes()).find((item) => item.id === loteActivo?.id) ?? null;
check(
  'la forma se consume en orden',
  loteActivo === null ||
    (loteDespues !== null &&
      (loteDespues.remaining === 0 ||
        Number(loteDespues.nextControl) === Number(loteActivo.nextControl) + 1)),
  `${String(loteActivo?.nextControl)} → ${String(loteDespues?.nextControl ?? 'lote agotado')}`,
);

const pdf = buscarPdf(emitida.body?.pdfSha256 ?? '');
check(
  'el PDF está en el almacén y es un PDF',
  pdf !== null && claroDe(pdf)?.subarray(0, 4).toString('latin1') === '%PDF',
  pdf ?? `no se encontró en ${ALMACEN}`,
);

/* ── 9) Cobrar: en bolívares y en divisas ──────────────────────────────────── */

const total = emitida.body?.totalCentsUsd ?? 0;
const totalVes = emitida.body?.totalVesCentimos ?? 0;

const enBolivares = await call(`/api/v1/billing/invoices/${invoiceId}/payments`, {
  method: 'POST',
  body: JSON.stringify({
    method: 'pago_movil',
    // La mitad, en bolívares: la mitad de lo impreso.
    tenderedAmount: Math.floor(totalVes / 2),
    reference: 'op-prueba-0001',
    confirmRate: true,
  }),
});
check(
  'el cobro en bolívares se imputa con la tasa del pago',
  enBolivares.status === 200 &&
    enBolivares.body?.payment?.imputationPolicy === 'tasa_del_pago' &&
    enBolivares.body?.payment?.tenderedCurrency === 'VES' &&
    enBolivares.body?.payment?.exchangeRateMicros === tasa.rateMicros,
  `status ${enBolivares.status} · ${String(enBolivares.body?.payment?.imputationPolicy)}`,
);
check(
  'el recibo sale numerado y archivado',
  /^REC-\d{6}$/.test(enBolivares.body?.payment?.receiptLabel ?? '') &&
    esHuella(enBolivares.body?.payment?.pdfSha256),
  String(enBolivares.body?.payment?.receiptLabel),
);
check(
  'la factura queda abonada, con saldo mayor que cero y menor que el total',
  enBolivares.body?.invoice?.status === 'parcial' &&
    enBolivares.body.invoice.balanceCentsUsd > 0 &&
    enBolivares.body.invoice.balanceCentsUsd < total,
  `status ${String(enBolivares.body?.invoice?.status)} · saldo US$ ${((enBolivares.body?.invoice?.balanceCentsUsd ?? 0) / 100).toFixed(2)}`,
);

const saldo = enBolivares.body?.invoice?.balanceCentsUsd ?? 0;
const enDivisas = await call(`/api/v1/billing/invoices/${invoiceId}/payments`, {
  method: 'POST',
  body: JSON.stringify({
    method: 'cash_usd',
    tenderedAmount: saldo,
    reference: null,
    confirmRate: true,
  }),
});
check(
  'el cobro en divisas liquida la deuda',
  enDivisas.status === 200 &&
    enDivisas.body?.invoice?.status === 'pagada' &&
    enDivisas.body?.invoice?.balanceCentsUsd === 0,
  `status ${enDivisas.status} · saldo US$ ${((enDivisas.body?.invoice?.balanceCentsUsd ?? 0) / 100).toFixed(2)}`,
);
check(
  'la clínica es contribuyente ordinario: no percibe IGTF',
  enDivisas.body?.payment?.appliesIgtf === false &&
    enDivisas.body?.payment?.igtfAmountCentsUsd === 0,
  `IGTF US$ ${((enDivisas.body?.payment?.igtfAmountCentsUsd ?? 0) / 100).toFixed(2)}`,
);

/* ── 10) La factura con sus cobros ─────────────────────────────────────────── */

const factura = await call(`/api/v1/billing/invoices/${invoiceId}`);
check(
  'el historial muestra la factura pagada con sus dos cobros',
  factura.status === 200 &&
    factura.body?.status === 'pagada' &&
    factura.body?.balanceCentsUsd === 0 &&
    factura.body?.payments?.length === 2,
  `status ${String(factura.body?.status)} · ${String(factura.body?.payments?.length)} cobro(s)`,
);
check(
  'cada recibo queda archivado con su huella',
  (factura.body?.payments ?? []).length === 2 &&
    factura.body.payments.every(
      (pago) => esHuella(pago.pdfSha256) && buscarPdf(pago.pdfSha256) !== null,
    ),
  (factura.body?.payments ?? [])
    .map((pago) => `${String(pago.receiptLabel)} ${String(pago.pdfSha256).slice(0, 8)}`)
    .join(' · '),
);

/* ── 11) Auditoría ─────────────────────────────────────────────────────────── */

const eventosFactura = await esperarAuditoria(
  `entityType=invoice&entityId=${invoiceId}&action=invoice_issued&pageSize=50`,
);
check(
  'la auditoría registra la emisión',
  eventosFactura.length > 0,
  `${eventosFactura.length} evento(s)`,
);
check(
  'el asiento de la emisión dice el número y el actor',
  eventosFactura[0]?.summary?.includes(String(numero)) === true &&
    eventosFactura[0]?.actorUsername === credentials.username,
  String(eventosFactura[0]?.summary),
);

const eventosCobro = await esperarAuditoria(
  `entityType=payment&entityId=${enBolivares.body?.payment?.id}&action=payment_received&pageSize=50`,
);
check(
  'la auditoría registra el cobro, con el antes y el después del saldo',
  eventosCobro.length > 0 &&
    (eventosCobro[0]?.before ?? {}).balanceCentsUsd === total &&
    (eventosCobro[0]?.after ?? {}).balanceCentsUsd === saldo,
  `${String(eventosCobro[0]?.before?.balanceCentsUsd)} → ${String(eventosCobro[0]?.after?.balanceCentsUsd)}`,
);

/* ── 12) Limpieza ──────────────────────────────────────────────────────────── */

// La factura es un **documento fiscal**: se queda (se anularía con nota de crédito, no se borra).
const borrado = await call(`/api/v1/patients/${patientId}/delete`, {
  method: 'POST',
  body: JSON.stringify({ reason: `${MARK}: limpieza de la prueba` }),
});
check(
  'el paciente de la prueba queda con borrado lógico',
  borrado.status === 200 && typeof borrado.body?.deletedAt === 'string',
  `status ${borrado.status}`,
);

/* ── 13) Resumen ───────────────────────────────────────────────────────────── */

console.log(
  `\nFactura ${String(numero)} (control ${String(emitida.body?.controlNumber)}) · US$ ${(total / 100).toFixed(2)}` +
    ` · Bs. ${(totalVes / 100).toFixed(2)} · ${String(invoiceId)}`,
);
console.log('Recuerda: npm run seed:users -- --reset  (restaura las contraseñas sembradas)');
if (failures > 0) {
  console.error(`${String(failures)} comprobación(es) fallaron contra ${GATEWAY}`);
  process.exit(1);
}
console.log('Prueba de humo de facturación — emitir y cobrar — en verde ✔');
