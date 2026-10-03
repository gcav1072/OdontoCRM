#!/usr/bin/env node
/**
 * Prueba de humo de la Fase 3 contra el gateway real: ticket, cola, jornada, cupo,
 * asignación, sobrecupo, franja ocupada, reprogramación, tolerancia de inasistencia,
 * aviso en lote y llegada a la auditoría.
 *
 *   npm run build && npm run db:migrate && npm run seed:demo && npm run seed:agenda
 *   pm2 start infra/windows/ecosystem.config.cjs      # o: npm run dev
 *   npm run smoke:agenda
 *
 * ⚠️ Cambia la contraseña del administrador sembrado (nace con `mustChangePassword`).
 * Al terminar:  npm run seed:users -- --reset
 *
 * Los datos que crea quedan **cancelados** al final (no borra: la agenda es
 * historial), con la nota «PRUEBA DE HUMO» para reconocerlos.
 */
const GATEWAY = process.env.SMOKE_GATEWAY_URL ?? 'http://127.0.0.1:8090';
const credentials = {
  username: process.env.SMOKE_USERNAME ?? 'admin',
  password: process.env.SMOKE_PASSWORD ?? 'admin-odontocrm-2026',
};
const NEW_PASSWORD = process.env.SMOKE_NEW_PASSWORD ?? 'prueba-e2e-odontocrm-2026';
const MARK = 'PRUEBA DE HUMO AGENDA';

let token = '';
let failures = 0;

const call = async (path, options = {}) => {
  const response = await fetch(`${GATEWAY}${path}`, {
    ...options,
    signal: options.signal ?? AbortSignal.timeout(20_000),
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

// 1) Sesión.
const intentarLogin = async (password) =>
  call('/api/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: credentials.username, password }),
  });

let login = await intentarLogin(credentials.password);
if (login.status === 401 && credentials.password !== NEW_PASSWORD) {
  const second = await intentarLogin(NEW_PASSWORD);
  if (second.status === 200) {
    console.log('· La contraseña del administrador ya se había cambiado: se usa la de prueba.');
    login = second;
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
  const changed = await call('/api/v1/auth/password/change', {
    method: 'POST',
    body: JSON.stringify({
      currentPassword: credentials.password,
      newPassword: NEW_PASSWORD,
      repeatPassword: NEW_PASSWORD,
    }),
  });
  check('cambio de la contraseña temporal', changed.status === 200, `status ${changed.status}`);
  token = changed.body?.accessToken ?? token;
}

// 2) Un paciente ficticio para la solicitud.
const patients = await call('/api/v1/patients?pageSize=1&search=9000');
const patient = patients.body?.items?.[0];
check(
  'hay un paciente ficticio para la prueba',
  patient !== undefined,
  patient === undefined
    ? 'ejecuta: npm run seed:demo'
    : `${patient.fullName} (${patient.document})`,
);
if (patient === undefined) process.exit(1);

// 3) Un día de consulta: se deduce de las plantillas reales del consultorio.
const templates = await call('/api/v1/agenda/templates');
const workdays = new Set(
  (templates.body?.items ?? []).filter((item) => item.isActive).map((item) => item.weekday),
);
check('el consultorio tiene plantillas de jornada', workdays.size > 0, `${workdays.size} días`);

const dayFor = (offsetDays) => {
  for (let extra = 0; extra < 14; extra += 1) {
    const date = new Date(Date.now() + (offsetDays + extra) * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    if (workdays.has(weekday)) return date;
  }
  throw new Error('no encontré día de consulta');
};

const day = dayFor(60);
const otherDay = dayFor(67);

const dayView = await call(`/api/v1/agenda/days/${day}`);
check('la jornada del día responde', dayView.status === 200, `status ${dayView.status}`);
const freeSlots = (dayView.body?.slots ?? []).filter((slot) => slot.state === 'libre');
check('el día tiene franjas libres', freeSlots.length >= 3, `${freeSlots.length} libres`);
const slotA = freeSlots[0]?.startTime;
const slotB = freeSlots[1]?.startTime;
const slotC = freeSlots[2]?.startTime;

// 4) Solicitud con ticket.
const created = await call('/api/v1/requests', {
  method: 'POST',
  body: JSON.stringify({
    patientId: patient.id,
    patientName: patient.fullName,
    patientDocument: patient.document,
    patientPhone: patient.phone,
    channel: 'telefono',
    reason: `${MARK}: dolor en la muela del juicio`,
    priority: 0,
    notes: MARK,
  }),
});
check('la solicitud se crea con 201', created.status === 201, `status ${created.status}`);
check(
  'el ticket tiene el formato esperado',
  /^#\d{6}$/.test(created.body?.ticket ?? ''),
  created.body?.ticket,
);
check('la solicitud queda en espera de cita', created.body?.status === 'en_espera_cita');
const requestId = created.body?.id ?? '';

// La cola es FIFO por ticket: la solicitud recién creada es la última, así que se
// busca por su ticket (que además comprueba la búsqueda por ticket).
const queue = await call(
  `/api/v1/requests?onlyWaiting=true&search=${encodeURIComponent(created.body?.ticket ?? '')}`,
);
check(
  'la solicitud aparece en la cola (buscando por ticket)',
  (queue.body?.items ?? []).some((item) => item.id === requestId),
  `encontradas ${queue.body?.total}`,
);

// 5) Cupo del día (editable) y asignación de una franja.
const capacity = await call('/api/v1/agenda/capacity', {
  method: 'PUT',
  body: JSON.stringify({ date: day, capacity: 6, notes: `${MARK}: cupo de prueba` }),
});
check(
  'el cupo se fija en 6',
  capacity.body?.capacity === 6,
  `capacidad ${capacity.body?.capacity}`,
);
check('el cupo queda como explícito', capacity.body?.source === 'explicito');

const assigned = await call('/api/v1/appointments', {
  method: 'POST',
  body: JSON.stringify({
    requestId,
    date: day,
    startTime: slotA,
    slotKind: 'franja',
    authorizeOverbook: false,
    notes: MARK,
  }),
});
check('la cita se asigna a la franja', assigned.status === 201, `status ${assigned.status}`);
check('la cita conserva el ticket de la solicitud', assigned.body?.ticket === created.body?.ticket);
const appointmentId = assigned.body?.id ?? '';

// 6) La misma franja no se puede ocupar dos veces.
const duplicated = await call('/api/v1/appointments', {
  method: 'POST',
  body: JSON.stringify({ requestId, date: day, startTime: slotA, slotKind: 'franja' }),
});
check(
  'repetir la solicitud o la franja da 409',
  duplicated.status === 409,
  `status ${duplicated.status}: ${String(duplicated.body?.detail ?? '').slice(0, 60)}`,
);

const second = await call('/api/v1/requests', {
  method: 'POST',
  body: JSON.stringify({
    patientId: patient.id,
    patientName: patient.fullName,
    patientDocument: patient.document,
    channel: 'presencial',
    reason: `${MARK}: limpieza`,
    notes: MARK,
  }),
});
const takenSlot = await call('/api/v1/appointments', {
  method: 'POST',
  body: JSON.stringify({
    requestId: second.body?.id,
    date: day,
    startTime: slotA,
    slotKind: 'franja',
    notes: MARK,
  }),
});
check(
  'una franja ocupada responde 409 con la cita que la ocupa',
  takenSlot.status === 409 && takenSlot.body?.takenByAppointmentId === appointmentId,
  `status ${takenSlot.status}`,
);

// 7) Bajar el cupo por debajo de lo asignado avisa y no borra.
const lowered = await call('/api/v1/agenda/capacity', {
  method: 'PUT',
  body: JSON.stringify({ date: day, capacity: 0, notes: `${MARK}: cupo a cero` }),
});
check(
  'bajar el cupo avisa y no borra citas',
  typeof lowered.body?.warning === 'string' && lowered.body?.assigned >= 1,
  String(lowered.body?.warning ?? '').slice(0, 70),
);
const stillThere = await call(`/api/v1/appointments/${appointmentId}`);
check(
  'la cita sigue existiendo',
  stillThere.status === 200 && stillThere.body?.status === 'programada',
);

// 8) Sobrecupo: sin motivo no pasa, y con motivo pero sin ser quien puede…
const overbookWithoutReason = await call('/api/v1/appointments', {
  method: 'POST',
  body: JSON.stringify({
    requestId: second.body?.id,
    date: day,
    startTime: slotB,
    slotKind: 'franja',
    authorizeOverbook: true,
  }),
});
check(
  'el sobrecupo sin motivo no se acepta',
  overbookWithoutReason.status === 400 || overbookWithoutReason.status === 409,
  `status ${overbookWithoutReason.status}`,
);
const overbooked = await call('/api/v1/appointments', {
  method: 'POST',
  body: JSON.stringify({
    requestId: second.body?.id,
    date: day,
    startTime: slotB,
    slotKind: 'franja',
    authorizeOverbook: true,
    overbookReason: `${MARK}: paciente con dolor agudo`,
    notes: MARK,
  }),
});
check(
  'el admin autoriza el sobrecupo con motivo',
  overbooked.status === 201,
  `status ${overbooked.status}`,
);

// 9) Reprogramación: conserva el ticket y enlaza la cita nueva.
const moved = await call(`/api/v1/appointments/${appointmentId}/reschedule`, {
  method: 'POST',
  body: JSON.stringify({
    date: otherDay,
    startTime: slotC,
    slotKind: 'franja',
    reason: `${MARK}: el paciente pidió cambiarla`,
    authorizeOverbook: false,
  }),
});
check('la reprogramación responde 200', moved.status === 200, `status ${moved.status}`);
check('la cita nueva enlaza con la anterior', moved.body?.rescheduledFromId === appointmentId);
check('la cita nueva conserva el ticket', moved.body?.ticket === created.body?.ticket);
check(
  'el .ics incrementa su secuencia',
  moved.body?.icsSequence === 1,
  `secuencia ${moved.body?.icsSequence}`,
);
const previous = await call(`/api/v1/appointments/${appointmentId}`);
check('la cita anterior queda como reprogramada', previous.body?.status === 'reprogramada');
check('y apunta a la nueva', previous.body?.rescheduledToId === moved.body?.id);

const history = await call(`/api/v1/appointments/${appointmentId}/history`);
const historyStatuses = (history.body?.items ?? []).map((item) => item.toStatus);
check(
  'el historial guarda las transiciones con actor',
  historyStatuses.includes('programada') && historyStatuses.includes('reprogramada'),
  historyStatuses.join(' → '),
);

// 10) Inasistencia: la tolerancia manda.
const noShow = await call(`/api/v1/appointments/${moved.body?.id}/no-show`, {
  method: 'POST',
  body: JSON.stringify({ reason: `${MARK}: prueba` }),
});
check(
  'marcar inasistencia antes de tiempo responde 400 con el motivo',
  noShow.status === 400,
  `status ${noShow.status}: ${String(noShow.body?.detail ?? '').slice(0, 60)}`,
);

// 11) Aviso en lote con vista previa exacta.
const preview = await call('/api/v1/agenda/notify/preview', {
  method: 'POST',
  body: JSON.stringify({ date: day }),
});
const previewItems = preview.body?.items ?? [];
const sendable = previewItems.filter((item) => item.willSend);
check(
  'la vista previa trae los mensajes del día',
  previewItems.length >= 1,
  `${previewItems.length} mensajes`,
);
check(
  'los mensajes se ven completos (fecha, hora y lugar)',
  sendable.length > 0 &&
    sendable.every(
      (item) =>
        item.body.includes(item.patientName) &&
        item.body.includes('Lugar:') &&
        (item.body.includes('a. m.') || item.body.includes('p. m.')),
    ),
  sendable[0]?.body?.split('\n')[1] ?? '',
);

const notified = await call('/api/v1/agenda/notify', {
  method: 'POST',
  body: JSON.stringify({ date: day, force: false }),
});
check(
  'el lote marca las citas como notificadas',
  notified.status === 200 && notified.body?.notified === sendable.length,
  `notificadas ${notified.body?.notified} de ${sendable.length}`,
);
const secondPreview = await call('/api/v1/agenda/notify/preview', {
  method: 'POST',
  body: JSON.stringify({ date: day }),
});
check(
  'un segundo intento no repite los avisos',
  (secondPreview.body?.items ?? []).every((item) => item.willSend === false),
);

// 12) La auditoría recibe los eventos de agenda.
let audited = [];
for (let attempt = 0; attempt < 20; attempt += 1) {
  const audit = await call(
    `/api/v1/audit/events?entityType=appointment&entityId=${appointmentId}&pageSize=20`,
  );
  audited = Array.isArray(audit.body?.items) ? audit.body.items : [];
  if (audited.some((item) => item.action === 'appointment_scheduled')) break;
  await new Promise((resolve) => setTimeout(resolve, 500));
}
const scheduledAudit = audited.find((item) => item.action === 'appointment_scheduled');
check('la auditoría registra la cita agendada', scheduledAudit !== undefined);
check(
  'la auditoría trae un resumen legible',
  typeof scheduledAudit?.summary === 'string' && scheduledAudit.summary.length > 10,
  String(scheduledAudit?.summary ?? '').slice(0, 70),
);
check(
  'la auditoría identifica al usuario',
  scheduledAudit?.actorUsername === credentials.username,
  String(scheduledAudit?.actorUsername ?? ''),
);

const requestAudit = await call(
  `/api/v1/audit/events?entityType=request&entityId=${requestId}&pageSize=20`,
);
check(
  'la auditoría registra la solicitud',
  (requestAudit.body?.items ?? []).some((item) => item.action === 'request_created'),
);

// 13) Limpieza: se cancelan las citas y la solicitud de la prueba.
for (const id of [appointmentId, moved.body?.id, overbooked.body?.id]) {
  if (typeof id === 'string' && id !== '') {
    await call(`/api/v1/appointments/${id}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ reason: `${MARK}: limpieza de la prueba` }),
    });
  }
}
if (typeof second.body?.id === 'string') {
  await call(`/api/v1/requests/${second.body.id}/cancel`, {
    method: 'POST',
    body: JSON.stringify({ reason: `${MARK}: limpieza de la prueba` }),
  });
}
const afterCleanup = await call(`/api/v1/agenda/days/${day}`);
check(
  'el día queda libre de citas activas',
  (afterCleanup.body?.counts?.programadas ?? 0) === 0 &&
    (afterCleanup.body?.counts?.notificadas ?? 0) === 0,
  `programadas ${afterCleanup.body?.counts?.programadas}, notificadas ${afterCleanup.body?.counts?.notificadas}`,
);

console.log(
  `\nDía usado: ${day} · solicitud ${created.body?.ticket ?? ''} · cita ${appointmentId}`,
);
if (failures > 0) {
  console.error(`${String(failures)} comprobación(es) fallaron contra ${GATEWAY}`);
  process.exit(1);
}
console.log(`Prueba de humo de la agenda correcta contra ${GATEWAY}`);
console.log('Recuerda: npm run seed:users -- --reset  (restaura la contraseña sembrada)');
