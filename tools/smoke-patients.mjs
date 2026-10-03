#!/usr/bin/env node
/**
 * Prueba de humo de la Fase 2 contra el gateway real: registro, búsqueda por
 * documento en varias formas, edición con motivo y llegada del cambio a la
 * auditoría (outbox → cola compartida → identity).
 *
 *   npm run build && npm run db:migrate && npm run seed:demo
 *   npm run dev            # o: pm2 start infra/windows/ecosystem.config.cjs
 *   npm run smoke:patients
 *
 * ⚠️ Cambia la contraseña del administrador sembrado (porque nace con
 * `mustChangePassword`). Al terminar, restáurala con:
 *   npm run seed:users -- --reset
 * El paciente de prueba queda creado con el nombre «PRUEBA E2E …».
 */
const GATEWAY = process.env.SMOKE_GATEWAY_URL ?? 'http://127.0.0.1:8090';
const credentials = {
  username: process.env.SMOKE_USERNAME ?? 'admin',
  password: process.env.SMOKE_PASSWORD ?? 'admin-odontocrm-2026',
};
const NEW_PASSWORD = process.env.SMOKE_NEW_PASSWORD ?? 'prueba-e2e-odontocrm-2026';

const document = process.env.SMOKE_PATIENT_DOCUMENT ?? `V-${87000000 + (Date.now() % 1000000)}`;
const documentNumber = document.replace(/\D/g, '');

let token = '';
let failures = 0;

const call = async (path, options = {}) => {
  const response = await fetch(`${GATEWAY}${path}`, {
    ...options,
    // Sin tiempo límite, una conexión a medio cerrar deja la prueba colgada.
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

/**
 * Sesión del administrador. La prueba cambia la contraseña temporal en su primera
 * ejecución, así que en las siguientes se prueba también con la contraseña de
 * prueba: si no, todas las comprobaciones fallarían con 401 (y tardarían una
 * eternidad en hacerlo).
 */
const intentarLogin = async (password) =>
  call('/api/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: credentials.username, password }),
  });

let login = await intentarLogin(credentials.password);
if (login.status === 401 && credentials.password !== NEW_PASSWORD) {
  const segundo = await intentarLogin(NEW_PASSWORD);
  if (segundo.status === 200) {
    console.log('· La contraseña del administrador ya se había cambiado: se usa la de prueba.');
    login = segundo;
  }
}

check('login del administrador', login.status === 200, `status ${login.status}`);
if (login.status !== 200) {
  console.error(
    '\nNo se pudo iniciar sesión: ninguna contraseña sirvió.\n' +
      'Restaura las contraseñas sembradas con:  npm run seed:users -- --reset\n' +
      `(o define SMOKE_PASSWORD; ahora mismo se probó «${credentials.username}»).`,
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

// 2) Alta de un paciente.
const created = await call('/api/v1/patients', {
  method: 'POST',
  body: JSON.stringify({
    docType: 'V',
    docNumber: documentNumber,
    fullName: 'PRUEBA DE HUMO PACIENTE',
    birthDate: '1985-07-20',
    sex: 'F',
    phone: '0412-5556677',
    address: 'Dirección de prueba',
    notes: null,
  }),
});
check('alta de paciente responde 201', created.status === 201, `status ${created.status}`);
const patientId = created.body?.id ?? '';
check(
  'el documento se normaliza',
  created.body?.document === `V-${documentNumber}`,
  created.body?.document,
);
check(
  'el teléfono se normaliza a +58',
  created.body?.phone === '+584125556677',
  created.body?.phone,
);

// 3) Cédula repetida → 409 con el paciente existente.
const duplicated = await call('/api/v1/patients', {
  method: 'POST',
  body: JSON.stringify({
    docType: 'V',
    docNumber: documentNumber,
    fullName: 'Otro con la misma cédula',
    birthDate: '1990-01-01',
    sex: 'M',
    phone: '0414-1112233',
  }),
});
check('cédula repetida responde 409', duplicated.status === 409, `status ${duplicated.status}`);
check(
  'el error trae existingPatientId',
  duplicated.body?.existingPatientId === patientId,
  String(duplicated.body?.existingPatientId ?? ''),
);

// 4) Búsqueda por documento escrito de tres formas distintas.
for (const written of [
  documentNumber,
  `V-${documentNumber}`,
  `v ${documentNumber.slice(0, 2)}.${documentNumber.slice(2)}`,
]) {
  const lookup = await call(`/api/v1/patients/lookup?document=${encodeURIComponent(written)}`);
  check(
    `lookup «${written}» encuentra al paciente`,
    lookup.status === 200 && lookup.body?.found === true && lookup.body?.patient?.id === patientId,
    `status ${lookup.status}`,
  );
}

// 5) Edición con motivo.
const updated = await call(`/api/v1/patients/${patientId}`, {
  method: 'PATCH',
  body: JSON.stringify({ phone: '0414-9998877', reason: 'prueba de humo: cambia el teléfono' }),
});
check('edición con motivo responde 200', updated.status === 200, `status ${updated.status}`);
check(
  'el teléfono nuevo queda guardado',
  updated.body?.phone === '+584149998877',
  updated.body?.phone,
);

const withoutReason = await call(`/api/v1/patients/${patientId}`, {
  method: 'PATCH',
  body: JSON.stringify({ phone: '0414-0000000' }),
});
check(
  'editar sin motivo responde 400',
  withoutReason.status === 400,
  `status ${withoutReason.status}`,
);

// 6) La edición llega a la auditoría (outbox → cola compartida → identity).
let audited = [];
for (let attempt = 0; attempt < 20; attempt += 1) {
  const audit = await call(
    `/api/v1/audit/events?entityType=patient&entityId=${patientId}&pageSize=20`,
  );
  audited = Array.isArray(audit.body?.items) ? audit.body.items : [];
  if (audited.some((item) => item.action === 'patient_updated')) break;
  await new Promise((resolve) => setTimeout(resolve, 500));
}

const createdEvent = audited.find((item) => item.action === 'patient_created');
const updatedEvent = audited.find((item) => item.action === 'patient_updated');
check('la auditoría registra el alta', createdEvent !== undefined);
check('la auditoría registra la edición', updatedEvent !== undefined);
check(
  'la auditoría guarda el valor anterior y el nuevo',
  updatedEvent?.before?.phone === '+584125556677' && updatedEvent?.after?.phone === '+584149998877',
  JSON.stringify({ before: updatedEvent?.before, after: updatedEvent?.after }),
);
check(
  'la auditoría guarda el motivo y el usuario',
  updatedEvent?.reason === 'prueba de humo: cambia el teléfono' &&
    updatedEvent?.actorUsername === credentials.username,
  String(updatedEvent?.reason ?? ''),
);

// 7) Listado y filtros.
const list = await call('/api/v1/patients?pageSize=5&search=PRUEBA DE HUMO PACIENTE');
check(
  'el listado encuentra exactamente al paciente',
  list.body?.total === 1,
  `total ${list.body?.total}`,
);

const byAge = await call('/api/v1/patients?ageMin=30&ageMax=45&pageSize=5');
check('el filtro por rango de edad responde 200', byAge.status === 200, `status ${byAge.status}`);

// 8) Borrado lógico (solo admin): desaparece de listas y búsquedas y queda auditado.
const removed = await call(`/api/v1/patients/${patientId}/delete`, {
  method: 'POST',
  body: JSON.stringify({ reason: 'prueba de humo: paciente de prueba' }),
});
check('el borrado lógico responde 200', removed.status === 200, `status ${removed.status}`);

const afterRemove = await call(`/api/v1/patients/lookup?document=${encodeURIComponent(document)}`);
check(
  'tras el borrado, la cédula ya no está registrada',
  afterRemove.status === 200 && afterRemove.body?.found === false,
  `status ${afterRemove.status}`,
);

const listAfterRemove = await call('/api/v1/patients?pageSize=5&search=PRUEBA DE HUMO PACIENTE');
check(
  'tras el borrado, no aparece en el listado',
  (listAfterRemove.body?.total ?? 0) === 0,
  `total ${listAfterRemove.body?.total}`,
);

let deleteAudited = false;
for (let attempt = 0; attempt < 20; attempt += 1) {
  const audit = await call(
    `/api/v1/audit/events?entityType=patient&entityId=${patientId}&pageSize=20`,
  );
  const items = Array.isArray(audit.body?.items) ? audit.body.items : [];
  if (items.some((item) => item.action === 'patient_deleted')) {
    deleteAudited = true;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}
check('la auditoría registra el borrado con su motivo', deleteAudited);

const withoutReasonDelete = await call(`/api/v1/patients/${patientId}/delete`, {
  method: 'POST',
  body: JSON.stringify({}),
});
check(
  'borrar sin motivo no se permite (400 o 404 si ya no está)',
  withoutReasonDelete.status === 400 || withoutReasonDelete.status === 404,
  `status ${withoutReasonDelete.status}`,
);

// 9) La cédula vuelve a quedar libre: se puede registrar de nuevo (y se limpia).
const recreated = await call('/api/v1/patients', {
  method: 'POST',
  body: JSON.stringify({
    docType: 'V',
    docNumber: documentNumber,
    fullName: 'PRUEBA DE HUMO REINGRESO',
    birthDate: '1985-07-20',
    sex: 'F',
    phone: '0412-5556677',
  }),
});
check(
  'el documento liberado permite un alta nueva',
  recreated.status === 201,
  `status ${recreated.status}`,
);
if (recreated.status === 201) {
  const cleanup = await call(`/api/v1/patients/${recreated.body.id}/delete`, {
    method: 'POST',
    body: JSON.stringify({ reason: 'prueba de humo: limpieza del reingreso' }),
  });
  check('el reingreso se limpia', cleanup.status === 200, `status ${cleanup.status}`);
}

console.log(`\nPaciente de prueba: ${patientId} (documento ${document}) — borrado al terminar`);
if (failures > 0) {
  console.error(`${String(failures)} comprobación(es) fallaron contra ${GATEWAY}`);
  process.exit(1);
}
console.log(`Prueba de humo de pacientes correcta contra ${GATEWAY}`);
console.log('Recuerda: npm run seed:users -- --reset  (restaura la contraseña sembrada)');
