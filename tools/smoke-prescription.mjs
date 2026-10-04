#!/usr/bin/env node
/**
 * Prueba de humo de la Fase 7 (sesión B) contra el gateway real: abrir una sesión,
 * subir una radiografía, preparar el récipe, **emitirlo** (número + PDF A5
 * archivado), descargar el PDF, **verificar el QR sin sesión** desde la página
 * pública, dejar constancia de la reimpresión, anular con motivo y comprobar que el
 * adjunto no se borra en una sesión cerrada ni el récipe se emite dos veces.
 *
 *   pm2 start infra/windows/ecosystem.config.cjs
 *   npm run smoke:prescription
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
const MARK = 'PRUEBA DE HUMO RECIPE';
/** Cédula del paciente ficticio (rango reservado 90.000.000+), nueva en cada corrida. */
const DOC = { type: 'V', number: `91${String(Date.now()).slice(-6)}` };

/** PNG 1×1: sirve para probar el camino del archivo sin subir megabytes. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AARAAB/wD/AH8hAAAAAElFTkSuQmCC',
  'base64',
);

let token = '';
let failures = 0;

const call = async (path, options = {}) => {
  const { token: tokenExplicito, ...resto } = options;
  const usado = tokenExplicito ?? token;
  const response = await fetch(`${GATEWAY}${path}`, {
    ...resto,
    signal: resto.signal ?? AbortSignal.timeout(60_000),
    headers: {
      ...(usado === '' ? {} : { authorization: `Bearer ${usado}` }),
      ...(resto.body === undefined || resto.body instanceof FormData
        ? {}
        : { 'content-type': 'application/json' }),
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
};

/** Descarga binaria (PDF del récipe): no se parsea como JSON. */
const descargar = async (path, opciones = {}) => {
  const usado = opciones.token ?? token;
  const response = await fetch(`${GATEWAY}${path}`, {
    headers: { authorization: `Bearer ${usado}` },
    signal: AbortSignal.timeout(60_000),
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  return {
    status: response.status,
    type: response.headers.get('content-type') ?? '',
    buffer,
  };
};

const check = (label, condition, detail = '') => {
  if (!condition) failures += 1;
  console.log(`${condition ? '✔' : '✖'} ${label}${detail === '' ? '' : ` → ${detail}`}`);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Espera a que la auditoría muestre una acción (el outbox no es instantáneo). */
const esperarAuditoria = async (action, entityType, entityId) => {
  for (let intento = 0; intento < 40; intento += 1) {
    const respuesta = await call(
      `/api/v1/audit/events?action=${encodeURIComponent(action)}&entityType=${entityType}&entityId=${encodeURIComponent(entityId)}&pageSize=50`,
    );
    const items = respuesta.body?.items ?? [];
    if (items.length > 0) return items;
    await sleep(250);
  }
  return [];
};

// 1) Sesión del administrador.
const intentarLogin = async (username, password) =>
  call('/api/v1/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });

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

// 2) Paciente ficticio propio de esta corrida.
const creado = await call('/api/v1/patients', {
  method: 'POST',
  body: JSON.stringify({
    docType: DOC.type,
    docNumber: DOC.number,
    fullName: `PACIENTE ${MARK}`,
    birthDate: '1979-06-15',
    sex: 'M',
    phone: '0414-0000000',
    address: 'Dirección de prueba',
    notes: null,
  }),
});
check('paciente de prueba creado', creado.status === 201, `status ${creado.status}`);
const patientId = creado.body?.id;
if (typeof patientId !== 'string') process.exit(1);

// 3) Sesión de hoy (el récipe cuelga de ella).
const abierta = await call(`/api/v1/clinical/patients/${patientId}/sessions`, {
  method: 'POST',
  body: JSON.stringify({ appointmentId: null, motivo: 'Dolor en la 36' }),
});
check('la sesión se abre', abierta.status === 201, `status ${abierta.status}`);
const sessionId = abierta.body?.id;

// 4) Adjunto: una radiografía con su pieza y su pie de foto (multipart).
const formulario = new FormData();
formulario.append('file', new Blob([PNG], { type: 'image/png' }), 'periapical-36.png');
formulario.append('kind', 'radiografia');
formulario.append('caption', 'Periapical de la 36');
formulario.append('toothNumber', '36');
const subida = await call(`/api/v1/clinical/sessions/${sessionId}/attachments`, {
  method: 'POST',
  body: formulario,
});
check(
  'la radiografía se sube a la sesión con su pieza',
  subida.status === 201 && subida.body?.toothNumber === 36 && subida.body?.kind === 'radiografia',
  `status ${subida.status}`,
);
const attachmentId = subida.body?.id;

const listado = await call(`/api/v1/clinical/sessions/${sessionId}/attachments`);
check(
  'el adjunto aparece en la sesión',
  listado.status === 200 && (listado.body?.items ?? []).some((item) => item.id === attachmentId),
);

const descargaAdjunto = await descargar(
  `/api/v1/clinical/sessions/${sessionId}/attachments/${attachmentId}`,
);
check(
  'el adjunto se descarga por el endpoint autorizado',
  descargaAdjunto.status === 200 && descargaAdjunto.buffer.byteLength === PNG.byteLength,
  `${String(descargaAdjunto.buffer.byteLength)} bytes`,
);

const delPaciente = await call(`/api/v1/clinical/patients/${patientId}/attachments`);
check(
  'los adjuntos del paciente se ven en su ficha',
  delPaciente.status === 200 && (delPaciente.body?.items ?? []).length === 1,
);

// 5) Un tipo que no se admite se rechaza.
const malo = new FormData();
malo.append('file', new Blob([Buffer.from('MZ')], { type: 'application/x-msdownload' }), 'x.exe');
malo.append('kind', 'documento');
const rechazado = await call(`/api/v1/clinical/sessions/${sessionId}/attachments`, {
  method: 'POST',
  body: malo,
});
check(
  'un ejecutable no se admite como adjunto',
  rechazado.status === 415,
  `status ${rechazado.status}`,
);

// 6) Catálogo de medicamentos y récipe.
const catalogo = await call('/api/v1/clinical/medications?search=amoxi');
check(
  'el catálogo de medicamentos responde y se busca',
  catalogo.status === 200 && (catalogo.body?.items ?? []).length >= 1,
  `${String(catalogo.body?.total ?? 0)} resultado(s)`,
);

const guardado = await call(`/api/v1/clinical/sessions/${sessionId}/prescription`, {
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
      },
    ],
    generalInstructions: 'Volver si el dolor no cede en 48 horas.',
  }),
});
check(
  'el borrador del récipe se guarda con sus medicamentos',
  guardado.status === 200 && guardado.body?.itemCount === 2,
  `status ${guardado.status}`,
);
const prescriptionId = guardado.body?.id;

const emitido = await call(`/api/v1/clinical/prescriptions/${prescriptionId}/issue`, {
  method: 'POST',
  body: JSON.stringify({ confirm: true }),
});
check(
  'el récipe se emite con número y código de verificación',
  emitido.status === 200 &&
    /^RX-\d{6}$/.test(emitido.body?.number ?? '') &&
    /^[A-Z0-9]{5}-[A-Z0-9]{5}$/.test(emitido.body?.verifyCode ?? ''),
  `${String(emitido.body?.number)} · ${String(emitido.body?.verifyCode)}`,
);

const pdf = await descargar(`/api/v1/clinical/prescriptions/${prescriptionId}/pdf`);
check(
  'el PDF A5 queda archivado y se descarga',
  pdf.status === 200 &&
    pdf.buffer.subarray(0, 5).toString() === '%PDF-' &&
    pdf.buffer.byteLength > 15_000,
  `${String(pdf.buffer.byteLength)} bytes`,
);

const dosVeces = await call(`/api/v1/clinical/prescriptions/${prescriptionId}/issue`, {
  method: 'POST',
  body: JSON.stringify({ confirm: true }),
});
check('no se emite dos veces', dosVeces.status === 409, `status ${dosVeces.status}`);

// 7) La reimpresión deja constancia.
const impresion = await call(`/api/v1/clinical/prescriptions/${prescriptionId}/printed`, {
  method: 'POST',
});
check(
  'la impresión incrementa el contador',
  impresion.status === 200 && impresion.body?.printCount === 1,
  `printCount=${String(impresion.body?.printCount)}`,
);
const auditoriaImpresion = await esperarAuditoria(
  'prescription_reprinted',
  'prescription',
  prescriptionId,
);
check(
  'la reimpresión queda auditada con su actor',
  auditoriaImpresion.length > 0 && typeof auditoriaImpresion[0]?.actorUsername === 'string',
  auditoriaImpresion[0]?.actorUsername,
);

// 8) **La verificación pública: sin sesión**, como la abre el QR.
const codigo = String(emitido.body?.verifyCode ?? '');
const verificacion = await call(`/api/v1/clinical/verify/${codigo}`, { token: '' });
check(
  'el código del QR se verifica SIN sesión',
  verificacion.status === 200 && verificacion.body?.valid === true,
  `status ${verificacion.status}`,
);
check(
  'la verificación confirma el récipe sin datos clínicos',
  verificacion.body?.patientReference === 'PACIENTE P.' &&
    verificacion.body?.itemCount === 2 &&
    verificacion.body?.status === 'emitida' &&
    !JSON.stringify(verificacion.body).includes('Amoxicilina'),
  `${String(verificacion.body?.patientReference)} · ${String(verificacion.body?.itemCount)} medicamento(s)`,
);

const sinGuion = codigo.replace('-', '').toLowerCase();
const verificacionFlexible = await call(`/api/v1/clinical/verify/${sinGuion}`, { token: '' });
check(
  'el código se acepta con guion, sin guion y en minúsculas',
  verificacionFlexible.status === 200 && verificacionFlexible.body?.valid === true,
);

const inventado = await call('/api/v1/clinical/verify/ZZZZZ-ZZZZZ', { token: '' });
check(
  'un código inventado responde «no consta» (sin sesión y sin 404)',
  inventado.status === 200 && inventado.body?.valid === false,
  `status ${inventado.status}`,
);

// 9) El récipe aparece en el historial del paciente.
const historial = await call(`/api/v1/clinical/patients/${patientId}/prescriptions`);
check(
  'el récipe aparece en el historial con su PDF',
  historial.status === 200 &&
    (historial.body?.items ?? []).some((item) => item.id === prescriptionId && item.hasPdf),
);

// 10) Anular con motivo: el PDF sigue archivado y la verificación lo dice.
const anulado = await call(`/api/v1/clinical/prescriptions/${prescriptionId}/annul`, {
  method: 'POST',
  body: JSON.stringify({ reason: 'El paciente ya estaba tomando el antibiótico' }),
});
check(
  'el récipe se anula con su motivo',
  anulado.status === 200 &&
    anulado.body?.status === 'anulada' &&
    anulado.body?.annulReason?.includes('antibiótico'),
  `status ${anulado.status}`,
);

const verificacionAnulada = await call(`/api/v1/clinical/verify/${codigo}`, { token: '' });
check(
  'la verificación pública avisa de que está anulado',
  verificacionAnulada.body?.valid === true && verificacionAnulada.body?.status === 'anulada',
);

// 11) Cerrar la sesión y comprobar que lo cerrado no se toca.
const cerrada = await call(`/api/v1/clinical/sessions/${sessionId}/close`, {
  method: 'POST',
  body: JSON.stringify({ confirm: true, closureNote: 'Sin molestias' }),
});
check('la sesión se cierra', cerrada.status === 200, `status ${cerrada.status}`);

const borrarCerrada = await call(
  `/api/v1/clinical/sessions/${sessionId}/attachments/${attachmentId}`,
  { method: 'DELETE' },
);
check(
  'un adjunto de una sesión cerrada no se borra',
  borrarCerrada.status === 409,
  `status ${borrarCerrada.status}`,
);

const editarCerrada = await call(`/api/v1/clinical/prescriptions/${prescriptionId}/annul`, {
  method: 'POST',
  body: JSON.stringify({ reason: 'otra vez' }),
});
check(
  'un récipe anulado no se anula dos veces',
  editarCerrada.status === 409,
  `status ${editarCerrada.status}`,
);

const auditoriaEmision = await esperarAuditoria(
  'prescription_issued',
  'prescription',
  prescriptionId,
);
check(
  'la emisión queda en la auditoría con su número',
  auditoriaEmision.length > 0 &&
    auditoriaEmision[0]?.summary?.includes(String(emitido.body?.number)),
  auditoriaEmision[0]?.summary,
);

// 12) La secretaría imprime (lee) los récipes pero no los escribe.
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

  const listaSecretaria = await call(`/api/v1/clinical/sessions/${sessionId}/prescriptions`);
  check(
    'la secretaría ve los récipes de la sesión',
    listaSecretaria.status === 200,
    `status ${listaSecretaria.status}`,
  );

  const pdfSecretaria = await descargar(`/api/v1/clinical/prescriptions/${prescriptionId}/pdf`, {
    token: tokenSecretaria,
  });
  check(
    'la secretaría puede descargar el PDF (imprimir es leer)',
    pdfSecretaria.status === 200 && pdfSecretaria.buffer.byteLength > 15_000,
    `status ${pdfSecretaria.status}`,
  );

  const escribeSecretaria = await call(`/api/v1/clinical/sessions/${sessionId}/prescription`, {
    method: 'PUT',
    body: JSON.stringify({
      items: [{ medicationName: 'Ibuprofeno', dose: '400 mg', frequency: 'cada 8 horas' }],
    }),
  });
  check(
    'la secretaría NO puede escribir récipes',
    escribeSecretaria.status === 403,
    `status ${escribeSecretaria.status}`,
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

console.log(
  `\nRécipe: ${String(emitido.body?.number)} · código ${codigo} · sesión ${String(sessionId)}`,
);
if (failures > 0) {
  console.error(`${String(failures)} comprobación(es) fallaron contra ${GATEWAY}`);
  process.exit(1);
}
console.log('Prueba de humo del récipe A5 en verde ✔');
