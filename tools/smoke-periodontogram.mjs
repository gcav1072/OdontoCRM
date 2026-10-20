#!/usr/bin/env node
/**
 * Prueba de humo del **periodontograma** (v1.1) contra el gateway real: abrir un
 * examen, guardar un borrador con mediciones, comprobar que la revisión optimista
 * rechaza el guardado viejo (409), que el examen **finalizado es inmutable**, que el
 * clon del examen anterior se compara sitio a sitio, que imprimir deja constancia y
 * que la secretaría **lee e imprime pero no escribe**.
 *
 *   pm2 start infra/windows/ecosystem.config.cjs
 *   npm run smoke:periodontogram
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
const MARK = 'PRUEBA DE HUMO PERIODONTOGRAMA';
/** Cédula del paciente ficticio de la prueba (rango reservado 90.000.000+). */
const DOC = { type: 'V', number: '90123456' };

/**
 * Orden **canónico** de las 32 piezas del examen (el que valida el contrato):
 * maxilar 18→28 y después mandíbula 48→38.
 */
const ARCADA_MAXILAR = [18, 17, 16, 15, 14, 13, 12, 11, 21, 22, 23, 24, 25, 26, 27, 28];
const ARCADA_MANDIBULA = [48, 47, 46, 45, 44, 43, 42, 41, 31, 32, 33, 34, 35, 36, 37, 38];
const PIEZAS = [...ARCADA_MAXILAR, ...ARCADA_MANDIBULA];

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
      `/api/v1/audit/events?action=${encodeURIComponent(action)}&entityType=periodontogram&entityId=${encodeURIComponent(entityId)}&pageSize=50`,
    );
    const items = respuesta.body?.items ?? [];
    if (items.length > 0) return items;
    await sleep(250);
  }
  return [];
};

/* ── La boca de la prueba (arma el JSONB `teeth_data` del contrato) ─────────── */

/**
 * Un sitio. `pd` y `gm` a `null` es «sin sondar»: el contrato no admite inventar
 * ceros, así que la boca vacía no mide nada.
 */
const sitio = (pd = null, gm = null, marcas = {}) => ({
  pd,
  gm,
  bop: false,
  plaque: false,
  suppuration: false,
  ...marcas,
});

/** Tres sitios de una cara, en orden visual `[izquierda, centro, derecha]`. */
const cara = (medidas = []) =>
  [0, 1, 2].map((indice) => {
    const medida = medidas[indice] ?? [];
    return sitio(medida[0] ?? null, medida[1] ?? null, medida[2] ?? {});
  });

/** Una pieza sin datos, tal como nace un examen en blanco. */
const pieza = (fdi) => ({
  fdi,
  missing: false,
  implant: false,
  mobility: null,
  furcation: {},
  vestibular: cara(),
  lingual: cara(),
  notes: null,
});

/** Boca vacía con las 32 piezas en orden canónico. */
const bocaVacia = () => PIEZAS.map((fdi) => pieza(fdi));

/** Busca una pieza de la boca por su FDI (falla pronto si el orden se rompió). */
const buscarPieza = (boca, fdi) => {
  const encontrada = boca.find((item) => item.fdi === fdi);
  if (encontrada === undefined) throw new Error(`La boca de la prueba no tiene la pieza ${fdi}`);
  return encontrada;
};

/**
 * Boca con hallazgos repartidos para que los índices tengan algo que medir:
 * una pieza natural con bolsa y sangrado (16 y 26), movilidad y furca (36), un
 * implante que se sonda (46) y una pieza ausente sin sitios (48).
 */
const bocaConMediciones = () => {
  const boca = bocaVacia();

  const molarSuperiorDerecho = buscarPieza(boca, 16);
  molarSuperiorDerecho.vestibular = cara([
    [3, 0],
    [5, 0, { bop: true }],
    [4, -1],
  ]);

  const molarSuperiorIzquierdo = buscarPieza(boca, 26);
  molarSuperiorIzquierdo.lingual = cara([
    [6, 0, { bop: true }],
    [6, 0, { bop: true }],
    [5, 0],
  ]);

  const molarInferiorIzquierdo = buscarPieza(boca, 36);
  molarInferiorIzquierdo.vestibular = cara([
    [4, 0],
    [5, 0],
    [3, 0],
  ]);
  molarInferiorIzquierdo.mobility = 2;
  // El 36 admite furca vestibular y lingual (regla anatómica del contrato).
  molarInferiorIzquierdo.furcation = { vestibular: 2 };

  // El implante se sondea (mucositis/periimplantitis), pero no lleva movilidad ni furca.
  const implanteInferiorDerecho = buscarPieza(boca, 46);
  implanteInferiorDerecho.implant = true;
  implanteInferiorDerecho.vestibular = cara([
    [4, 0, { plaque: true }],
    [3, 0],
    [3, 0],
  ]);

  // La pieza ausente no tiene sitios ni movilidad: se marca y se deja vacía.
  buscarPieza(boca, 48).missing = true;

  const incisivoSuperiorDerecho = buscarPieza(boca, 11);
  incisivoSuperiorDerecho.lingual = cara([
    [2, 0],
    [2, 0],
    [2, -1],
  ]);

  return boca;
};

/** Cuerpo del `PUT .../periodontograms/:examId` (contrato `SavePeriodontalExamInput`). */
const cuerpoGuardado = (revision, chart, fechaExamen) => ({
  revision,
  examDate: fechaExamen,
  chart,
  riskFactors: { smoking: 'menos10', diabetes: 'no', hba1c: null },
  diagnosis: { stage: 2, grade: 'B', notes: 'Clasificación de la prueba de humo' },
  notes: null,
});

/* ── 1) Sesión del administrador ───────────────────────────────────────────── */

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

/* ── 2) El paciente ficticio y la limpieza de la corrida anterior ──────────── */

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

const rutaExamenes = `/api/v1/odontogram/patients/${patientId}/periodontograms`;
const listarExamenes = (query = '') => call(`${rutaExamenes}${query}`);
const ultimoExamen = () => call(`${rutaExamenes}/latest`);
const detalleExamen = (examId) => call(`${rutaExamenes}/${examId}`);
const crearExamen = (input) => call(rutaExamenes, { method: 'POST', body: JSON.stringify(input) });
const guardarExamen = (examId, input) =>
  call(`${rutaExamenes}/${examId}`, { method: 'PUT', body: JSON.stringify(input) });
const finalizarExamen = (examId, input) =>
  call(`${rutaExamenes}/${examId}/finalize`, { method: 'POST', body: JSON.stringify(input) });
const compararExamen = (examId, withExamId) =>
  call(`${rutaExamenes}/${examId}/compare?with=${encodeURIComponent(withExamId)}`);
const registrarImpresion = (examId) =>
  call(`${rutaExamenes}/${examId}/printed`, { method: 'POST' });

// Un solo borrador por paciente (índice parcial de la base): para medir desde cero,
// primero se descartan los borradores que dejara una corrida anterior.
const anteriores = await listarExamenes('?limit=100');
const borradoresPrevios = (anteriores.body?.items ?? []).filter(
  (examen) => examen.status === 'borrador',
);
for (const borrador of borradoresPrevios) {
  await call(`${rutaExamenes}/${borrador.id}`, { method: 'DELETE' });
}

// 3) Abrir un examen: nace en blanco, con las 32 piezas y revisión 0.
const creado = await crearExamen({ source: 'blanco', previousExamId: null, sessionId: null });
const examId = creado.body?.exam?.id;
check(
  'se crea el periodontograma del paciente',
  (creado.status === 201 || creado.status === 200) && typeof examId === 'string',
  `status ${creado.status}`,
);
if (typeof examId !== 'string') process.exit(1);
check(
  'el examen nace como borrador con las 32 piezas en orden canónico',
  creado.body?.exam?.status === 'borrador' &&
    creado.body?.exam?.revision === 0 &&
    creado.body?.exam?.chart?.length === 32 &&
    creado.body.exam.chart[0]?.fdi === 18 &&
    creado.body.exam.chart[32 - 1]?.fdi === 38,
  `status=${String(creado.body?.exam?.status)} revisión=${String(creado.body?.exam?.revision)}`,
);
const fechaExamen = creado.body?.exam?.examDate;
check(
  'la fecha clínica del examen viaja en el DTO',
  typeof fechaExamen === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(fechaExamen),
  fechaExamen,
);

// 4) `latest` devuelve el examen recién abierto y la ficha del paciente.
const ultimo = await ultimoExamen();
check(
  'latest devuelve el examen abierto y su paciente',
  ultimo.status === 200 &&
    ultimo.body?.exists === true &&
    ultimo.body?.exam?.id === examId &&
    typeof ultimo.body?.exam?.patientId === 'string',
  `exists=${String(ultimo.body?.exists)}`,
);

// 5) Guardar el borrador con la boca medida: la revisión pasa de 0 a 1.
const guardado = await guardarExamen(examId, cuerpoGuardado(0, bocaConMediciones(), fechaExamen));
check(
  'guarda el borrador con la boca medida',
  guardado.status === 200 && guardado.body?.unchanged === false,
  `status ${guardado.status}`,
);
const metricas = guardado.body?.exam?.metrics;
check(
  'el examen guardado trae la revisión nueva',
  guardado.body?.exam?.revision === 1 && guardado.body?.exam?.status === 'borrador',
  `revisión=${String(guardado.body?.exam?.revision)}`,
);
check(
  'los índices se calculan solo sobre los sitios medidos',
  metricas?.sitesProbed === 12 &&
    metricas?.bopSites === 3 &&
    metricas?.bopPercent === 25 &&
    metricas?.pocketsGte5 === 5 &&
    metricas?.deepestPd === 6,
  `sitios=${String(metricas?.sitesProbed)} BOP=${String(metricas?.bopPercent)}%`,
);
check(
  'las piezas ausentes, los implantes y la movilidad se cuentan aparte',
  metricas?.teethMissing === 1 &&
    metricas?.implants === 1 &&
    metricas?.mobilityGte2 === 1 &&
    metricas?.worstFurcation === 2 &&
    metricas?.implant?.sitesProbed === 3,
  `ausentes=${String(metricas?.teethMissing)} implantes=${String(metricas?.implants)}`,
);
check(
  'la clasificación firmada se guarda tal cual',
  guardado.body?.exam?.diagnosis?.stage === 2 && guardado.body?.exam?.diagnosis?.grade === 'B',
  JSON.stringify(guardado.body?.exam?.diagnosis),
);
check(
  'los factores de riesgo declarados se guardan',
  guardado.body?.exam?.riskFactors?.smoking === 'menos10' &&
    guardado.body?.exam?.riskFactors?.diabetes === 'no',
  JSON.stringify(guardado.body?.exam?.riskFactors),
);

// 6) El detalle relee la boca guardada (el JSONB no pierde los sitios).
const detalle = await detalleExamen(examId);
check(
  'el detalle conserva las mediciones de la boca',
  detalle.status === 200 &&
    detalle.body?.chart?.length === 32 &&
    detalle.body?.chart?.find((item) => item.fdi === 16)?.vestibular?.[1]?.pd === 5 &&
    detalle.body?.chart?.find((item) => item.fdi === 48)?.missing === true,
  `status ${detalle.status}`,
);

// 7) El listado del paciente incluye el examen abierto.
const listado = await listarExamenes('?status=borrador&limit=5');
check(
  'el listado del paciente trae el borrador abierto',
  listado.status === 200 &&
    Array.isArray(listado.body?.items) &&
    listado.body.items.some((examen) => examen.id === examId && examen.status === 'borrador'),
  `${String(listado.body?.items?.length ?? 0)} examen(es)`,
);

// 8) Guardar con una revisión vieja se rechaza: nunca se pisan dos ediciones.
const conflicto = await guardarExamen(examId, cuerpoGuardado(0, bocaConMediciones(), fechaExamen));
check(
  'guardar con la revisión vieja responde 409',
  conflicto.status === 409,
  `status ${conflicto.status}`,
);
check(
  'el 409 informa la revisión vigente',
  typeof conflicto.body?.currentRevision === 'number',
  JSON.stringify(conflicto.body?.currentRevision),
);

// 9) Finalizar: cierre inmutable del examen.
const finalizado = await finalizarExamen(examId, { revision: 1 });
check(
  'finaliza el examen',
  finalizado.status === 200 &&
    finalizado.body?.exam?.status === 'finalizado' &&
    typeof finalizado.body?.exam?.finalizedAt === 'string' &&
    finalizado.body?.alreadyFinalized === false,
  `status ${finalizado.status}`,
);
check(
  'el examen finalizado sube de revisión',
  finalizado.body?.exam?.revision === 2,
  `revisión=${String(finalizado.body?.exam?.revision)}`,
);

// 10) Inmutabilidad: un finalizado no se vuelve a guardar.
const inmutable = await guardarExamen(examId, cuerpoGuardado(2, bocaConMediciones(), fechaExamen));
check(
  'un examen finalizado ya no se puede guardar (409)',
  inmutable.status === 409,
  `status ${inmutable.status}`,
);

// 11) El clon del examen anterior: `source: 'anterior'` + `previousExamId`.
const clon = await crearExamen({
  source: 'anterior',
  previousExamId: examId,
  sessionId: null,
  notes: 'Clon de la prueba de humo',
});
const clonId = clon.body?.exam?.id;
check(
  'un examen nuevo se abre clonando el anterior',
  (clon.status === 201 || clon.status === 200) &&
    typeof clonId === 'string' &&
    clonId !== examId &&
    clon.body?.exam?.status === 'borrador',
  `status ${clon.status}`,
);
check(
  'el clon hereda las mediciones del examen anterior',
  clon.body?.exam?.chart?.find((item) => item.fdi === 16)?.vestibular?.[1]?.pd === 5 &&
    clon.body?.exam?.chart?.find((item) => item.fdi === 26)?.lingual?.[0]?.pd === 6,
  JSON.stringify(clon.body?.exam?.chart?.find((item) => item.fdi === 16)?.vestibular?.[1]?.pd),
);

// El clon se corrige antes de comparar: una bolsa mejora (5→3) y otra empeora (6→8).
if (typeof clonId === 'string') {
  const bocaDelClon = structuredClone(clon.body.exam.chart);
  buscarPieza(bocaDelClon, 16).vestibular[1].pd = 3;
  buscarPieza(bocaDelClon, 26).lingual[0].pd = 8;
  const guardadoClon = await guardarExamen(
    clonId,
    cuerpoGuardado(0, bocaDelClon, clon.body.exam.examDate),
  );
  check(
    'el borrador clonado se guarda con sus cambios',
    guardadoClon.status === 200 && guardadoClon.body?.exam?.revision === 1,
    `status ${guardadoClon.status}`,
  );

  // 12) Comparación longitudinal sitio a sitio.
  const comparacion = await compararExamen(clonId, examId);
  const resumen = comparacion.body?.comparison?.summary;
  check(
    'compara el examen actual con el anterior',
    comparacion.status === 200 &&
      comparacion.body?.previous?.id === examId &&
      comparacion.body?.current?.id === clonId,
    `status ${comparacion.status}`,
  );
  check(
    'la comparación detecta la mejoría y el empeoramiento de las bolsas',
    (resumen?.improved ?? 0) >= 1 && (resumen?.worsened ?? 0) >= 1,
    `mejoraron=${String(resumen?.improved)} empeoraron=${String(resumen?.worsened)}`,
  );
}

// 13) La impresión deja constancia con su actor.
const impreso = await registrarImpresion(examId);
check(
  'la impresión incrementa el contador del examen',
  impreso.status === 200 && impreso.body?.examId === examId && impreso.body?.printCount >= 1,
  `printCount=${String(impreso.body?.printCount)}`,
);

// 14) Auditoría: crear, guardar, finalizar e imprimir quedan registrados.
const auditoriaCreado = await esperarAuditoria('periodontogram_created', examId);
const auditoriaGuardado = await esperarAuditoria('periodontogram_updated', examId);
const auditoriaFinalizado = await esperarAuditoria('periodontogram_finalized', examId);
check(
  'crear, guardar y finalizar quedan en la auditoría',
  auditoriaCreado.length > 0 && auditoriaGuardado.length > 0 && auditoriaFinalizado.length > 0,
  `${String(auditoriaCreado.length + auditoriaGuardado.length + auditoriaFinalizado.length)} evento(s)`,
);
const auditoriaImpresion = await esperarAuditoria('periodontogram_printed', examId);
check(
  'la impresión queda auditada con su actor',
  auditoriaImpresion.length > 0 && typeof auditoriaImpresion[0]?.actorUsername === 'string',
  auditoriaImpresion[0]?.actorUsername,
);

// 15) La secretaría lee e imprime (imprimir es leer) pero no escribe.
//
// La cuenta sembrada tiene contraseña temporal y, mientras no se cambie, ningún
// permiso responde (403 a todo). La prueba la cambia, como los demás humos; al
// terminar hay que restaurarla:  npm run seed:users -- --reset
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

  const tokenAdminPrevio = token;
  token = tokenSecretaria;
  const leeSecretaria = await ultimoExamen();
  check(
    'la secretaría lee el periodontograma del paciente',
    leeSecretaria.status === 200 && leeSecretaria.body?.exists === true,
    `status ${leeSecretaria.status}`,
  );
  const listaSecretaria = await listarExamenes('?limit=5');
  check(
    'la secretaría lista los exámenes del paciente',
    listaSecretaria.status === 200 && Array.isArray(listaSecretaria.body?.items),
    `status ${listaSecretaria.status}`,
  );
  const imprimeSecretaria = await registrarImpresion(examId);
  check(
    'la secretaría puede imprimir (imprimir es leer)',
    imprimeSecretaria.status === 200,
    `status ${imprimeSecretaria.status}`,
  );
  const creaSecretaria = await crearExamen({
    source: 'blanco',
    previousExamId: null,
    sessionId: null,
  });
  check(
    'la secretaría NO puede escribir en el periodontograma',
    creaSecretaria.status === 403,
    `status ${creaSecretaria.status}`,
  );
  if (typeof clonId === 'string') {
    const guardaSecretaria = await guardarExamen(
      clonId,
      cuerpoGuardado(1, bocaConMediciones(), fechaExamen),
    );
    check(
      'la secretaría NO puede guardar un borrador ajeno',
      guardaSecretaria.status === 403,
      `status ${guardaSecretaria.status}`,
    );
  }
  token = tokenAdminPrevio;
  await call('/api/v1/auth/logout', { method: 'POST' });
} else {
  check(
    'la secretaría está sembrada (se omite la comprobación de permisos)',
    false,
    `login status ${secretaria.status}`,
  );
}

// 16) Sin regresión: el odontograma y la historia del mismo paciente siguen vivos.
const odontograma = await call(`/api/v1/odontogram/patients/${patientId}`);
check(
  'el odontograma de la Fase 6B sigue respondiendo',
  odontograma.status === 200,
  `status ${odontograma.status}`,
);
const historia = await call(`/api/v1/clinical/patients/${patientId}/record`);
check(
  'la historia clínica de la Fase 6A sigue respondiendo',
  historia.status === 200,
  `status ${historia.status}`,
);

// 17) Estado final (los exámenes finalizados no se borran: son historia clínica).
console.log(`\nPeriodontograma: ${examId} (finalizado) · clon en borrador: ${clonId ?? 'sin id'}`);
if (failures > 0) {
  console.error(`${String(failures)} comprobación(es) fallaron contra ${GATEWAY}`);
  process.exit(1);
}
console.log('Prueba de humo del periodontograma en verde ✔');
