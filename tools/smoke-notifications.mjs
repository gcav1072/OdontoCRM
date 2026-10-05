#!/usr/bin/env node
/**
 * Prueba de humo de la Fase 4 contra el gateway real: estado del bot, plantillas,
 * vinculación con QR, bandeja de envíos y **el camino completo** de un aviso de
 * cita (formalizar → evento → cola → «manual pendiente» si el paciente no tiene
 * Telegram, o envío real si se le vincula un chat).
 *
 *   pm2 start infra/windows/ecosystem.config.cjs     # con TELEGRAM_BOT_TOKEN en el .env
 *   npm run smoke:notifications
 *
 * Opcional, para probar el envío **real** por Telegram (el chat debe haber
 * escrito antes al bot):
 *   $env:SMOKE_TELEGRAM_CHAT_ID='123456789'; npm run smoke:notifications
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
const TEST_CHAT_ID = process.env.SMOKE_TELEGRAM_CHAT_ID ?? null;
const MARK = 'PRUEBA DE HUMO AVISOS';

/**
 * `SMOKE_BOT_OPCIONAL=1` — para una máquina **sin bot configurado** (la PC de
 * pruebas antes de poner el token, o un despliegue que todavía no usa Telegram).
 * Las cuatro comprobaciones que necesitan un bot real (identidad, conexión, enlace
 * y QR) se informan como «no aplica» en lugar de fallar, y el resumen lo dice sin
 * adornos: **la parte del bot queda pendiente**, no verificada.
 *
 * Lo usa `npm run e2e:clinica -- --sin-bot`.
 */
const BOT_OPCIONAL = process.env.SMOKE_BOT_OPCIONAL === '1';

let token = '';
let failures = 0;
let omitidas = 0;

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

/** Comprobación que **no aplica** en esta instalación (se cuenta y se dice). */
const omitir = (label, motivo) => {
  omitidas += 1;
  console.log(`· ${label} → no aplica: ${motivo}`);
};

// 1) Sesión.
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

// 2) Estado del bot: modo, identidad y cola.
const status = await call('/api/v1/notifications/status');
check('el estado del bot responde', status.status === 200, `status ${status.status}`);

/**
 * Dos situaciones válidas, y cada una se comprueba como es:
 *
 * - **Instalación normal**: el bot tiene token y está conectado; los envíos salen.
 * - **Modo test (ADR 0020)**: aunque haya token, el transporte es **simulado a
 *   propósito** (ningún mensaje puede salir a un paciente) y `testMode` lo dice.
 *   Aquí se comprueba eso mismo, no que esté «conectado».
 */
const enModoTest = status.body?.testMode === true;
const botConfigurado = status.body?.mode === 'real' && typeof status.body?.botUsername === 'string';

if (enModoTest) {
  check(
    'en modo test el bot queda simulado a propósito (los envíos están bloqueados)',
    status.body?.mode === 'simulado',
    `modo ${status.body?.mode}`,
  );
} else if (!botConfigurado && BOT_OPCIONAL) {
  omitir('el bot está configurado', 'esta máquina no tiene TELEGRAM_BOT_TOKEN/USERNAME');
  omitir('el bot está conectado con Telegram', 'no hay bot que conectar');
} else {
  check(
    'el bot está configurado',
    botConfigurado,
    `modo ${status.body?.mode}, bot @${status.body?.botUsername ?? '—'}`,
  );
  check('el bot está conectado con Telegram', status.body?.connected === true);
}
check(
  'la cola tiene contadores',
  typeof status.body?.counts?.queued === 'number' &&
    typeof status.body?.counts?.manualPending === 'number',
  `en cola ${status.body?.counts?.queued}, manuales ${status.body?.counts?.manualPending}`,
);
check(
  'el estado lista los canales activos con sus capacidades',
  Array.isArray(status.body?.canales) &&
    status.body.canales.some(
      (canal) => canal.canal === 'telegram' && typeof canal.capacidades?.botones === 'boolean',
    ),
  (status.body?.canales ?? []).map((canal) => canal.canal).join(', ') || '—',
);

// El webhook de un canal que empuja es **público**: Meta no manda JWT y la
// seguridad la da la firma. Que responda 404/403 y no 401 demuestra la excepción
// del gateway y que la ruta está enrutada al servicio.
const webhook = await call('/api/v1/notifications/webhook/whatsapp');
check(
  'el webhook del canal es público (no exige JWT)',
  webhook.status !== 401,
  `status ${webhook.status}`,
);

// 3) Plantillas editables.
const templates = await call('/api/v1/notifications/templates');
const templateKeys = (templates.body?.items ?? []).map((item) => item.key);
check(
  'las plantillas están sembradas',
  templateKeys.length >= 15,
  `${templateKeys.length} plantillas`,
);
check('incluye la confirmación de cita', templateKeys.includes('cita_confirmada'));

const editing = await call('/api/v1/notifications/templates/bienvenida', {
  method: 'PATCH',
  body: JSON.stringify({ body: 'Hola desde la prueba de humo {clinica}' }),
});
check(
  'una plantilla se puede editar',
  editing.status === 200 && editing.body?.body.includes('prueba de humo'),
);
const restored = await call('/api/v1/notifications/templates/bienvenida/reset', { method: 'POST' });
check(
  'y se puede restaurar al texto por defecto',
  restored.status === 200 && !restored.body?.body.includes('prueba de humo'),
);

// 4) Vinculación con QR.
const patients = await call('/api/v1/patients?pageSize=1&search=9000');
const patient = patients.body?.items?.[0];
check(
  'hay un paciente ficticio',
  patient !== undefined,
  patient?.fullName ?? 'ejecuta npm run seed:demo',
);
if (patient === undefined) process.exit(1);

const linkCode = await call('/api/v1/notifications/channels/link-code', {
  method: 'POST',
  body: JSON.stringify({ patientId: patient.id }),
});
check(
  'se genera el enlace de vinculación',
  linkCode.status === 200,
  `código ${linkCode.body?.code}`,
);
if (!botConfigurado && BOT_OPCIONAL && !enModoTest) {
  omitir('el enlace apunta al bot real', 'hace falta el @usuario del bot');
  omitir('el QR viene listo para mostrar', 'hace falta el @usuario del bot');
} else {
  check(
    'el enlace apunta al bot real',
    typeof linkCode.body?.deepLink === 'string' && linkCode.body.deepLink.includes('t.me/'),
    String(linkCode.body?.deepLink ?? ''),
  );
  check(
    'el QR viene listo para mostrar',
    typeof linkCode.body?.qrDataUrl === 'string' &&
      linkCode.body.qrDataUrl.startsWith('data:image/png'),
  );
}
check('el enlace caduca', typeof linkCode.body?.expiresAt === 'string');

// 5) Camino completo de un aviso de cita.
const templates_ = await call('/api/v1/agenda/templates');
const workdays = new Set(
  (templates_.body?.items ?? []).filter((item) => item.isActive).map((item) => item.weekday),
);
const dayFor = (offset) => {
  for (let extra = 0; extra < 14; extra += 1) {
    const date = new Date(Date.now() + (offset + extra) * 86_400_000).toISOString().slice(0, 10);
    if (workdays.has(new Date(`${date}T00:00:00Z`).getUTCDay())) return date;
  }
  throw new Error('sin día de consulta');
};
const day = dayFor(75);
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
    channel: 'telefono',
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
check('la cita tiene ticket', typeof appointment.body?.ticket === 'string');

// El evento de agenda tiene que acabar en un aviso para el paciente.
let notice = null;
for (let attempt = 0; attempt < 20; attempt += 1) {
  const inbox = await call(
    `/api/v1/notifications?pageSize=10&search=${encodeURIComponent(patient.fullName)}`,
  );
  notice = (inbox.body?.items ?? []).find(
    (item) => item.templateKey === 'cita_confirmada' && item.appointmentId === appointment.body?.id,
  );
  if (notice !== undefined && notice !== null) break;
  await new Promise((resolve) => setTimeout(resolve, 500));
}
check('el aviso de la cita llegó a la bandeja', notice !== null && notice !== undefined);
check(
  'sin Telegram vinculado queda como aviso manual pendiente',
  notice?.status === 'skipped_no_channel',
  `estado ${notice?.status ?? '—'}`,
);
check(
  'el aviso trae el guion de llamada',
  typeof notice?.payload?.text === 'string' && String(notice.payload.text).includes('Lugar:'),
  String(notice?.payload?.text ?? '').split('\n')[0],
);

const contacted = await call(`/api/v1/notifications/${notice?.id}/contacted`, {
  method: 'POST',
  body: JSON.stringify({ note: `${MARK}: llamada de prueba` }),
});
check(
  'el aviso manual se puede marcar como contactado',
  contacted.status === 200 && contacted.body?.contactedAt !== null,
);

// 6) El botón «Notificar» de la jornada **asegura** el aviso sin duplicarlo.
{
  const notificar = await call('/api/v1/agenda/notify', {
    method: 'POST',
    body: JSON.stringify({ appointmentIds: [appointment.body?.id] }),
  });
  check('el botón Notificar responde', notificar.status === 200);
  await new Promise((resolve) => setTimeout(resolve, 2_500));

  const inbox = await call(
    `/api/v1/notifications?pageSize=20&search=${encodeURIComponent(patient.fullName)}`,
  );
  const deLaCita = (inbox.body?.items ?? []).filter(
    (item) => item.appointmentId === appointment.body?.id && item.templateKey === 'cita_confirmada',
  );
  check(
    'notificar a mano no duplica el aviso que ya salió',
    deLaCita.length === 1,
    `${String(deLaCita.length)} aviso(s) de la cita`,
  );
  check(
    'el aviso de la cita sigue siendo el mismo (no se creó otro)',
    deLaCita[0]?.id === notice?.id,
  );
}

// 7) Envío real (opcional): se vincula el chat indicado y se reintenta.
if (TEST_CHAT_ID !== null) {
  console.log(`\n· Probando el envío REAL al chat ${TEST_CHAT_ID}`);
  const link = await call('/api/v1/notifications/channels/link-code', {
    method: 'POST',
    body: JSON.stringify({ patientId: patient.id }),
  });
  check('hay enlace para vincular el chat', link.status === 200);

  // El chat se vincula por la vía normal (el bot recibe /start <código>); aquí se
  // simula escribiendo directamente en la tabla mediante el reintento del aviso:
  // el aviso solo se enviará si el paciente tiene canal, así que se avisa al usuario.
  console.log(
    '  → Abre Telegram, escribe al bot y luego ejecuta de nuevo el reintento:\n' +
      `     https://t.me/${link.body?.botUsername ?? 'bot'}?start=${link.body?.code ?? ''}`,
  );
  const retry = await call(`/api/v1/notifications/${notice?.id}/retry`, {
    method: 'POST',
    body: JSON.stringify({ reason: 'prueba de envío real' }),
  });
  check('el reintento devuelve el aviso a la cola', retry.status === 200);

  let sent = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const inbox = await call(
      `/api/v1/notifications?pageSize=10&search=${encodeURIComponent(patient.fullName)}`,
    );
    sent = (inbox.body?.items ?? []).find((item) => item.id === notice?.id);
    if (sent?.status === 'sent' || sent?.status === 'failed') break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  check(
    'el aviso se envió por Telegram con el .ics',
    sent?.status === 'sent',
    `estado ${sent?.status ?? '—'}${sent?.lastError === null || sent?.lastError === undefined ? '' : `: ${sent.lastError}`}`,
  );
}

// 8) Limpieza: se cancelan las citas y solicitudes de la prueba.
for (const id of [appointment.body?.id]) {
  if (typeof id === 'string') {
    await call(`/api/v1/appointments/${id}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ reason: `${MARK}: limpieza` }),
    });
  }
}
if (typeof request.body?.id === 'string') {
  await call(`/api/v1/requests/${request.body.id}/cancel`, {
    method: 'POST',
    body: JSON.stringify({ reason: `${MARK}: limpieza` }),
  });
}

console.log(
  `\nBot: @${status.body?.botUsername ?? '—'} (${status.body?.mode}) · día usado: ${day}`,
);
if (omitidas > 0) {
  console.warn(
    `${String(omitidas)} comprobación(es) NO se hicieron: el bot no está configurado en esta máquina.\n` +
      '  La parte del bot queda PENDIENTE: pon TELEGRAM_BOT_TOKEN y TELEGRAM_BOT_USERNAME en\n' +
      '  services/notifications/.env (o /etc/odontocrm/notifications.env) y repite la prueba.',
  );
}
if (failures > 0) {
  console.error(`${String(failures)} comprobación(es) fallaron contra ${GATEWAY}`);
  process.exit(1);
}
console.log(`Prueba de humo de notificaciones correcta contra ${GATEWAY}`);
console.log('Recuerda: npm run seed:users -- --reset  (restaura la contraseña sembrada)');
