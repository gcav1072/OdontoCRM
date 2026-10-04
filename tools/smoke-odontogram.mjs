#!/usr/bin/env node
/**
 * Prueba de humo de la Fase 6 (sesión B) contra el gateway real: cargar una boca
 * por teclado, comprobar que **la pieza sana es la ausencia de fila**, ver que una
 * pieza completa **supera** sus caras, que borrar deja la pieza sana, que la
 * auditoría guarda cada cambio y que **la secretaría imprime pero no escribe**.
 *
 *   pm2 start infra/windows/ecosystem.config.cjs
 *   npm run smoke:odontogram
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
const SECRETARIA_PASSWORD = process.env.SMOKE_SECRETARY_PASSWORD ?? 'recepcion-odontocrm-2026';
const MARK = 'PRUEBA DE HUMO ODONTOGRAMA';
/** Cédula del paciente ficticio de la prueba (rango reservado 90.000.000+). */
const DOC = { type: 'V', number: '90123456' };

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Espera a que la auditoría muestre una acción (el outbox no es instantáneo). */
const esperarAuditoria = async (action, entityId) => {
  for (let intento = 0; intento < 40; intento += 1) {
    const respuesta = await call(
      `/api/v1/audit/events?action=${encodeURIComponent(action)}&entityType=odontogram&entityId=${encodeURIComponent(entityId)}&pageSize=50`,
    );
    const items = respuesta.body?.items ?? [];
    if (items.length > 0) return items;
    await sleep(250);
  }
  return [];
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

// 2) Un paciente ficticio propio de esta prueba (cédula del rango reservado).
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
      birthDate: '1988-04-12',
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

const odontograma = async () => call(`/api/v1/odontogram/patients/${patientId}`);
const registrar = async (input) =>
  call(`/api/v1/odontogram/patients/${patientId}/findings`, {
    method: 'PUT',
    body: JSON.stringify(input),
  });

// 3) Boca sin registrar: no hay filas, la pieza sana es la ausencia de fila.
let estado = await odontograma();
if (estado.body?.exists === true) {
  // Ejecución repetida: se limpia lo que dejó la anterior para medir desde cero.
  for (const [pieza, hallazgos] of Object.entries(estado.body.odontogram.findings ?? {})) {
    for (const hallazgo of hallazgos) {
      const query = new URLSearchParams({
        toothNumber: pieza,
        condition: hallazgo.condition,
        ...(hallazgo.surface === null ? {} : { surface: hallazgo.surface }),
      });
      await call(`/api/v1/odontogram/patients/${patientId}/findings?${query.toString()}`, {
        method: 'DELETE',
      });
    }
  }
  estado = await odontograma();
}
check(
  'un paciente sin hallazgos se lee como boca sana (sin filas)',
  estado.status === 200 &&
    (estado.body?.exists === false || estado.body?.odontogram?.empty === true),
  `exists=${String(estado.body?.exists)}`,
);

// 4) Carga rápida: la secuencia de teclado de la interfaz, en un solo lote.
const lote = await call(`/api/v1/odontogram/patients/${patientId}/findings/batch`, {
  method: 'POST',
  body: JSON.stringify({
    findings: [
      { toothNumber: 16, surface: 'occlusal', condition: 'caries', state: 'pendiente' },
      { toothNumber: 16, surface: 'mesial', condition: 'caries', state: 'pendiente' },
      { toothNumber: 24, surface: 'vestibular', condition: 'restauracion', state: 'completado' },
      { toothNumber: 36, surface: 'occlusal', condition: 'caries', state: 'completado' },
      { toothNumber: 48, surface: null, condition: 'ausente', state: 'pendiente' },
    ],
  }),
});
check(
  'la carga rápida guarda la boca en una transacción',
  lote.status === 200,
  `status ${lote.status}`,
);
const odontogramId = lote.body?.odontogram?.id;

estado = await odontograma();
const hallazgos = estado.body?.odontogram?.findings ?? {};
const piezas = Object.keys(hallazgos)
  .map(Number)
  .sort((a, b) => a - b);
check(
  'solo aparecen las piezas con hallazgo (16, 24, 36 y 48)',
  piezas.join(',') === '16,24,36,48',
  `piezas ${piezas.join(',')}`,
);
check(
  'una pieza sana (p. ej. la 11) no tiene fila',
  hallazgos['11'] === undefined,
  `findings[11]=${JSON.stringify(hallazgos['11'])}`,
);
check(
  'los colores del doc: caries pendiente y restauración completada',
  hallazgos['16']?.some((h) => h.state === 'pendiente') === true &&
    hallazgos['24']?.some((h) => h.state === 'completado') === true,
);
check('la dentición se deduce del número FDI', estado.body?.odontogram?.dentition === 'permanente');
check(
  'el odontograma resume las piezas afectadas',
  estado.body?.odontogram?.affectedTeeth?.length === 4,
  JSON.stringify(estado.body?.odontogram?.affectedTeeth),
);

// 5) Repetir el mismo hallazgo no escribe ni audita: el autoguardado no ensucia.
const repetido = await registrar({
  toothNumber: 16,
  surface: 'occlusal',
  condition: 'caries',
  state: 'pendiente',
});
check('repetir el mismo hallazgo responde «sin cambios»', repetido.body?.unchanged === true);

// 6) Cambiar el estado del hallazgo lo actualiza (y queda en la auditoría).
const completado = await registrar({
  toothNumber: 16,
  surface: 'occlusal',
  condition: 'caries',
  state: 'completado',
});
check(
  'el estado de la cara se actualiza',
  completado.status === 200 &&
    completado.body?.odontogram?.findings?.['16']?.some(
      (h) => h.surface === 'occlusal' && h.state === 'completado',
    ) === true,
);
const auditoriaActualizado = await esperarAuditoria('tooth_finding_updated', odontogramId);
check(
  'el cambio de estado queda en la auditoría de identity',
  auditoriaActualizado.length > 0,
  `${String(auditoriaActualizado.length)} evento(s)`,
);

// 7) La pieza completa manda sobre las caras: la 16 pasa a ausente.
const ausente = await registrar({ toothNumber: 16, surface: null, condition: 'ausente' });
check(
  'marcar la pieza completa informa de las caras superadas',
  ausente.status === 200 &&
    Array.isArray(ausente.body?.resolvedSurfaces) &&
    ausente.body.resolvedSurfaces.length === 2,
  JSON.stringify(ausente.body?.resolvedSurfaces),
);
estado = await odontograma();
const caras16 = (estado.body?.odontogram?.findings?.['16'] ?? []).filter((h) => h.surface !== null);
check(
  'las caras superadas dejan de leerse (la 16 solo muestra «ausente»)',
  caras16.length === 0,
  JSON.stringify(estado.body?.odontogram?.findings?.['16']),
);
const auditoriaSuperado = await esperarAuditoria('tooth_finding_superseded', odontogramId);
check(
  'la superación de caras queda auditada',
  auditoriaSuperado.length > 0,
  `${String(auditoriaSuperado.length)} evento(s)`,
);

// 8) En sentido contrario el servidor se niega: primero hay que quitar «ausente».
const contradiccion = await registrar({
  toothNumber: 16,
  surface: 'distal',
  condition: 'caries',
  state: 'pendiente',
});
check(
  'una cara sobre una pieza completa vigente se rechaza con 409',
  contradiccion.status === 409,
  `status ${contradiccion.status}`,
);

// 9) Borrar la pieza completa y dejar una cara sana devuelven la pieza a sana.
const quitarAusente = await call(
  `/api/v1/odontogram/patients/${patientId}/findings?toothNumber=16&condition=ausente`,
  { method: 'DELETE' },
);
check('quitar la condición de pieza completa', quitarAusente.status === 200);
const caraSana = await call(`/api/v1/odontogram/patients/${patientId}/surfaces/36/occlusal`, {
  method: 'DELETE',
});
check('dejar una cara sana limpia la cara', caraSana.status === 200);

estado = await odontograma();
const piezasTras = Object.keys(estado.body?.odontogram?.findings ?? {})
  .map(Number)
  .sort((a, b) => a - b);
check(
  'las piezas borradas vuelven a estar sanas (solo quedan 24 y 48)',
  piezasTras.join(',') === '24,48',
  `piezas ${piezasTras.join(',')}`,
);
const auditoriaBorrado = await esperarAuditoria('tooth_finding_removed', odontogramId);
check(
  'el borrado queda en la auditoría',
  auditoriaBorrado.length > 0,
  `${String(auditoriaBorrado.length)} evento(s)`,
);

// 10) La excepción clínica (ADR 0032): un tratamiento convive con las caras.
//     Corona sobre un diente obturado, conducto con su restauración: la boca normal.
const coronaConCaries = await registrar({
  toothNumber: 25,
  surface: null,
  condition: 'corona',
  state: 'completado',
});
check(
  'una corona no supera las caras: se registra junto a lo que hubiera',
  coronaConCaries.status === 200 &&
    Array.isArray(coronaConCaries.body?.resolvedSurfaces) &&
    coronaConCaries.body.resolvedSurfaces.length === 0,
  JSON.stringify(coronaConCaries.body?.resolvedSurfaces),
);

const cariesSobreCorona = await registrar({
  toothNumber: 25,
  surface: 'occlusal',
  condition: 'caries',
  state: 'pendiente',
});
check(
  'una caries se registra en una pieza con corona',
  cariesSobreCorona.status === 200,
  `status ${cariesSobreCorona.status}`,
);

const conductoConCorona = await registrar({
  toothNumber: 25,
  surface: null,
  condition: 'endodoncia',
});
check(
  'el conducto convive con la corona y con la caries',
  conductoConCorona.status === 200 &&
    conductoConCorona.body?.odontogram?.findings?.['25']?.length === 3,
  `filas en la 25: ${String(conductoConCorona.body?.odontogram?.findings?.['25']?.length)}`,
);

// Y las parejas imposibles siguen bloqueadas: un implante no tiene raíz.
const parejaImposible = await call(`/api/v1/odontogram/patients/${patientId}/findings/batch`, {
  method: 'POST',
  body: JSON.stringify({
    findings: [
      { toothNumber: 44, surface: null, condition: 'implante', state: 'completado' },
      { toothNumber: 44, surface: null, condition: 'endodoncia', state: 'pendiente' },
    ],
  }),
});
check(
  'implante con endodoncia en la misma pieza se rechaza (409)',
  parejaImposible.status === 409,
  `status ${parejaImposible.status}`,
);

// El caso que pidió el odontólogo: la pieza sin corona natural **y** con implante
// (fase quirúrgica) es una boca real, no una contradicción.
const faseQuirurgica = await call(`/api/v1/odontogram/patients/${patientId}/findings/batch`, {
  method: 'POST',
  body: JSON.stringify({
    findings: [
      { toothNumber: 35, surface: null, condition: 'implante', state: 'completado' },
      { toothNumber: 35, surface: null, condition: 'ausente', state: 'completado' },
    ],
  }),
});
const filas35 = faseQuirurgica.body?.odontogram?.findings?.['35'] ?? [];
check(
  'la pieza ausente con implante se registra (fase quirúrgica)',
  faseQuirurgica.status === 200 && filas35.length === 2,
  `status ${faseQuirurgica.status}, filas en la 35: ${String(filas35.length)}`,
);
// El alta de un hallazgo suelto es PUT; POST es el lote (la hoja táctil).
const coronaSobreAusente = await call(`/api/v1/odontogram/patients/${patientId}/findings`, {
  method: 'PUT',
  body: JSON.stringify({
    toothNumber: 35,
    surface: null,
    condition: 'corona',
    state: 'completado',
  }),
});
check(
  'y la corona protésica exige quitar antes la ausencia (409)',
  coronaSobreAusente.status === 409,
  `status ${coronaSobreAusente.status} · ${JSON.stringify(coronaSobreAusente.body)}`,
);

// El lote que manda la hoja táctil: corona con la caries que tenía debajo, en una
// transacción. La corona **recubre el muñón**, así que las caras quedan cubiertas (el
// gráfico enseña la corona sola) pero el dato sigue en la base y en el histórico.
const loteTactil = await call(`/api/v1/odontogram/patients/${patientId}/findings/batch`, {
  method: 'POST',
  body: JSON.stringify({
    findings: [
      { toothNumber: 46, surface: null, condition: 'corona', state: 'completado' },
      { toothNumber: 46, surface: 'occlusal', condition: 'caries', state: 'pendiente' },
      { toothNumber: 46, surface: 'mesial', condition: 'caries', state: 'pendiente' },
    ],
  }),
});
check(
  'el lote táctil guarda la corona y cubre las caras de una vez',
  loteTactil.status === 200 &&
    loteTactil.body?.odontogram?.findings?.['46']?.length === 1 &&
    loteTactil.body?.odontogram?.findings?.['46']?.[0]?.condition === 'corona',
  `status ${loteTactil.status} · filas ${JSON.stringify(loteTactil.body?.odontogram?.findings?.['46']?.map((fila) => fila.condition))}`,
);
check(
  'y las caras cubiertas vuelven en la respuesta como superadas',
  Array.isArray(loteTactil.body?.resolvedSurfaces) && loteTactil.body.resolvedSurfaces.length === 2,
  `caras superadas: ${JSON.stringify(loteTactil.body?.resolvedSurfaces)}`,
);

// La caries que aparece **después** de la corona (filtración marginal) sí se ve.
const recurrente = await call(`/api/v1/odontogram/patients/${patientId}/findings`, {
  method: 'PUT',
  body: JSON.stringify({
    toothNumber: 46,
    surface: 'vestibular',
    condition: 'caries',
    state: 'pendiente',
  }),
});
check(
  'la caries recurrente sobre la corona se registra encima',
  recurrente.status === 200 &&
    recurrente.body?.odontogram?.findings?.['46']?.length === 2 &&
    recurrente.body.resolvedSurfaces.length === 0,
  `status ${recurrente.status} · filas ${String(recurrente.body?.odontogram?.findings?.['46']?.length)}`,
);

// 11) El histórico append-only conserva todo lo que pasó, incluido lo superado.
const historial = await call(`/api/v1/odontogram/patients/${patientId}/history?limit=200`);
const eventos = (historial.body?.entries ?? []).map((entrada) => entrada.event);
check('el histórico responde', historial.status === 200, `status ${historial.status}`);
check(
  'el histórico conserva registrado, actualizado, superado y eliminado',
  ['registrado', 'actualizado', 'superado', 'eliminado'].every((evento) =>
    eventos.includes(evento),
  ),
  [...new Set(eventos)].join(', '),
);

// 12) La impresión deja constancia con su actor.
const impreso = await call(`/api/v1/odontogram/patients/${patientId}/printed`, { method: 'POST' });
check(
  'la impresión incrementa el contador',
  impreso.status === 200 && impreso.body?.printCount >= 1,
  `printCount=${String(impreso.body?.printCount)}`,
);
const auditoriaImpresion = await esperarAuditoria('odontogram_printed', odontogramId);
check(
  'la impresión queda auditada con su actor',
  auditoriaImpresion.length > 0 && typeof auditoriaImpresion[0]?.actorUsername === 'string',
  auditoriaImpresion[0]?.actorUsername,
);

// 12) La secretaría imprime (lee) pero no escribe: `odontogram:read` sin `write`.
//
// La cuenta sembrada tiene contraseña temporal, y mientras no se cambie **ningún**
// permiso responde (403 a todo). Así que la prueba la cambia, como hacen los demás
// humos con el admin; al terminar hay que restaurarla:
//   npm run seed:users -- --reset
const secretaria = await (async () => {
  const conSembrada = await call('/api/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'recepcion', password: SECRETARIA_PASSWORD }),
  });
  // Una corrida anterior ya le cambió la contraseña: se prueba la de la prueba.
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
  const leeSecretaria = await call(`/api/v1/odontogram/patients/${patientId}`);
  check(
    'la secretaría lee el odontograma del paciente',
    leeSecretaria.status === 200,
    `status ${leeSecretaria.status}`,
  );
  const imprimeSecretaria = await call(`/api/v1/odontogram/patients/${patientId}/printed`, {
    method: 'POST',
  });
  check(
    'la secretaría puede imprimir el odontograma (imprimir es leer)',
    imprimeSecretaria.status === 200,
    `status ${imprimeSecretaria.status}`,
  );
  const escribeSecretaria = await registrar({
    toothNumber: 11,
    surface: 'occlusal',
    condition: 'caries',
    state: 'pendiente',
  });
  check(
    'la secretaría NO puede escribir en el odontograma',
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

// 13) La impresión de la historia sigue funcionando (no hay regresión de la 6A).
const historia = await call(`/api/v1/clinical/patients/${patientId}/record`);
check(
  'la historia clínica de la Fase 6A sigue respondiendo',
  historia.status === 200,
  `status ${historia.status}`,
);

// 14) Estado final, tal como quedó la boca (la limpieza de la próxima corrida
//     empieza borrando lo que encuentre, así que aquí no se toca nada).
estado = await odontograma();
const piezasFinales = Object.keys(estado.body?.odontogram?.findings ?? {})
  .map(Number)
  .sort((a, b) => a - b);

console.log(
  `\nOdontograma: ${String(odontogramId ?? 'sin id')} · piezas al final: ${piezasFinales.join(', ')}`,
);
if (failures > 0) {
  console.error(`${String(failures)} comprobación(es) fallaron contra ${GATEWAY}`);
  process.exit(1);
}
console.log('Prueba de humo del odontograma en verde ✔');
