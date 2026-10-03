#!/usr/bin/env node
/**
 * Prueba de humo de la Fase 5 contra el gateway real: registrar una pantalla,
 * canjear su token de dispositivo, registrar la llegada de un paciente, llamarlo
 * y comprobar que **el lobby lo ve** (por el flujo SSE), pasarlo a consulta,
 * cerrar la visita con motivo y desactivar la pantalla.
 *
 *   pm2 start infra/windows/ecosystem.config.cjs
 *   npm run smoke:screens
 *
 * ⚠️ Cambia la contraseña del administrador sembrado. Al terminar:
 *   npm run seed:users -- --reset
 */
const GATEWAY = process.env.SMOKE_GATEWAY_URL ?? 'http://127.0.0.1:8090';
const credentials = {
  username: process.env.SMOKE_USERNAME ?? 'admin',
  password: process.env.SMOKE_PASSWORD ?? 'admin-odontocrm-2026',
};
const NEW_PASSWORD = process.env.SMOKE_NEW_PASSWORD ?? 'prueba-e2e-odontocrm-2026';
const MARK = 'PRUEBA DE HUMO PANTALLAS';
/** Tope de latencia del llamado → lobby (criterio del plan: menos de 1 s). */
const LATENCIA_MAXIMA_MS = 2_000;

let token = '';
let failures = 0;

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

const check = (label, condition, detail = '') => {
  if (!condition) failures += 1;
  console.log(`${condition ? '✔' : '✖'} ${label}${detail === '' ? '' : ` → ${detail}`}`);
};

// 1) Sesión del administrador.
const intentarLogin = async (password) =>
  call('/api/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: credentials.username, password }),
  });

let login = await intentarLogin(credentials.password);
if (login.status === 401 && credentials.password !== NEW_PASSWORD) {
  const second = await intentarLogin(NEW_PASSWORD);
  if (second.status === 200) login = second;
}
check('login del administrador', login.status === 200, `status ${login.status}`);
if (login.status !== 200) {
  console.error('\nRestaura las contraseñas con:  npm run seed:users -- --reset');
  process.exit(1);
}
token = login.body?.accessToken ?? '';

if (login.body?.user?.mustChangePassword === true) {
  const changed = await call('/api/v1/auth/password/change', {
    method: 'POST',
    body: JSON.stringify({
      currentPassword: credentials.password,
      newPassword: NEW_PASSWORD,
      repeatPassword: NEW_PASSWORD,
    }),
  });
  check('cambio de la contraseña temporal', changed.status === 200);
  token = changed.body?.accessToken ?? token;
}

// 2) Registrar una pantalla de sala: token en identity + ajustes en screens.
const deviceToken = await call('/api/v1/devices', {
  method: 'POST',
  body: JSON.stringify({ label: `${MARK} lobby`, kind: 'lobby' }),
});
check(
  'identity emite el token de la pantalla',
  deviceToken.status === 201 && typeof deviceToken.body?.token === 'string',
  `status ${deviceToken.status}`,
);
const tokenId = deviceToken.body?.id;
const deviceSecret = deviceToken.body?.token ?? '';

const screen = await call('/api/v1/screens/devices', {
  method: 'POST',
  body: JSON.stringify({
    label: `${MARK} lobby`,
    kind: 'lobby',
    tokenId,
    settings: { voz: true, volumen: 0.8, resalteSegundos: 30 },
  }),
});
check(
  'screens registra la pantalla con sus ajustes',
  screen.status === 201 && screen.body?.kind === 'lobby' && screen.body?.settings?.volumen === 0.8,
  `status ${screen.status}`,
);
const screenId = screen.body?.id;

const devices = await call('/api/v1/screens/devices');
check(
  'la pantalla aparece en la lista',
  devices.status === 200 && (devices.body?.items ?? []).some((item) => item.id === screenId),
  `${devices.body?.total ?? 0} pantallas`,
);

// 3) La pantalla canjea su token por un JWT de rol `pantalla`.
const deviceLogin = await fetch(`${GATEWAY}/api/v1/auth/device`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ token: deviceSecret }),
});
const deviceSession = await deviceLogin.json().catch(() => null);
check(
  'la pantalla canjea su token por un JWT',
  deviceLogin.status === 200 && typeof deviceSession?.accessToken === 'string',
  `status ${deviceLogin.status}`,
);
const screenToken = deviceSession?.accessToken ?? '';

const screenCall = async (path, options = {}) => {
  const response = await fetch(`${GATEWAY}${path}`, {
    ...options,
    signal: options.signal ?? AbortSignal.timeout(20_000),
    headers: { authorization: `Bearer ${screenToken}`, ...(options.headers ?? {}) },
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

check(
  'un token de pantalla inválido se rechaza',
  (
    await fetch(`${GATEWAY}/api/v1/auth/device`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'token-inventado-de-prueba' }),
    })
  ).status === 401,
);

const lobby = await screenCall('/api/v1/screens/lobby');
check('la pantalla lee el estado del lobby', lobby.status === 200, `status ${lobby.status}`);

const intruso = await screenCall('/api/v1/users');
check(
  'el token de la pantalla no abre ningún otro módulo',
  intruso.status === 403,
  `status ${intruso.status}`,
);

// 4) Cita real: paciente ficticio + franja libre de un día de consulta.
const patients = await call('/api/v1/patients?pageSize=1&search=9000');
const patient = patients.body?.items?.[0];
if (patient === undefined) {
  console.error('No hay pacientes ficticios: ejecuta  npm run seed:demo');
  process.exit(1);
}

const templates = await call('/api/v1/agenda/templates');
const workdays = new Set(
  (templates.body?.items ?? []).filter((item) => item.isActive).map((item) => item.weekday),
);
const dayFor = (offset) => {
  for (let extra = 0; extra < 14; extra += 1) {
    const date = new Date(Date.now() + (offset + extra) * 86_400_000).toISOString().slice(0, 10);
    if (workdays.has(new Date(`${date}T00:00:00Z`).getUTCDay())) return date;
  }
  throw new Error('sin día de consulta');
};
const day = dayFor(95);
const dayView = await call(`/api/v1/agenda/days/${day}`);
const freeSlot = (dayView.body?.slots ?? []).find((slot) => slot.state === 'libre')?.startTime;
if (freeSlot === undefined) {
  console.error('No hay franjas libres en el día de prueba');
  process.exit(1);
}

const request = await call('/api/v1/requests', {
  method: 'POST',
  body: JSON.stringify({
    patientId: patient.id,
    patientName: patient.fullName,
    patientDocument: patient.document,
    patientPhone: patient.phone,
    channel: 'presencial',
    reason: `${MARK}: control`,
    notes: MARK,
  }),
});
check('la solicitud se crea', request.status === 201, `ticket ${request.body?.ticket}`);

const appointment = await call('/api/v1/appointments', {
  method: 'POST',
  body: JSON.stringify({
    requestId: request.body?.id,
    date: day,
    startTime: freeSlot,
    slotKind: 'franja',
    notes: MARK,
  }),
});
check('la cita se formaliza', appointment.status === 201, `${day} ${freeSlot}`);
const appointmentId = appointment.body?.id;

// 5) El televisor de la sala abre su flujo **antes** del llamado: así se mide la
// latencia real del aviso (lo que ve el paciente), no el sondeo del que prueba.
const controlador = new AbortController();
const flujo = await fetch(`${GATEWAY}/api/v1/screens/lobby/stream`, {
  headers: { authorization: `Bearer ${screenToken}` },
  signal: controlador.signal,
}).catch(() => null);
check(
  'el flujo SSE del lobby responde text/event-stream',
  flujo !== null &&
    flujo.status === 200 &&
    (flujo.headers.get('content-type') ?? '').includes('text/event-stream'),
  flujo === null ? 'sin respuesta' : `status ${flujo.status}`,
);
if (flujo === null || flujo.body === null) {
  console.error('Sin flujo SSE no se puede comprobar el lobby');
  process.exit(1);
}

const lector = flujo.body.getReader();
const decoder = new TextDecoder();
let tramas = '';
const leerHasta = async (condicion, limiteMs) => {
  const limite = Date.now() + limiteMs;
  while (!condicion(tramas) && Date.now() < limite) {
    const { value, done } = await lector.read();
    if (done === true) break;
    tramas += decoder.decode(value);
  }
  return condicion(tramas);
};

check(
  'el flujo entrega el estado inicial',
  await leerHasta((texto) => texto.includes('event: lobby'), 5_000),
);

// 6) La secretaría registra la llegada y llama: el lobby tiene que verlo ya.
const checkIn = await call(`/api/v1/appointments/${appointmentId}/check-in`, { method: 'POST' });
check('la llegada se registra', checkIn.status === 200, `estado ${checkIn.body?.status}`);

const llamadoEn = Date.now();
const llamado = await call(`/api/v1/appointments/${appointmentId}/call`, { method: 'POST' });
check('el paciente queda llamado', llamado.status === 200, `estado ${llamado.body?.status}`);

// El televisor no pregunta: el llamado le llega empujado por el flujo.
const aparecio = await leerHasta((texto) => texto.includes(appointmentId), 10_000);
const latencia = aparecio ? Date.now() - llamadoEn : -1;
check('el llamado aparece en el lobby', aparecio, `latencia ${latencia} ms`);
check(
  'el llamado llega en menos de un segundo (medido y con tope)',
  latencia >= 0 && latencia < LATENCIA_MAXIMA_MS,
  `${latencia} ms`,
);
controlador.abort();

const nombreAbreviado = `${String(patient.fullName).split(/\s+/)[0] ?? ''} ${(
  String(patient.fullName).split(/\s+/)[1] ?? ' '
).charAt(0)}.`;

const llamadoLobby = (await screenCall('/api/v1/screens/lobby')).body?.calls?.[0];
check(
  'el lobby muestra el nombre abreviado y el sillón',
  llamadoLobby?.patientDisplayName === nombreAbreviado && llamadoLobby?.chairLabel !== undefined,
  `${llamadoLobby?.patientDisplayName ?? '—'} · ${llamadoLobby?.chairLabel ?? '—'}`,
);
check(
  'la sala cuenta al paciente en espera',
  typeof (await screenCall('/api/v1/screens/lobby')).body?.waitingCount === 'number',
);

// 7) Pasar a consulta y cerrar la visita con motivo (sin sesión clínica aún).
const pasar = await call(`/api/v1/appointments/${appointmentId}/start`, { method: 'POST' });
check('el paciente pasa a consulta', pasar.status === 200, `estado ${pasar.body?.status}`);

const consultorio = await (async () => {
  // El paso a consulta también viaja por eventos: se tolera medio segundo.
  for (let intento = 0; intento < 40; intento += 1) {
    const estado = await screenCall('/api/v1/screens/consultorio');
    if (estado.body?.appointmentId === appointmentId && estado.body?.since !== null) return estado;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return screenCall('/api/v1/screens/consultorio');
})();
check(
  'la pantalla del consultorio muestra al paciente en curso',
  consultorio.status === 200 &&
    consultorio.body?.appointmentId === appointmentId &&
    consultorio.body?.since !== null,
  `${consultorio.body?.patientDisplayName ?? '—'} · motivo: ${consultorio.body?.reason ?? '—'}`,
);

const sinMotivo = await call(`/api/v1/appointments/${appointmentId}/attend`, {
  method: 'POST',
  body: JSON.stringify({}),
});
check(
  'marcar atendido sin sesión clínica exige motivo',
  sinMotivo.status === 400,
  `status ${sinMotivo.status}`,
);

const atendido = await call(`/api/v1/appointments/${appointmentId}/attend`, {
  method: 'POST',
  body: JSON.stringify({ forceReason: `${MARK}: visita cerrada en la prueba` }),
});
check(
  'con motivo sí se marca atendido',
  atendido.status === 200,
  `estado ${atendido.body?.status}`,
);

const historial = await call(`/api/v1/appointments/${appointmentId}/history`);
const acciones = (historial.body?.items ?? []).map((item) => item.toStatus);
check(
  'todas las transiciones quedan en el historial',
  ['en_sala_espera', 'llamado', 'en_consulta', 'atendido'].every((estado) =>
    acciones.includes(estado),
  ),
  acciones.join(' → '),
);

let salaVacia = false;
for (let intento = 0; intento < 60; intento += 1) {
  const estado = await screenCall('/api/v1/screens/consultorio');
  if (estado.body?.appointmentId === null) {
    salaVacia = true;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 150));
}
check('al terminar, la sala queda vacía', salaVacia);

// 8) Desactivar la pantalla: deja de ver la sala.
const desactivar = await call(`/api/v1/screens/devices/${screenId}`, { method: 'DELETE' });
check('la pantalla se desactiva', desactivar.status === 204, `status ${desactivar.status}`);
const trasDesactivar = await screenCall('/api/v1/screens/lobby');
check(
  'una pantalla desactivada deja de ver la sala',
  trasDesactivar.status === 403,
  `status ${trasDesactivar.status}`,
);
if (typeof tokenId === 'string') await call(`/api/v1/devices/${tokenId}`, { method: 'DELETE' });

// 9) Limpieza: la cita se cancela (el ticket vuelve a la cola) y la solicitud se anula.
if (typeof appointmentId === 'string') {
  await call(`/api/v1/appointments/${appointmentId}/cancel`, {
    method: 'POST',
    body: JSON.stringify({ reason: `${MARK}: limpieza` }),
  });
}
if (typeof request.body?.id === 'string') {
  await call(`/api/v1/requests/${request.body.id}/cancel`, {
    method: 'POST',
    body: JSON.stringify({ reason: `${MARK}: limpieza` }),
  });
}

console.log(`\nDía usado: ${day} ${freeSlot} · llamado visto en el lobby en ${latencia} ms`);
if (failures > 0) {
  console.error(`${String(failures)} comprobación(es) fallaron contra ${GATEWAY}`);
  process.exit(1);
}
console.log(`Prueba de humo de pantallas correcta contra ${GATEWAY}`);
console.log('Recuerda: npm run seed:users -- --reset  (restaura la contraseña sembrada)');
