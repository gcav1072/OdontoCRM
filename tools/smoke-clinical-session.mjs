#!/usr/bin/env node
/**
 * Prueba de humo de la Fase 7 (sesión A) contra el gateway real: abrir la sesión
 * del día, autoguardarla, comprobar que **una sesión vacía no se cierra**, cerrarla
 * (queda inmutable y auditada), corregirla con una **enmienda** sin tocar la
 * original, marcar la cita **atendida** sin motivo con esa sesión como respaldo
 * —y comprobar que un identificador inventado no vale—, y que el odontograma
 * guarda el hallazgo **ligado a la sesión**.
 *
 *   pm2 start infra/windows/ecosystem.config.cjs
 *   npm run smoke:clinical
 *
 * ⚠️ Cambia la contraseña del administrador y la de la secretaría sembrados.
 * Al terminar:  npm run seed:users -- --reset
 */
const GATEWAY = process.env.SMOKE_GATEWAY_URL ?? 'http://127.0.0.1:8090';
const credentials = {
  username: process.env.SMOKE_USERNAME ?? 'admin',
  password: process.env.SMOKE_PASSWORD ?? 'admin-odontocrm-2026',
};
const NEW_PASSWORD = process.env.SMOKE_NEW_PASSWORD ?? 'prueba-e2e-odontocrm-2026';
const SECRETARIA_PASSWORD = process.env.SMOKE_SECRETARY_PASSWORD ?? 'recepcion-odontocrm-2026';
const MARK = 'PRUEBA DE HUMO SESION';
/**
 * Cédula del paciente ficticio de la prueba, **distinta en cada corrida** (rango
 * reservado 90.000.000+): una sesión clínica no se puede borrar —es un documento—
 * así que la prueba estrena paciente en lugar de arrastrar lo de la anterior.
 */
const DOC = { type: 'V', number: `90${String(Date.now()).slice(-6)}` };

let token = '';
let failures = 0;

/**
 * Petición por el gateway. `options.token` permite usar el token de **otra**
 * sesión sin tocar la global (lo necesita la comprobación de la secretaría).
 */
const call = async (path, options = {}) => {
  const { token: tokenExplicito, ...resto } = options;
  const usado = tokenExplicito ?? token;
  const response = await fetch(`${GATEWAY}${path}`, {
    ...resto,
    signal: resto.signal ?? AbortSignal.timeout(25_000),
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
  return { status: response.status, body };
};

const check = (label, condition, detail = '') => {
  if (!condition) failures += 1;
  console.log(`${condition ? '✔' : '✖'} ${label}${detail === '' ? '' : ` → ${detail}`}`);
};

/** Código del problema RFC 7807: viaja en el `type` (`…/errors/<código>`). */
const codigoDe = (respuesta) =>
  typeof respuesta.body?.type === 'string'
    ? respuesta.body.type.slice(respuesta.body.type.lastIndexOf('/') + 1)
    : '';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Espera a que la auditoría muestre una acción (el outbox no es instantáneo). */
const esperarAuditoria = async (action, entityId) => {
  for (let intento = 0; intento < 40; intento += 1) {
    const respuesta = await call(
      `/api/v1/audit/events?action=${encodeURIComponent(action)}&entityType=clinical_session&entityId=${encodeURIComponent(entityId)}&pageSize=50`,
    );
    const items = respuesta.body?.items ?? [];
    if (items.length > 0) return items;
    await sleep(250);
  }
  return [];
};

/** Mañana en la zona del consultorio: es el día de la cita de prueba. */
const dia = new Date(Date.now() - 4 * 3_600_000 + 86_400_000).toISOString().slice(0, 10);

const aMinutos = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const enHora = (minutos) =>
  `${String(Math.floor(minutos / 60)).padStart(2, '0')}:${String(minutos % 60).padStart(2, '0')}`;

/**
 * Horas libres del día de prueba, de 30 en 30 minutos.
 *
 * Se leen las citas que ya tiene el día en vez de fijar una hora: una corrida
 * anterior deja las suyas —una cita atendida sigue ocupando su hora— y esta prueba
 * tiene que poder repetirse sin limpiar nada. Se llama **después** de entrar: con
 * el token vacío la consulta respondería 401 y todas las horas parecerían libres.
 */
const horasLibres = async (cuantas) => {
  const respuesta = await call(`/api/v1/appointments?date=${dia}&pageSize=200`);
  const citas = respuesta.body?.items ?? [];
  const libres = [];
  for (let minuto = 7 * 60; minuto <= 20 * 60 && libres.length < cuantas; minuto += 30) {
    const ocupada = citas.some(
      (cita) => aMinutos(cita.startTime) < minuto + 30 && aMinutos(cita.endTime) > minuto,
    );
    if (!ocupada) libres.push(enHora(minuto));
  }
  return libres;
};

const sesionCompleta = {
  motivo: 'Control de la obturación de la 26',
  anamnesis: 'Sin cambios desde la última visita; refiere leve sensibilidad al frío.',
  vitals: {
    taSistolica: 120,
    taDiastolica: 80,
    fc: 72,
    temperatura: 36.5,
    spo2: 98,
    peso: 68.4,
  },
  exam: {
    tejidosBlandos: 'normal',
    encias: 'normal',
    sondaje: '16: 3 mm',
    oclusion: 'normal',
    higiene: 'buena',
    hallazgos: 'Restauración en buen estado',
  },
  procedimientos: [
    {
      code: 'obturacion_resina',
      detalle: null,
      toothNumber: 26,
      surfaces: ['occlusal', 'mesial'],
      notas: 'Ajuste de oclusión',
    },
    { code: 'profilaxis', detalle: null, toothNumber: null, surfaces: [], notas: null },
  ],
  materiales: [{ code: 'resina_compuesta', detalle: null, cantidad: '1 tubo' }],
  diagnostico: 'Caries oclusal en 26',
  indicaciones: 'No comer hasta que pase el efecto de la anestesia',
  proximaCitaFecha: null,
  proximaCitaNota: 'Control en seis meses',
  notasInternas: null,
};

// 1) Sesión del administrador.
const intentarLogin = async (username, password) =>
  call('/api/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });

let login = await intentarLogin(credentials.username, credentials.password);
if (login.status === 401 && credentials.password !== NEW_PASSWORD) {
  const second = await intentarLogin(credentials.username, NEW_PASSWORD);
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

// 2) Paciente ficticio propio de esta prueba (cédula del rango reservado).
const buscarPaciente = async () =>
  call(`/api/v1/patients/lookup?document=${DOC.type}-${DOC.number}`);

let paciente = await buscarPaciente();
if (paciente.body?.found !== true || typeof paciente.body?.patient?.id !== 'string') {
  const creado = await call('/api/v1/patients', {
    method: 'POST',
    body: JSON.stringify({
      docType: DOC.type,
      docNumber: DOC.number,
      fullName: `PACIENTE ${MARK}`,
      birthDate: '1985-02-20',
      sex: 'F',
      phone: '0414-0000000',
      address: 'Dirección de prueba',
      notes: null,
    }),
  });
  check('paciente de prueba creado', creado.status === 201, `status ${creado.status}`);
  paciente = await buscarPaciente();
}
const patientId = paciente.body?.patient?.id;
check('paciente de prueba disponible', typeof patientId === 'string', patientId);
if (typeof patientId !== 'string') process.exit(1);

// 3) Cita de mañana (hora manual): es la que después se marca atendida.
const solicitud = await call('/api/v1/requests', {
  method: 'POST',
  body: JSON.stringify({
    patientId,
    patientName: paciente.body?.patient?.fullName ?? `PACIENTE ${MARK}`,
    patientDocument: `${DOC.type}-${DOC.number}`,
    patientPhone: '0414-0000000',
    channel: 'presencial',
    reason: `${MARK}: control`,
    notes: MARK,
  }),
});
check('la solicitud se crea con su ticket', solicitud.status === 201, solicitud.body?.ticket);

/**
 * Cupo del día: cada corrida deja sus citas (una atendida sigue ocupando su hora),
 * así que si la jornada de prueba está llena se le da cupo explícito para las dos
 * citas de esta corrida —es lo que hace la secretaría cuando el día se llena—.
 */
const vista = await call(`/api/v1/agenda/days/${dia}`);
const cupo = vista.body?.capacity;
const lleno =
  typeof cupo?.assigned === 'number' &&
  typeof cupo?.capacity === 'number' &&
  cupo.assigned + 2 > cupo.capacity;
if (lleno) {
  const ampliado = await call('/api/v1/agenda/capacity', {
    method: 'PUT',
    body: JSON.stringify({ date: dia, capacity: cupo.assigned + 4, reason: MARK }),
  });
  check('el cupo del día de prueba se amplía para las dos citas', ampliado.status === 200);
}

const horas = await horasLibres(6);
if (horas.length < 2) {
  console.error('No quedan horas libres para las citas de la prueba');
  process.exit(1);
}

let cita = { status: 0, body: null };
for (const hora of horas.slice(0, 3)) {
  cita = await call('/api/v1/appointments', {
    method: 'POST',
    body: JSON.stringify({
      requestId: solicitud.body?.id,
      date: dia,
      startTime: hora,
      slotKind: 'manual',
      durationMinutes: 30,
      notes: MARK,
    }),
  });
  if (cita.status === 201) break;
}
check(
  'la cita de prueba se formaliza con hora manual',
  cita.status === 201,
  `status ${cita.status} · ${String(cita.body?.detail ?? '')} · horas ${horas.slice(0, 3).join(', ')}`,
);
const appointmentId = cita.body?.id;
if (typeof appointmentId !== 'string') process.exit(1);

// 4) Abrir la sesión: nace el borrador y queda enlazado a la cita.
const abrirSesion = (body) =>
  call(`/api/v1/clinical/patients/${patientId}/sessions`, {
    method: 'POST',
    body: JSON.stringify(body),
  });

const abierta = await abrirSesion({ appointmentId, motivo: null });
check(
  'la sesión se abre en borrador y con la cita enlazada',
  abierta.status === 201 &&
    abierta.body?.status === 'borrador' &&
    abierta.body?.appointmentId === appointmentId,
  `status ${abierta.status} · ${String(abierta.body?.sessionNumber)}`,
);
const sessionId = abierta.body?.id;
const numeroSesion = abierta.body?.sessionNumber;

const repetida = await abrirSesion({ appointmentId, motivo: 'Otro motivo' });
check(
  'abrir otra vez devuelve el mismo borrador (idempotente)',
  repetida.status === 200 && repetida.body?.id === sessionId,
  `status ${repetida.status}`,
);

// 5) Cerrar en blanco no se puede: una sesión sin contenido no documenta nada.
const cierreEnBlanco = await call(`/api/v1/clinical/sessions/${sessionId}/close`, {
  method: 'POST',
  body: JSON.stringify({ confirm: true }),
});
check(
  'una sesión sin motivo, procedimientos ni diagnóstico no se cierra',
  cierreEnBlanco.status === 409 && codigoDe(cierreEnBlanco) === 'conflict',
  `status ${cierreEnBlanco.status} · ${String(cierreEnBlanco.body?.detail ?? '')}`,
);

// 6) Autoguardado: se manda el documento completo, como hace el formulario.
const guardado = await call(`/api/v1/clinical/sessions/${sessionId}`, {
  method: 'PUT',
  body: JSON.stringify({ content: sesionCompleta }),
});
check(
  'el autoguardado guarda el documento del día',
  guardado.status === 200 &&
    guardado.body?.procedureCount === 2 &&
    guardado.body?.content?.vitals?.taSistolica === 120,
  `status ${guardado.status} · procedimientos ${String(guardado.body?.procedureCount)}`,
);
check(
  'el resumen legible nombra el procedimiento y la pieza',
  typeof guardado.body?.summary === 'string' &&
    guardado.body.summary.includes('Obturación con resina compuesta') &&
    guardado.body.summary.includes('26'),
  guardado.body?.summary,
);
check(
  'las caras van con la pieza del procedimiento',
  guardado.body?.content?.procedimientos?.[0]?.surfaces?.join(',') === 'occlusal,mesial',
);

// Guardar un documento parcial se rechaza: no puede borrar lo que ya estaba.
const parcial = await call(`/api/v1/clinical/sessions/${sessionId}`, {
  method: 'PUT',
  body: JSON.stringify({ content: { motivo: 'solo el motivo' } }),
});
check(
  'el autoguardado exige el documento completo (no borra en silencio)',
  parcial.status === 400,
  `status ${parcial.status}`,
);

// 7) Cerrar la sesión: queda inmutable y auditada.
const cerrada = await call(`/api/v1/clinical/sessions/${sessionId}/close`, {
  method: 'POST',
  body: JSON.stringify({ confirm: true, closureNote: 'Paciente sin molestias' }),
});
check(
  'la sesión se cierra con su nota',
  cerrada.status === 200 &&
    cerrada.body?.status === 'cerrada' &&
    cerrada.body?.closureNote === 'Paciente sin molestias',
  `status ${cerrada.status}`,
);

const editarCerrada = await call(`/api/v1/clinical/sessions/${sessionId}`, {
  method: 'PUT',
  body: JSON.stringify({ content: sesionCompleta }),
});
check(
  'una sesión cerrada no se edita (409)',
  editarCerrada.status === 409,
  `status ${editarCerrada.status}`,
);

const auditoriaCierre = await esperarAuditoria('clinical_session_closed', sessionId);
check(
  'el cierre queda en la auditoría con su resumen y su actor',
  auditoriaCierre.length > 0 &&
    typeof auditoriaCierre[0]?.summary === 'string' &&
    auditoriaCierre[0].summary.includes('cerrada'),
  auditoriaCierre[0]?.summary,
);

// 8) Enmienda: sesión nueva en borrador, la original intacta.
const enmienda = await call(`/api/v1/clinical/sessions/${sessionId}/amend`, {
  method: 'POST',
  body: JSON.stringify({ reason: 'El procedimiento fue en la 27, no en la 26' }),
});
check(
  'la enmienda abre una sesión nueva en borrador enlazada a la original',
  enmienda.status === 201 &&
    enmienda.body?.status === 'borrador' &&
    enmienda.body?.amendedFromId === sessionId,
  `status ${enmienda.status} · ${String(enmienda.body?.sessionNumber)}`,
);

const original = await call(`/api/v1/clinical/sessions/${sessionId}`);
check(
  'la sesión original sigue cerrada y con su contenido',
  original.status === 200 &&
    original.body?.status === 'cerrada' &&
    original.body?.content?.procedimientos?.[0]?.toothNumber === 26,
);

// 9) El odontograma guarda el hallazgo **dentro** de la sesión.
const hallazgo = await call(`/api/v1/odontogram/patients/${patientId}/findings`, {
  method: 'PUT',
  body: JSON.stringify({
    toothNumber: 26,
    surface: 'occlusal',
    condition: 'caries',
    state: 'pendiente',
    notes: 'Registrado en la sesión',
    sessionId,
  }),
});
check(
  'el hallazgo del odontograma queda ligado a la sesión',
  hallazgo.status === 200 &&
    hallazgo.body?.odontogram?.findings?.['26']?.some(
      (fila) => fila.condition === 'caries' && fila.sessionId === sessionId,
    ) === true,
  `status ${hallazgo.status} · sesión ${String(
    hallazgo.body?.odontogram?.findings?.['26']?.[0]?.sessionId,
  )}`,
);

// 10) La cita se marca atendida **sin motivo**, con la sesión cerrada como respaldo.
const flujo = async (accion) =>
  call(`/api/v1/appointments/${appointmentId}/${accion}`, { method: 'POST' });
check('la cita entra a la sala', (await flujo('check-in')).status === 200);
check('la cita se llama', (await flujo('call')).status === 200);
check('la cita pasa a consulta', (await flujo('start')).status === 200);

// Un identificador inventado no sirve de llave: la agenda lo verifica.
const inventada = await call(`/api/v1/appointments/${appointmentId}/attend`, {
  method: 'POST',
  body: JSON.stringify({ clinicalSessionId: '00000000-0000-4000-8000-000000000000' }),
});
check(
  'un identificador de sesión inventado no permite saltarse el motivo',
  inventada.status === 409 && codigoDe(inventada) === 'clinical_session_unverified',
  `status ${inventada.status} · ${codigoDe(inventada)}`,
);

const atendida = await call(`/api/v1/appointments/${appointmentId}/attend`, {
  method: 'POST',
  body: JSON.stringify({ clinicalSessionId: sessionId }),
});
check(
  'con la sesión cerrada, «atendido» no pide motivo y deja la sesión trazada',
  atendida.status === 200 &&
    atendida.body?.status === 'atendido' &&
    atendida.body?.clinicalSessionId === sessionId &&
    atendida.body?.forceAttendedReason === null,
  `status ${atendida.status} · ${String(atendida.body?.clinicalSessionId)}`,
);

// 11) Sin sesión, el «atendido» sigue pidiendo motivo (la regla de la Fase 6).
const citaSinSesion = { status: 0, body: null };
const solicitud2 = await call('/api/v1/requests', {
  method: 'POST',
  body: JSON.stringify({
    patientId,
    patientName: `PACIENTE ${MARK}`,
    patientDocument: `${DOC.type}-${DOC.number}`,
    channel: 'presencial',
    reason: `${MARK}: segunda`,
    notes: MARK,
  }),
});
for (const hora of horas.slice(3, 6)) {
  const intento = await call('/api/v1/appointments', {
    method: 'POST',
    body: JSON.stringify({
      requestId: solicitud2.body?.id,
      date: dia,
      startTime: hora,
      slotKind: 'manual',
      durationMinutes: 30,
      notes: MARK,
    }),
  });
  if (intento.status === 201) {
    citaSinSesion.status = intento.status;
    citaSinSesion.body = intento.body;
    break;
  }
}
if (citaSinSesion.status === 201) {
  const id2 = citaSinSesion.body.id;
  await call(`/api/v1/appointments/${id2}/check-in`, { method: 'POST' });
  await call(`/api/v1/appointments/${id2}/call`, { method: 'POST' });
  await call(`/api/v1/appointments/${id2}/start`, { method: 'POST' });
  const sinSesion = await call(`/api/v1/appointments/${id2}/attend`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  check(
    'sin sesión clínica, «atendido» sigue exigiendo motivo',
    sinSesion.status === 400 && codigoDe(sinSesion) === 'clinical_session_required',
    `status ${sinSesion.status} · ${codigoDe(sinSesion)}`,
  );
} else {
  check('la segunda cita de prueba se formaliza', false, 'no hubo hueco libre');
}

// 12) La secretaría lee la sesión (y la usa para el «atendido») pero no la escribe.
const sesionesDeLaCita = await call(`/api/v1/clinical/appointments/${appointmentId}/sessions`);
check(
  'la agenda puede leer las sesiones de una cita (para el «atendido» sin motivo)',
  sesionesDeLaCita.status === 200 &&
    (sesionesDeLaCita.body?.items ?? []).some((sesion) => sesion.id === sessionId),
  `status ${sesionesDeLaCita.status}`,
);

const secretaria = await (async () => {
  const conSembrada = await call('/api/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'recepcion', password: SECRETARIA_PASSWORD }),
  });
  if (conSembrada.status === 200 || SECRETARIA_PASSWORD === NEW_PASSWORD) return conSembrada;
  return call('/api/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'recepcion', password: NEW_PASSWORD }),
  });
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

  const tokenAdmin = token;
  token = tokenSecretaria;

  const leeSecretaria = await call(`/api/v1/clinical/patients/${patientId}/sessions`);
  check(
    'la secretaría lee la evolución del paciente',
    leeSecretaria.status === 200,
    `status ${leeSecretaria.status}`,
  );

  const abreSecretaria = await abrirSesion({ appointmentId: null, motivo: null });
  check(
    'la secretaría NO puede abrir ni escribir sesiones',
    abreSecretaria.status === 403,
    `status ${abreSecretaria.status}`,
  );

  token = tokenAdmin;
  await call('/api/v1/auth/logout', { method: 'POST' });
} else {
  check(
    'la secretaría está sembrada (se omite la comprobación de permisos)',
    false,
    `login status ${secretaria.status}`,
  );
}

// 13) El historial del paciente se lee de la última a la primera.
const historial = await call(`/api/v1/clinical/patients/${patientId}/sessions`);
const numeros = (historial.body?.items ?? []).map((sesion) => sesion.sessionNumber);
check(
  'la evolución del paciente se lista de la última a la primera',
  historial.status === 200 &&
    numeros.length >= 2 &&
    numeros.every((valor, indice) => indice === 0 || numeros[indice - 1] > valor),
  numeros.join(' > '),
);

console.log(
  `\nSesión: ${String(sessionId ?? 'sin id')} (S-${String(numeroSesion ?? 0).padStart(6, '0')}) · cita ${String(appointmentId)}`,
);
if (failures > 0) {
  console.error(`${String(failures)} comprobación(es) fallaron contra ${GATEWAY}`);
  process.exit(1);
}
console.log('Prueba de humo de la sesión clínica en verde ✔');
