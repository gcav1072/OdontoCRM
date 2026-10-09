#!/usr/bin/env node
/**
 * Prueba de humo de la Fase 9 (reportes, KPIs y auditoría) contra el gateway real.
 *
 * El read model de `reporting` se alimenta **por eventos**, así que la prueba
 * provoca datos de verdad y después los busca en los reportes: paciente ficticio
 * con el teléfono editado (cambio auditado con `before`/`after`), solicitud →
 * cita de hoy → aviso en lote → llegada, llamado, consulta y «atendido», historia
 * clínica firmada con diabetes y alergia a la penicilina, sesión cerrada con su
 * procedimiento del catálogo, récipe emitido con dos medicamentos y tres
 * hallazgos del odontograma (caries, restauración y ausente).
 *
 *   npm run build && npm run db:migrate && npm run seed:demo
 *   npm run stack:fijo        # o: npm run dev
 *   npm run smoke:reporting
 *
 * ⚠️ Cambia la contraseña del administrador y la de la secretaría sembrados.
 * Al terminar, restáuralas:  npm run seed:users -- --reset
 *
 * Lo que deja: la cita queda **atendida** (es historial, no se borra), con su
 * solicitud, historia, sesión, récipe emitido y odontograma; el paciente de la
 * prueba queda con **borrado lógico** al final.
 */
import { connect } from 'node:net';

/* ── Configuración ─────────────────────────────────────────────────────────── */

const GATEWAY = process.env.SMOKE_GATEWAY_URL ?? 'http://127.0.0.1:8090';
const credentials = {
  username: process.env.SMOKE_USERNAME ?? 'admin',
  password: process.env.SMOKE_PASSWORD ?? 'admin-odontocrm-2026',
};
const NEW_PASSWORD = process.env.SMOKE_NEW_PASSWORD ?? 'prueba-e2e-odontocrm-2026';
const SECRETARIA_PASSWORD = process.env.SMOKE_SECRETARY_PASSWORD ?? 'recepcion-odontocrm-2026';
const MARK = 'PRUEBA DE HUMO REPORTES';
/** El cambio auditado que la prueba persigue: teléfono antes y después, con motivo. */
const PHONE_BEFORE = '0414-0000000';
const PHONE_AFTER = '0414-9998877';
const PHONE_REASON = 'Prueba de humo: el paciente cambió de teléfono';
/** Cédula ficticia del rango reservado 97.000.000+, distinta en cada corrida. */
const DOC = { type: 'V', number: `97${String(Date.now()).slice(-6)}` };
/** Nacido en 1980 → 46 años: cae en el tramo 41-65 y dentro del filtro 40-50. */
const BIRTH_DATE = '1980-03-10';
/** Hasta cuánto se espera a que la proyección del read model llegue (lotes de eventos). */
const ESPERA_PROYECCION_MS = Number(process.env.SMOKE_REPORTING_WAIT_MS ?? 15_000);
/** Catálogo cerrado de reportes (`REPORT_KEYS` de `@odontocrm/contracts`). */
const REPORT_KEYS = [
  'funnel',
  'capacity',
  'demographics',
  'clinical-profile',
  'oral-health',
  'prescriptions',
];

let token = '';
let failures = 0;

/* ── Utilidades ────────────────────────────────────────────────────────────── */

/**
 * Petición por el gateway. `options.token` permite usar el de **otra** sesión sin
 * tocar la global (lo necesita la comprobación de permisos de la secretaría) y un
 * fallo de red se devuelve como `status: 0` en vez de tumbar la prueba.
 */
const call = async (path, options = {}) => {
  const { token: tokenExplicito, ...resto } = options;
  const usado = tokenExplicito ?? token;
  try {
    const response = await fetch(`${GATEWAY}${path}`, {
      ...resto,
      signal: resto.signal ?? AbortSignal.timeout(30_000),
      headers: {
        ...(usado === '' ? {} : { authorization: `Bearer ${usado}` }),
        ...(resto.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(resto.headers ?? {}),
      },
    });
    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text.slice(0, 200);
    }
    return { status: response.status, body, bytes: text.length };
  } catch (error) {
    return { status: 0, body: String(error).slice(0, 200), bytes: 0 };
  }
};

/** Descarga binaria (CSV y PDF de los reportes): no se parsea como JSON. */
const descargar = async (path, opciones = {}) => {
  const usado = opciones.token ?? token;
  try {
    const response = await fetch(`${GATEWAY}${path}`, {
      headers: usado === '' ? {} : { authorization: `Bearer ${usado}` },
      signal: AbortSignal.timeout(60_000),
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    return {
      status: response.status,
      type: response.headers.get('content-type') ?? '',
      buffer,
      texto: buffer.toString('utf8'),
    };
  } catch (error) {
    return { status: 0, type: '', buffer: Buffer.alloc(0), texto: String(error).slice(0, 200) };
  }
};

const check = (etiqueta, condicion, detalle = '') => {
  if (!condicion) failures += 1;
  console.log(`${condicion ? '✔' : '✖'} ${etiqueta}${detalle === '' ? '' : ` → ${detalle}`}`);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** ¿Hay alguien escuchando en el puerto del gateway? */
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

/** Hoy en la zona del consultorio (America/Caracas, UTC−4), como lo hace el servidor. */
const hoy = new Date(Date.now() - 4 * 3_600_000).toISOString().slice(0, 10);
const haceDias = (dias) =>
  new Date(Date.parse(`${hoy}T00:00:00Z`) + dias * 86_400_000).toISOString().slice(0, 10);

const aMinutos = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const enHora = (minutos) =>
  `${String(Math.floor(minutos / 60)).padStart(2, '0')}:${String(minutos % 60).padStart(2, '0')}`;

/* ── Lectura de un documento de reporte ────────────────────────────────────── */

/** Normaliza un texto para comparar sin acentos ni mayúsculas. */
const llano = (texto) =>
  String(texto ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

/** Cifra del documento cuyo rótulo coincide con el patrón («solicitudes», «atendidas»…). */
const kpiDe = (documento, patron) =>
  (documento?.kpis ?? []).find((cifra) => patron.test(llano(cifra.label)));

/** Valor numérico de una cifra del reporte (`12`, `'12'`, `'12 citas'`, `'85 %'`). */
const numero = (valor) => {
  if (typeof valor === 'number') return valor;
  const coincidencia = /-?\d+(?:[.,]\d+)?/.exec(String(valor ?? ''));
  return coincidencia === null ? Number.NaN : Number(coincidencia[0].replace(',', '.'));
};

/** Número de la cifra que coincide con el patrón (`NaN` si no está). */
const kpiNumero = (documento, patron) => numero(kpiDe(documento, patron)?.value);

/** Todas las filas de la tabla del documento, ya como texto legible. */
const filasTexto = (documento) => {
  const columnas = documento?.table?.columns ?? [];
  return (documento?.table?.rows ?? []).map((fila) =>
    columnas.map((columna) => String(fila[columna.key] ?? '')).join(' · '),
  );
};

/** Los puntos de las series del documento como texto (`36 · caries · 2`). */
const puntosTexto = (documento) =>
  (documento?.series ?? []).flatMap((serie) =>
    (serie.points ?? []).map(
      (punto) => `${String(punto.x)} · ${String(punto.group ?? '')} · ${String(punto.y)}`,
    ),
  );

/**
 * Fila (o punto) que menciona un texto, con el número de su columna de conteo:
 * es lo que permite comprobar «dos medicamentos, con conteo ≥ 1» sin adivinar el
 * rótulo de la columna.
 */
const filaDe = (documento, patron) => {
  const columnas = documento?.table?.columns ?? [];
  for (const fila of documento?.table?.rows ?? []) {
    const texto = columnas.map((columna) => String(fila[columna.key] ?? '')).join(' · ');
    if (!patron.test(llano(texto))) continue;
    const deConteo = columnas.find((columna) =>
      /recet|conteo|total|cantidad|casos|pacientes|veces|numero|nº/.test(llano(columna.label)),
    );
    const numeros = [...texto.matchAll(/\d+(?:[.,]\d+)?/g)].map((m) =>
      Number(m[0].replace(',', '.')),
    );
    const conteo =
      deConteo === undefined
        ? numeros.length === 0
          ? 0
          : Math.max(...numeros)
        : numero(fila[deConteo.key]);
    return { texto, conteo };
  }
  const punto = puntosTexto(documento).find((linea) => patron.test(llano(linea)));
  if (punto === undefined) return { texto: '', conteo: 0 };
  return { texto: punto, conteo: numero(/(\d+(?:[.,]\d+)?)$/.exec(punto)?.[1]) };
};

/** Primeras filas del reporte: sirven de pista cuando una comprobación falla. */
const pista = (documento) => filasTexto(documento).slice(0, 3).join(' | ') || '(sin filas)';

/** Primera línea de un CSV, sin el BOM: es la cabecera que se enseña al fallar. */
const primeraLineaDe = (texto) =>
  (texto.replace(/^\uFEFF/, '').split('\r\n')[0] ?? '').slice(0, 90);

/** ¿El reporte menciona esa pieza con esa condición? (odontograma por pieza). */
const piezaConCondicion = (documento, pieza, condicion) =>
  [...filasTexto(documento), ...puntosTexto(documento)].filter(
    (linea) => new RegExp(`\\b${pieza}\\b`).test(linea) && condicion.test(llano(linea)),
  );

/**
 * Espera a que el read model tenga la cifra pedida: sondea con reintentos hasta
 * `limiteMs` (por defecto `ESPERA_PROYECCION_MS`). Devuelve la última respuesta,
 * liste o no.
 */
const esperarReporte = async (path, listo, etiqueta, limiteMs = ESPERA_PROYECCION_MS) => {
  const limite = Date.now() + limiteMs;
  let ultima = await call(path);
  // Sin ruta no hay proyección que esperar (el servicio todavía no está): se falla ya.
  if (ultima.status === 404) return ultima;
  while (!(ultima.status === 200 && listo(ultima.body))) {
    if (Date.now() >= limite) {
      console.log(
        `· ${etiqueta}: la proyección no llegó en ${String(limiteMs / 1000)} s (último status ${String(ultima.status)})`,
      );
      return ultima;
    }
    await sleep(500);
    ultima = await call(path);
  }
  return ultima;
};

/** Espera a que la auditoría muestre el evento (el outbox no es instantáneo). */
const esperarAuditoria = async (query) => {
  for (let intento = 0; intento < 40; intento += 1) {
    const respuesta = await call(`/api/v1/audit/events?${query}`);
    const items = respuesta.body?.items ?? [];
    if (items.length > 0) return items;
    await sleep(250);
  }
  return [];
};

/* ── 0) ¿Está la pila en pie? ──────────────────────────────────────────────── */

if (!(await escucha(GATEWAY))) {
  console.error(
    `smoke:reporting: no hay nada escuchando en ${GATEWAY}.\n` +
      '  · Arranca la pila:  npm run stack:fijo   (PM2)\n' +
      '                      npm run dev          (todo en una terminal)\n' +
      '  · Comprueba el modo: npm run stack:status\n' +
      '  · Si falta el read model: npm run build && npm run db:migrate && npm run seed:demo',
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

/* ── 2) Paciente ficticio + edición del teléfono con motivo ────────────────── */

const creado = await call('/api/v1/patients', {
  method: 'POST',
  body: JSON.stringify({
    docType: DOC.type,
    docNumber: DOC.number,
    fullName: `PACIENTE ${MARK}`,
    birthDate: BIRTH_DATE,
    sex: 'M',
    phone: PHONE_BEFORE,
    address: 'Dirección de la prueba de humo de reportes',
    notes: null,
  }),
});
check('el paciente de la prueba se registra', creado.status === 201, `status ${creado.status}`);
const patientId = creado.body?.id;
if (typeof patientId !== 'string') {
  console.error('\nSin paciente no hay nada que reportar: se detiene la prueba.');
  process.exit(1);
}
const documento = creado.body?.document ?? `${DOC.type}-${DOC.number}`;
const patientName = creado.body?.fullName ?? `PACIENTE ${MARK}`;
check(
  'nace con el teléfono normalizado (el «antes» del cambio auditado)',
  creado.body?.phone === '+584140000000',
  String(creado.body?.phone),
);

const editado = await call(`/api/v1/patients/${patientId}`, {
  method: 'PATCH',
  body: JSON.stringify({ phone: PHONE_AFTER, reason: PHONE_REASON }),
});
check(
  'el teléfono se edita con motivo (queda auditable)',
  editado.status === 200 && editado.body?.phone === '+584149998877',
  `status ${editado.status} · ${String(editado.body?.phone)}`,
);

/* ── 3) La cita de hoy: solicitud → asignación → aviso en lote → flujo ─────── */

const citasDeHoy = await call(`/api/v1/appointments?date=${hoy}&pageSize=200`);
const ocupadas = citasDeHoy.body?.items ?? [];
const libre = (minuto) =>
  !ocupadas.some(
    (cita) => aMinutos(cita.startTime) < minuto + 30 && aMinutos(cita.endTime) > minuto,
  );

let hora = null;
for (let minuto = 7 * 60; hora === null && minuto <= 19 * 60; minuto += 30) {
  if (libre(minuto)) hora = enHora(minuto);
}
check('hay una hora libre hoy para la cita de la prueba', hora !== null, String(hora));
if (hora === null) process.exit(1);

/** El cupo del día tiene que dar cabida a la cita (y la ocupación se reporta). */
const jornada = await call(`/api/v1/agenda/days/${hoy}`);
const cupo = jornada.body?.capacity ?? {};
const cupoNecesario = Math.max(4, (cupo.assigned ?? 0) + 1);
if ((cupo.capacity ?? 0) < cupoNecesario) {
  const ampliado = await call('/api/v1/agenda/capacity', {
    method: 'PUT',
    body: JSON.stringify({
      date: hoy,
      capacity: cupoNecesario + 1,
      notes: MARK,
      reason: `${MARK}: la prueba necesita cupo hoy`,
    }),
  });
  console.log(
    `· El cupo de hoy se amplía a ${String(ampliado.body?.capacity ?? cupoNecesario + 1)} para que quepa la cita.`,
  );
}

const solicitud = await call('/api/v1/requests', {
  method: 'POST',
  body: JSON.stringify({
    patientId,
    patientName,
    patientDocument: documento,
    patientPhone: '+584140000000',
    channel: 'telefono',
    reason: `${MARK}: dolor en la muela del juicio`,
    priority: 0,
    notes: MARK,
  }),
});
check(
  'la solicitud nace con su ticket',
  solicitud.status === 201 && /^#\d{6}$/.test(solicitud.body?.ticket ?? ''),
  `status ${solicitud.status} · ${String(solicitud.body?.ticket)}`,
);
const requestId = solicitud.body?.id;

const cita = await call('/api/v1/appointments', {
  method: 'POST',
  body: JSON.stringify({
    requestId,
    date: hoy,
    startTime: hora,
    slotKind: 'manual',
    durationMinutes: 30,
    notes: MARK,
  }),
});
check(
  'la cita se asigna a hoy (el embudo y la ocupación la cuentan)',
  cita.status === 201 && cita.body?.status === 'programada',
  `status ${cita.status} · ${String(cita.body?.startTime ?? hora)}`,
);
const appointmentId = cita.body?.id;
if (typeof appointmentId !== 'string') {
  console.error('\nSin cita no se puede completar el flujo: se detiene la prueba.');
  process.exit(1);
}

const aviso = await call('/api/v1/agenda/notify', {
  method: 'POST',
  body: JSON.stringify({ date: hoy, force: false }),
});
check(
  'el aviso en lote del día responde',
  aviso.status === 200,
  `status ${aviso.status} · notificadas ${String(aviso.body?.notified)}`,
);

/* ── 4) Historia clínica: anamnesis con diabetes y penicilina, firmada ─────── */

const historia = await call(`/api/v1/clinical/patients/${patientId}/record`, { method: 'POST' });
check(
  'la historia clínica se abre',
  historia.status === 201 || historia.status === 200,
  `status ${historia.status}`,
);
const recordId = historia.body?.id;
if (typeof recordId !== 'string') {
  console.error('\nSin historia clínica no hay perfil clínico: se detiene la prueba.');
  process.exit(1);
}

/** Secciones que la firma exige (plan §6 y `CLINICAL_SIGNATURE_SECTIONS`). */
const secciones = {
  motivo_consulta: {
    relato: 'Viene por dolor en la muela del juicio desde hace una semana.',
    tiempoEvolucion: 'una semana',
    inicioSintomas: null,
  },
  anamnesis: {
    sinAntecedentes: false,
    alergias: { items: ['penicilina'], otros: null },
    patologicos: { items: ['diabetes'], otros: null },
    medicamentos: { items: [], otros: null },
    cirugias: { items: [], otros: null },
    familiares: { items: [], otros: null },
    habitos: { items: [], otros: null },
    observaciones: `${MARK}: diabetes y alergia a la penicilina declaradas`,
  },
  examen_extraoral: {
    tejidosBlandos: 'normal',
    ganglios: 'normal',
    atm: 'normal',
    musculatura: 'normal',
    hallazgos: null,
    observaciones: null,
  },
  examen_intraoral: {
    tejidosBlandos: 'normal',
    encias: 'alterado',
    sondaje: null,
    oclusion: 'normal',
    higiene: 'regular',
    hallazgos: 'Caries oclusal en la pieza 36',
    observaciones: null,
  },
  diagnostico: {
    principal: 'Caries oclusal en la pieza 36',
    secundarios: null,
    porPieza: '36: caries oclusal',
    saludBucalGeneral: 'regular',
    observaciones: null,
  },
  plan_tratamiento: {
    procedimientos: [
      { descripcion: 'Obturación con resina en la pieza 36', prioridad: 'alta', pieza: '36' },
    ],
    alternativas: null,
    aceptacionPaciente: true,
    observaciones: null,
  },
};

let ultimaSeccion = null;
for (const [clave, content] of Object.entries(secciones)) {
  ultimaSeccion = await call(`/api/v1/clinical/records/${recordId}/sections/${clave}`, {
    method: 'PUT',
    body: JSON.stringify({ content }),
  });
  if (ultimaSeccion.status !== 200) break;
}
check(
  'las secciones de la historia se guardan',
  ultimaSeccion?.status === 200,
  `status ${ultimaSeccion?.status}`,
);

const alertas = (ultimaSeccion?.body?.alerts ?? []).map((alerta) => alerta.code);
check(
  'la anamnesis deja sus alertas clínicas (diabetes y penicilina)',
  alertas.includes('diabetes') && alertas.includes('alergia_penicilina'),
  alertas.join(', ') || '(sin alertas)',
);

const consentimiento = await call(`/api/v1/clinical/records/${recordId}/consent`, {
  method: 'PUT',
  body: JSON.stringify({
    accepted: true,
    acceptedByName: patientName,
    acceptedByDocument: documento,
    relationship: 'el propio paciente',
    witnessName: null,
    notes: MARK,
  }),
});
check(
  'el consentimiento informado se registra',
  consentimiento.status === 200,
  `status ${consentimiento.status}`,
);

const firmada = await call(`/api/v1/clinical/records/${recordId}/sign`, {
  method: 'POST',
  body: JSON.stringify({ confirm: true }),
});
check(
  'la historia clínica se firma',
  firmada.status === 200 && firmada.body?.status === 'firmada',
  `status ${firmada.status} · ${String(firmada.body?.status)}`,
);

/* ── 5) Sesión clínica con procedimiento, cerrada ──────────────────────────── */

const abierta = await call(`/api/v1/clinical/patients/${patientId}/sessions`, {
  method: 'POST',
  body: JSON.stringify({ appointmentId, motivo: `${MARK}: dolor en la 36` }),
});
check(
  'la sesión clínica se abre enlazada a la cita',
  (abierta.status === 201 || abierta.status === 200) &&
    abierta.body?.appointmentId === appointmentId,
  `status ${abierta.status}`,
);
const sessionId = abierta.body?.id;
if (typeof sessionId !== 'string') {
  console.error('\nSin sesión no hay récipe ni «atendido»: se detiene la prueba.');
  process.exit(1);
}

const guardada = await call(`/api/v1/clinical/sessions/${sessionId}`, {
  method: 'PUT',
  body: JSON.stringify({
    content: {
      motivo: 'Dolor a la masticación en la pieza 36',
      anamnesis: 'Refiere diabetes controlada y alergia a la penicilina.',
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
        encias: 'alterado',
        sondaje: null,
        oclusion: 'normal',
        higiene: 'regular',
        hallazgos: 'Caries oclusal profunda en la 36',
      },
      procedimientos: [
        { code: 'obturacion_resina', toothNumber: 36, surfaces: ['occlusal'], notas: MARK },
      ],
      materiales: [{ code: 'resina_compuesta', cantidad: '1' }],
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
  `status ${guardada.status}`,
);

/* ── 6) Récipe emitido con dos medicamentos ────────────────────────────────── */

const borrador = await call(`/api/v1/clinical/sessions/${sessionId}/prescription`, {
  method: 'PUT',
  body: JSON.stringify({
    items: [
      {
        medicationName: 'Amoxicilina',
        presentation: 'Tabletas 500 mg',
        route: 'oral',
        dose: '500 mg',
        frequency: 'cada 8 horas',
        duration: '7 días',
        instructions: 'Después de las comidas',
        quantity: '21 tabletas',
      },
      {
        medicationName: 'Ibuprofeno',
        presentation: 'Tabletas 400 mg',
        route: 'oral',
        dose: '400 mg',
        frequency: 'cada 8 horas',
        duration: '3 días',
        instructions: null,
        quantity: null,
      },
    ],
    generalInstructions: 'Volver si el dolor no cede en 48 horas.',
  }),
});
check(
  'el récipe se prepara con sus dos medicamentos',
  borrador.status === 200 && borrador.body?.itemCount === 2,
  `status ${borrador.status} · ${String(borrador.body?.itemCount)} medicamento(s)`,
);
const prescriptionId = borrador.body?.id;

const emitido = await call(`/api/v1/clinical/prescriptions/${prescriptionId}/issue`, {
  method: 'POST',
  body: JSON.stringify({ confirm: true }),
});
check(
  'el récipe se emite (lo que cuenta el reporte)',
  emitido.status === 200 && /^RX-\d{6}$/.test(emitido.body?.number ?? ''),
  `${String(emitido.body?.number)} · status ${emitido.status}`,
);

const cerrada = await call(`/api/v1/clinical/sessions/${sessionId}/close`, {
  method: 'POST',
  body: JSON.stringify({ confirm: true, closureNote: `${MARK}: sin molestias` }),
});
check(
  'la sesión clínica se cierra',
  cerrada.status === 200 && cerrada.body?.status === 'cerrada',
  `status ${cerrada.status} · ${String(cerrada.body?.status)}`,
);

/* ── 7) Odontograma: caries, restauración y ausente ────────────────────────── */

const hallazgos = await call(`/api/v1/odontogram/patients/${patientId}/findings/batch`, {
  method: 'POST',
  body: JSON.stringify({
    findings: [
      { toothNumber: 36, surface: 'occlusal', condition: 'caries', state: 'pendiente' },
      { toothNumber: 24, surface: 'vestibular', condition: 'restauracion', state: 'completado' },
      { toothNumber: 48, surface: null, condition: 'ausente', state: 'completado' },
    ],
  }),
});
check(
  'el odontograma registra las tres piezas (caries 36, restauración 24 y ausente 48)',
  hallazgos.status === 200 && hallazgos.body?.odontogram?.affectedTeeth?.length === 3,
  `status ${hallazgos.status} · piezas ${JSON.stringify(hallazgos.body?.odontogram?.affectedTeeth)}`,
);

/* ── 8) Llegada, llamado, consulta y «atendido» ────────────────────────────── */

const llegada = await call(`/api/v1/appointments/${appointmentId}/check-in`, { method: 'POST' });
check(
  'la llegada se registra',
  llegada.status === 200 && llegada.body?.status === 'en_sala_espera',
  `status ${llegada.status}`,
);

const llamado = await call(`/api/v1/appointments/${appointmentId}/call`, { method: 'POST' });
check(
  'el paciente se llama',
  llamado.status === 200 && llamado.body?.status === 'llamado',
  `status ${llamado.status}`,
);

const consulta = await call(`/api/v1/appointments/${appointmentId}/start`, { method: 'POST' });
check(
  'el paciente pasa a consulta',
  consulta.status === 200 && consulta.body?.status === 'en_consulta',
  `status ${consulta.status}`,
);

const atendido = await call(`/api/v1/appointments/${appointmentId}/attend`, {
  method: 'POST',
  body: JSON.stringify({ clinicalSessionId: sessionId }),
});
check(
  'la cita se marca atendida con su sesión cerrada',
  atendido.status === 200 &&
    atendido.body?.status === 'atendido' &&
    atendido.body?.clinicalSessionId === sessionId,
  `status ${atendido.status} · sesión ${String(atendido.body?.clinicalSessionId)}`,
);

/* ── 9) Los reportes: se espera la proyección y se comprueban las cifras ───── */

const desde = haceDias(-29);

const resumen = await esperarReporte(
  '/api/v1/reports/summary',
  (body) => (body?.appointments?.attended ?? 0) >= 1,
  'el tablero del día',
);
check('el tablero del día responde 200', resumen.status === 200, `status ${resumen.status}`);
check(
  'el tablero trae la fecha de hoy',
  resumen.body?.date === hoy,
  `date ${String(resumen.body?.date)} · hoy ${hoy}`,
);
const cupoTablero = resumen.body?.capacity ?? {};
check(
  'el cupo del día es coherente y cuenta la cita de la prueba',
  Number.isInteger(cupoTablero.capacity) &&
    cupoTablero.capacity >= 1 &&
    Number.isInteger(cupoTablero.assigned) &&
    cupoTablero.assigned >= 1 &&
    Number.isInteger(cupoTablero.freeSlots),
  `cupo ${String(cupoTablero.capacity)} · asignadas ${String(cupoTablero.assigned)} · libres ${String(cupoTablero.freeSlots)}`,
);
check(
  'el tablero cuenta la cita atendida de la prueba',
  (resumen.body?.appointments?.attended ?? 0) >= 1,
  `atendidas ${String(resumen.body?.appointments?.attended)}`,
);

/* 9.1) Los seis reportes devuelven su documento. */
const documentos = new Map();
for (const key of REPORT_KEYS) {
  const documento = await esperarReporte(
    `/api/v1/reports/${key}?from=${desde}&to=${hoy}`,
    (body) => Array.isArray(body?.kpis) && (body?.table?.columns ?? []).length >= 1,
    `el reporte «${key}»`,
  );
  documentos.set(key, documento);
  check(
    `el reporte «${key}» responde con su documento`,
    documento.status === 200 &&
      documento.body?.key === key &&
      (documento.body?.table?.columns ?? []).length >= 1,
    `status ${documento.status}${documento.status === 200 ? '' : ` · ${String(documento.body).slice(0, 80)}`}`,
  );
}

/* 9.2) Embudo: solicitudes, programadas y atendidas ≥ 1, con su tabla. */
const embudo = documentos.get('funnel');
check(
  'el embudo respeta el rango pedido',
  embudo?.body?.range?.from === desde && embudo?.body?.range?.to === hoy,
  `${String(embudo?.body?.range?.from)} → ${String(embudo?.body?.range?.to)}`,
);
for (const [etiqueta, patron, minimo] of [
  ['la solicitud de la prueba', /solicit/, 1],
  ['la cita programada de la prueba', /programad|agendad/, 1],
  ['la cita atendida de la prueba', /atendid|asistid/, 1],
]) {
  check(
    `el embudo cuenta ${etiqueta}`,
    kpiNumero(embudo?.body, patron) >= minimo,
    `${String(kpiDe(embudo?.body, patron)?.label ?? '(sin cifra)')}: ${String(kpiDe(embudo?.body, patron)?.value)} · cifras ${(embudo?.body?.kpis ?? []).map((c) => c.label).join(', ')}`,
  );
}
check(
  'el embudo trae su tabla por período',
  (embudo?.body?.table?.rows ?? []).length >= 1,
  `${String((embudo?.body?.table?.rows ?? []).length)} fila(s) · ${pista(embudo?.body)}`,
);

/* 9.3) Ocupación: cupo del día y ocupación ≥ 1. */
const ocupacion = documentos.get('capacity');
const cupoKpi = kpiDe(ocupacion?.body, /cupo|capacidad|disponib|franja/);
const ocupadoKpi = kpiDe(ocupacion?.body, /ocupad|ocupa|asignad|usad|atendid/);
check(
  'el reporte de ocupación trae el cupo del día',
  numero(cupoKpi?.value) >= 1,
  `${String(cupoKpi?.label ?? '(sin cifra)')}: ${String(cupoKpi?.value)} · cifras ${(ocupacion?.body?.kpis ?? []).map((c) => c.label).join(', ')}`,
);
check(
  'el reporte de ocupación trae la ocupación del día (≥ 1)',
  numero(ocupadoKpi?.value) >= 1,
  `${String(ocupadoKpi?.label ?? '(sin cifra)')}: ${String(ocupadoKpi?.value)} · ${pista(ocupacion?.body)}`,
);

/* 9.4) Demografía: el paciente cae en su tramo y los filtros acotan. */
const demografiaSin = await call(`/api/v1/reports/demographics?from=${desde}&to=${hoy}`);
const totalDemografia = (documento) => {
  const cifra = kpiDe(documento, /pacient|total|registrad/);
  if (cifra !== undefined) return numero(cifra.value);
  return (documento?.series ?? [])
    .flatMap((serie) => serie.points ?? [])
    .reduce((suma, punto) => suma + (Number(punto.y) || 0), 0);
};
check(
  'la demografía responde sin filtros',
  demografiaSin.status === 200,
  `status ${demografiaSin.status}`,
);
check(
  'la demografía sin filtros cuenta a la población entera',
  totalDemografia(demografiaSin.body) >= 1,
  `total ${String(totalDemografia(demografiaSin.body))}`,
);

const demografiaFiltrada = await call(
  `/api/v1/reports/demographics?from=${desde}&to=${hoy}&ageMin=40&ageMax=50&sex=M`,
);
check(
  'la demografía con edad y sexo responde 200',
  demografiaFiltrada.status === 200,
  `status ${demografiaFiltrada.status}`,
);
const totalFiltrado = totalDemografia(demografiaFiltrada.body);
check(
  'el paciente creado entra en su tramo (40-50 y sexo M)',
  totalFiltrado >= 1,
  `total filtrado ${String(totalFiltrado)} · ${pista(demografiaFiltrada.body)}`,
);
/**
 * Las comprobaciones de filtros **no** dan por hecho que haya más de un paciente
 * (el read model solo tiene los que se han creado por la API en esta corrida):
 * lo que se comprueba es que el filtro **nunca suma** y que **reparte** la
 * población —hombres + mujeres = total, y los tramos de edad suman el total—,
 * que es cierto con cualquier volumen y falla si un filtro no se aplica.
 */
check(
  'los filtros de edad y sexo acotan las cifras (nunca suman)',
  totalFiltrado <= totalDemografia(demografiaSin.body),
  `${String(totalDemografia(demografiaSin.body))} sin filtro → ${String(totalFiltrado)} con 40-50 y M`,
);

const soloHombres = await call(`/api/v1/reports/demographics?from=${desde}&to=${hoy}&sex=M`);
const soloMujeres = await call(`/api/v1/reports/demographics?from=${desde}&to=${hoy}&sex=F`);
const otrosSexos = await call(`/api/v1/reports/demographics?from=${desde}&to=${hoy}&sex=O`);
const ninos = await call(`/api/v1/reports/demographics?from=${desde}&to=${hoy}&ageMin=0&ageMax=12`);
const adultos = await call(
  `/api/v1/reports/demographics?from=${desde}&to=${hoy}&ageMin=13&ageMax=120`,
);
check(
  'el filtro de sexo reparte la población (M + F + O = total)',
  totalDemografia(soloHombres.body) +
    totalDemografia(soloMujeres.body) +
    totalDemografia(otrosSexos.body) ===
    totalDemografia(demografiaSin.body),
  `M ${String(totalDemografia(soloHombres.body))} + F ${String(totalDemografia(soloMujeres.body))} + O ${String(totalDemografia(otrosSexos.body))} = total ${String(totalDemografia(demografiaSin.body))}`,
);
check(
  'el filtro de edad reparte la población (0-12 + 13-120 = total)',
  totalDemografia(ninos.body) + totalDemografia(adultos.body) ===
    totalDemografia(demografiaSin.body),
  `0-12 ${String(totalDemografia(ninos.body))} + 13+ ${String(totalDemografia(adultos.body))} = total ${String(totalDemografia(demografiaSin.body))}`,
);
const tramoPaciente = [
  ...filasTexto(demografiaFiltrada.body),
  ...puntosTexto(demografiaFiltrada.body),
].find((linea) => /41\s*(a|-|–|hasta)?\s*65/.test(llano(linea)));
/** La cuenta del tramo: los números de la línea sin el «41» ni el «65» del rótulo. */
const cuentaTramo =
  tramoPaciente === undefined
    ? 0
    : Math.max(
        0,
        ...[...tramoPaciente.matchAll(/\d+/g)]
          .map((coincidencia) => Number(coincidencia[0]))
          .filter((valor) => valor !== 41 && valor !== 65),
      );
check(
  'el tramo de edad del paciente (41-65) aparece con su cuenta',
  cuentaTramo >= 1,
  tramoPaciente ?? pista(demografiaFiltrada.body),
);
check(
  'el filtro de edad y sexo llega al documento (sus filtros resueltos)',
  numero(demografiaFiltrada.body?.filters?.ageMin) === 40 &&
    numero(demografiaFiltrada.body?.filters?.ageMax) === 50 &&
    demografiaFiltrada.body?.filters?.sex === 'M',
  JSON.stringify(demografiaFiltrada.body?.filters ?? {}),
);

/* 9.5) Perfil clínico: diabetes y alergias incluyen al paciente.
   La historia clínica se proyecta **en dos pasos**: el perfil se guarda de paso y se
   aplica cuando llega el alta del paciente, que la publica **otro servicio**. Medido
   con el humo, los eventos de la historia se procesaron a las 20:36:06 y el alta a
   las 20:36:07: un segundo, pero el retardo depende de los dos publicadores de
   outbox, así que aquí se espera con más margen que en el resto de reportes. */
const ESPERA_PERFIL_MS = Number(process.env.SMOKE_REPORTING_PROFILE_WAIT_MS ?? 30_000);
const perfil = await esperarReporte(
  `/api/v1/reports/clinical-profile?from=${desde}&to=${hoy}`,
  (cuerpo) => filaDe(cuerpo, /diabetes/).conteo >= 1,
  'el perfil clínico del paciente de la prueba',
  ESPERA_PERFIL_MS,
);
const diabetes = filaDe(perfil?.body, /diabetes/);
const alergias = filaDe(perfil?.body, /alerg/);
check(
  'el perfil clínico cuenta al diabético de la prueba',
  diabetes.conteo >= 1,
  `${diabetes.texto || '(sin fila de diabetes)'} · ${pista(perfil?.body)}`,
);
check(
  'el perfil clínico cuenta al alérgico a la penicilina',
  alergias.conteo >= 1,
  `${alergias.texto || '(sin fila de alergias)'} · ${pista(perfil?.body)}`,
);

/* 9.6) Salud bucal: la pieza con caries y la ausente aparecen. */
const bucal = documentos.get('oral-health');
const caries36 = piezaConCondicion(bucal?.body, 36, /caries/);
const ausente48 = piezaConCondicion(bucal?.body, 48, /ausente/);
check(
  'la salud bucal muestra la pieza 36 con caries',
  caries36.length >= 1,
  caries36[0] ?? pista(bucal?.body),
);
check(
  'la salud bucal muestra la pieza 48 ausente',
  ausente48.length >= 1,
  ausente48[0] ?? pista(bucal?.body),
);

/* 9.7) Recetas: los dos medicamentos, con conteo ≥ 1. */
const recetas = documentos.get('prescriptions');
const amoxicilina = filaDe(recetas?.body, /amoxicilina/);
const ibuprofeno = filaDe(recetas?.body, /ibuprofeno/);
check(
  'el reporte de récipes cuenta la amoxicilina',
  amoxicilina.conteo >= 1,
  `${amoxicilina.texto || '(sin fila)'} · ${pista(recetas?.body)}`,
);
check(
  'el reporte de récipes cuenta el ibuprofeno',
  ibuprofeno.conteo >= 1,
  `${ibuprofeno.texto || '(sin fila)'} · ${pista(recetas?.body)}`,
);

/* 9.8) Exportación: CSV con BOM y `;`, PDF con su cabecera. */
const csv = await descargar(`/api/v1/reports/funnel/export.csv?from=${desde}&to=${hoy}`);
check('la exportación CSV responde 200', csv.status === 200, `status ${csv.status}`);
check(
  'el CSV llega como text/csv',
  csv.type.includes('text/csv'),
  csv.type || '(sin content-type)',
);
check(
  'el CSV empieza por el BOM UTF-8 (Excel lo abre con acentos)',
  csv.buffer[0] === 0xef &&
    csv.buffer[1] === 0xbb &&
    csv.buffer[2] === 0xbf &&
    csv.texto.startsWith('\uFEFF'),
  `primeros bytes ${[...csv.buffer.subarray(0, 3)].map((b) => b.toString(16)).join(' ')}`,
);
const primeraLinea = csv.texto.split('\r\n')[0] ?? '';
check('el CSV usa «;» como separador', primeraLinea.includes(';'), primeraLinea.slice(0, 90));
const columnasEmbudo = (embudo?.body?.table?.columns ?? []).map((columna) => columna.label);
check(
  'el CSV es la tabla del reporte (mismas columnas)',
  columnasEmbudo.length > 0 && primeraLinea.includes(columnasEmbudo.join(';')),
  `cabecera «${primeraLinea.slice(0, 90)}» vs ${columnasEmbudo.join(';')}`,
);

const csvDeTodos = [];
for (const key of REPORT_KEYS) {
  csvDeTodos.push({
    key,
    ...(await descargar(`/api/v1/reports/${key}/export.csv?from=${desde}&to=${hoy}`)),
  });
}
const csvRotos = csvDeTodos.filter(
  (item) => item.status !== 200 || !item.type.includes('text/csv'),
);
check(
  'los seis reportes se exportan en CSV',
  csvRotos.length === 0,
  csvRotos.map((item) => `${item.key}: ${String(item.status)} ${item.type}`).join(' | ') ||
    'los seis en 200 text/csv',
);
const acento = csvDeTodos
  .map((item) => ({
    key: item.key,
    palabra: /[^\s;"\r\n]*[áéíóúüñÁÉÍÓÚÜÑ][^\s;"\r\n]*/u.exec(item.texto)?.[0] ?? null,
  }))
  .find((item) => item.palabra !== null);
check(
  'el CSV conserva los acentos (UTF-8 con BOM en Excel español)',
  acento !== undefined,
  acento === undefined
    ? 'ninguno de los seis CSV trajo una palabra con tilde'
    : `${acento.key}: «${acento.palabra}»`,
);

const pdf = await descargar(`/api/v1/reports/funnel/export.pdf?from=${desde}&to=${hoy}`);
check('la exportación PDF responde 200', pdf.status === 200, `status ${pdf.status}`);
check(
  'el PDF llega como application/pdf',
  pdf.type.includes('application/pdf'),
  pdf.type || '(sin content-type)',
);
check(
  'el PDF empieza por «%PDF»',
  pdf.buffer.subarray(0, 4).toString() === '%PDF',
  pdf.buffer.subarray(0, 8).toString('latin1'),
);

/* ── 10) Permisos: la secretaría ve los operativos y no los clínicos ───────── */

const secretaria = await (async () => {
  const conSembrada = await intentarLogin('recepcion', SECRETARIA_PASSWORD);
  if (conSembrada.status === 200 || SECRETARIA_PASSWORD === NEW_PASSWORD) return conSembrada;
  return intentarLogin('recepcion', NEW_PASSWORD);
})();

if (secretaria.status === 200) {
  let tokenSecretaria = secretaria.body?.accessToken ?? '';
  if (secretaria.body?.user?.mustChangePassword === true) {
    const cambiada = await call('/api/v1/auth/password/change', {
      method: 'POST',
      token: tokenSecretaria,
      body: JSON.stringify({
        currentPassword: SECRETARIA_PASSWORD,
        newPassword: NEW_PASSWORD,
        repeatPassword: NEW_PASSWORD,
      }),
    });
    check('la secretaría cambia su contraseña temporal', cambiada.status === 200);
    tokenSecretaria = cambiada.body?.accessToken ?? tokenSecretaria;
  }

  for (const [etiqueta, path] of [
    ['tablero', '/api/v1/reports/summary'],
    ['embudo', `/api/v1/reports/funnel?from=${desde}&to=${hoy}`],
    ['ocupación', `/api/v1/reports/capacity?from=${desde}&to=${hoy}`],
    ['demografía', `/api/v1/reports/demographics?from=${desde}&to=${hoy}`],
  ]) {
    const respuesta = await call(path, { token: tokenSecretaria });
    check(
      `la secretaría ve el reporte operativo «${etiqueta}»`,
      respuesta.status === 200,
      `status ${respuesta.status}`,
    );
  }

  for (const [etiqueta, key] of [
    ['perfil clínico', 'clinical-profile'],
    ['salud bucal', 'oral-health'],
    ['récipes', 'prescriptions'],
  ]) {
    const respuesta = await call(`/api/v1/reports/${key}?from=${desde}&to=${hoy}`, {
      token: tokenSecretaria,
    });
    check(
      `la secretaría NO ve el reporte clínico «${etiqueta}» (403)`,
      respuesta.status === 403,
      `status ${respuesta.status}`,
    );
  }

  await call('/api/v1/auth/logout', { method: 'POST', token: tokenSecretaria });
} else {
  check(
    'la secretaría está sembrada (se omite la comprobación de permisos)',
    false,
    `login status ${secretaria.status} · npm run seed:users -- --reset`,
  );
}

/* ── 11) Auditoría: el cambio de teléfono, con antes, después y motivo ─────── */

const eventos = await esperarAuditoria(
  `entityType=patient&entityId=${patientId}&field=phone&action=patient_updated&pageSize=50`,
);
check(
  'la auditoría encuentra el cambio de teléfono filtrando por campo',
  eventos.length > 0,
  `${String(eventos.length)} evento(s)`,
);
const evento = eventos[0];
check(
  'el evento guarda el valor anterior y el nuevo',
  evento?.before?.phone === '+584140000000' && evento?.after?.phone === '+584149998877',
  JSON.stringify({ before: evento?.before, after: evento?.after }),
);
check(
  'el evento identifica al actor y el motivo con el que se cambió',
  evento?.actorUsername === credentials.username && evento?.reason === PHONE_REASON,
  `${String(evento?.actorUsername)} · ${String(evento?.reason)}`,
);

/**
 * La exportación CSV de la auditoría la implementa identity en esta misma fase:
 * si todavía no está, se cuenta como comprobación fallida y la prueba **sigue**
 * (lo demás —reportes, permisos y auditoría— ya quedó comprobado).
 */
const auditoriaCsv = await descargar(
  `/api/v1/audit/events/export.csv?entityType=patient&entityId=${patientId}&action=patient_updated`,
);
if (auditoriaCsv.status === 404) {
  check(
    'la exportación CSV de la auditoría responde 200',
    false,
    'la ruta todavía no existe (404): la implementa identity en la Fase 9',
  );
} else {
  check(
    'la exportación CSV de la auditoría responde con CSV',
    auditoriaCsv.status === 200 && auditoriaCsv.type.includes('text/csv'),
    `status ${auditoriaCsv.status} · ${auditoriaCsv.type}`,
  );
  check(
    'el CSV de la auditoría trae el BOM, el separador y el motivo con su tilde',
    auditoriaCsv.texto.startsWith('\uFEFF') &&
      auditoriaCsv.texto.includes(';') &&
      auditoriaCsv.texto.includes(PHONE_REASON),
    primeraLineaDe(auditoriaCsv.texto),
  );
}

/* ── 12) Limpieza ──────────────────────────────────────────────────────────── */

// La cita quedó **atendida** (estado terminal): no se cancela, es historial.
if (typeof requestId === 'string') {
  const cancelada = await call(`/api/v1/requests/${requestId}/cancel`, {
    method: 'POST',
    body: JSON.stringify({ reason: `${MARK}: limpieza de la prueba` }),
  });
  console.log(
    `· Limpieza: la solicitud responde ${String(cancelada.status)} (la cita atendida se conserva como historial).`,
  );
}

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
  `\nPaciente ${documento} · cita ${appointmentId} (${hoy} ${String(hora)}) · sesión ${sessionId} · récipe ${String(emitido.body?.number)}`,
);
console.log('Recuerda: npm run seed:users -- --reset  (restaura las contraseñas sembradas)');
if (failures > 0) {
  console.error(`${String(failures)} comprobación(es) fallaron contra ${GATEWAY}`);
  process.exit(1);
}
console.log('Prueba de humo de reportes, KPIs y auditoría en verde ✔');
