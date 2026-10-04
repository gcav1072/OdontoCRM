#!/usr/bin/env node
/**
 * **`seed:verify`** — comprueba que lo sembrado es exactamente el mundo de prueba.
 *
 * No se fía de contar filas: reconstruye el mundo en memoria (misma semilla, mismo
 * ancla), lo vuelve a calcular con los mismos UUID deterministas y compara **la
 * huella** de cada parte con la huella de lo que hay en las bases. Si alguien
 * cambió el reparto de pacientes, una hora de una cita o el contenido de una
 * historia, la huella deja de cuadrar y el comando dice cuál.
 *
 * ```
 * npm run seed:verify                    # huellas: mundo ↔ bases
 * npm run seed:verify -- --con-proyeccion   # además, el read model de reportes
 * npm run seed:verify -- --anchor 2026-10-02
 * ```
 */
import pg from 'pg';

import { buildTestWorld, worldEventIds } from '@odontocrm/testing';

import {
  aviso,
  conexionDe,
  dato,
  error,
  exigirModoTest,
  fingerprint,
  ok,
  pdfDePrueba,
  titulo,
} from './lib/modo-test.mjs';

const args = process.argv.slice(2);
const conProyeccion = args.includes('--con-proyeccion');
const anchorIndex = args.indexOf('--anchor');
const anchor = anchorIndex === -1 ? undefined : args[anchorIndex + 1];
const silencioso = args.includes('--silencioso');

exigirModoTest('verificar los datos de prueba');

const world = buildTestWorld(anchor === undefined ? {} : { anchor });

const ids = {
  pacientes: world.patients.map((patient) => patient.id),
  solicitudes: world.requests.map((request) => request.id),
  citas: world.appointments.map((appointment) => appointment.id),
  cupos: world.capacities.map((capacity) => capacity.date),
};

const fallos = [];
let comprobaciones = 0;

/** Compara la huella de una parte del mundo con la de lo que hay en la base. */
const comparar = (nombre, esperado, obtenido, detalle) => {
  comprobaciones += 1;
  const iguales = esperado === obtenido;
  if (iguales) {
    ok(`${nombre}: ${esperado}`);
  } else {
    fallos.push(nombre);
    error(`${nombre}: no cuadra`);
    dato(`mundo: ${esperado}`);
    dato(`base:  ${obtenido}`);
    if (detalle !== undefined) dato(detalle);
  }
  return iguales;
};

const conectar = (servicio) => conexionDe(servicio, pg).client;

const consultar = async (servicio, sql, parametros = []) => {
  const client = conectar(servicio);
  await client.connect();
  try {
    const resultado = await client.query(sql, parametros);
    return resultado.rows;
  } finally {
    await client.end();
  }
};

const ordenar = (filas, campo) =>
  [...filas].sort((left, right) => (String(left[campo]) < String(right[campo]) ? -1 : 1));

// ── Pacientes ─────────────────────────────────────────────────────────────────
const verificarPacientes = async () => {
  const filas = await consultar(
    'patients',
    `select id, doc_type as "docType", doc_number as "docNumber", full_name as "fullName",
            to_char(birth_date, 'YYYY-MM-DD') as "birthDate", sex, phone, status, is_fictitious as "isFictitious"
       from patients where id = any($1::uuid[]) order by doc_number`,
    [ids.pacientes],
  );

  const esperado = ordenar(
    world.patients.map((patient) => ({
      id: patient.id,
      docType: patient.docType,
      docNumber: patient.docNumber,
      fullName: patient.fullName,
      birthDate: patient.birthDate,
      sex: patient.sex,
      phone: patient.phone,
      status: patient.status,
      isFictitious: true,
    })),
    'docNumber',
  );

  comparar(
    'patients.patients',
    fingerprint(esperado),
    fingerprint(filas),
    `${String(filas.length)} de ${String(esperado.length)} filas`,
  );

  const representantes = await consultar(
    'patients',
    'select count(1)::int as total from patient_guardians where patient_id = any($1::uuid[])',
    [ids.pacientes],
  );
  const esperadosRepresentantes = world.patients.filter(
    (patient) => patient.guardian !== null,
  ).length;
  comparar(
    'patients.patient_guardians',
    fingerprint({ total: esperadosRepresentantes }),
    fingerprint({ total: representantes[0]?.total ?? 0 }),
  );
};

// ── Agenda ────────────────────────────────────────────────────────────────────
const verificarAgenda = async () => {
  const solicitudes = await consultar(
    'scheduling',
    `select id, ticket_number::int as "ticketNumber", channel, patient_id as "patientId", reason, status,
            to_char(requested_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "requestedAt"
       from appointment_requests where id = any($1::uuid[]) order by ticket_number`,
    [ids.solicitudes],
  );

  const esperadoSolicitudes = [...world.requests]
    .sort((left, right) => left.ticketNumber - right.ticketNumber)
    .map((request) => ({
      id: request.id,
      ticketNumber: request.ticketNumber,
      channel: request.channel,
      patientId: request.patientId,
      reason: request.reason,
      status: request.status,
      requestedAt: request.requestedAt,
    }));

  comparar(
    'scheduling.appointment_requests',
    fingerprint(esperadoSolicitudes),
    fingerprint(solicitudes),
  );

  const citas = await consultar(
    'scheduling',
    `select id, request_id as "requestId", patient_id as "patientId", to_char(appointment_date, 'YYYY-MM-DD') as "date",
            to_char(start_time, 'HH24:MI') as "startTime", to_char(end_time, 'HH24:MI') as "endTime",
            status, call_count as "callCount",
            to_char(checked_in_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "checkedInAt",
            to_char(started_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "startedAt",
            to_char(finished_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "finishedAt",
            no_show_reason as "noShowReason", clinical_session_id as "clinicalSessionId"
       from appointments where id = any($1::uuid[]) order by appointment_date, start_time`,
    [ids.citas],
  );

  const esperadoCitas = [...world.appointments]
    .sort((left, right) =>
      left.date === right.date
        ? left.startTime < right.startTime
          ? -1
          : 1
        : left.date < right.date
          ? -1
          : 1,
    )
    .map((appointment) => ({
      id: appointment.id,
      requestId: appointment.requestId,
      patientId: appointment.patientId,
      date: appointment.date,
      startTime: appointment.startTime,
      endTime: appointment.endTime,
      status: appointment.status,
      callCount: appointment.callCount,
      checkedInAt: appointment.checkedInAt,
      startedAt: appointment.startedAt,
      finishedAt: appointment.finishedAt,
      noShowReason: appointment.noShowReason,
      clinicalSessionId: appointment.clinicalSessionId,
    }));

  comparar('scheduling.appointments', fingerprint(esperadoCitas), fingerprint(citas));

  const cupos = await consultar(
    'scheduling',
    `select to_char(date, 'YYYY-MM-DD') as "date", capacity from day_capacities
      where date = any($1::date[]) order by date`,
    [ids.cupos],
  );
  const esperadoCupos = [...world.capacities]
    .sort((left, right) => (left.date < right.date ? -1 : 1))
    .map((capacity) => ({ date: capacity.date, capacity: capacity.capacity }));
  comparar('scheduling.day_capacities', fingerprint(esperadoCupos), fingerprint(cupos));
};

// ── Historia clínica, sesiones y récipes ──────────────────────────────────────
const verificarClinica = async () => {
  const historias = await consultar(
    'clinical',
    `select id, patient_id as "patientId", status,
            to_char(signed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "signedAt"
       from medical_records where patient_id = any($1::uuid[]) order by patient_id`,
    [ids.pacientes],
  );
  const esperadoHistorias = ordenar(
    world.records.map((record) => ({
      id: record.id,
      patientId: record.patientId,
      status: record.status,
      signedAt: record.signedAt,
    })),
    'patientId',
  );
  comparar('clinical.medical_records', fingerprint(esperadoHistorias), fingerprint(historias));

  const secciones = await consultar(
    'clinical',
    `select s.record_id as "recordId", s.section_key as "sectionKey", s.content
       from medical_record_sections s
       join medical_records r on r.id = s.record_id
      where r.patient_id = any($1::uuid[]) order by s.record_id, s.section_key`,
    [ids.pacientes],
  );
  const esperadoSecciones = world.records
    .flatMap((record) =>
      Object.entries(record.sections).map(([sectionKey, content]) => ({
        recordId: record.id,
        sectionKey,
        content,
      })),
    )
    .sort((left, right) =>
      left.recordId === right.recordId
        ? left.sectionKey < right.sectionKey
          ? -1
          : 1
        : left.recordId < right.recordId
          ? -1
          : 1,
    );
  comparar(
    'clinical.medical_record_sections',
    fingerprint(esperadoSecciones),
    fingerprint(secciones),
    `${String(secciones.length)} de ${String(esperadoSecciones.length)} secciones`,
  );

  const sesiones = await consultar(
    'clinical',
    `select id, record_id as "recordId", patient_id as "patientId", appointment_id as "appointmentId",
            session_number as "sessionNumber", status, content,
            to_char(closed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "closedAt"
       from clinical_sessions where patient_id = any($1::uuid[]) order by patient_id, session_number`,
    [ids.pacientes],
  );
  const esperadoSesiones = world.sessions
    .map((session) => ({
      id: session.id,
      recordId: session.recordId,
      patientId: session.patientId,
      appointmentId: session.appointmentId,
      sessionNumber: session.sessionNumber,
      status: session.status,
      content: session.content,
      closedAt: session.closedAt,
    }))
    .sort((left, right) =>
      left.patientId === right.patientId
        ? left.sessionNumber - right.sessionNumber
        : left.patientId < right.patientId
          ? -1
          : 1,
    );
  comparar('clinical.clinical_sessions', fingerprint(esperadoSesiones), fingerprint(sesiones));

  const recipes = await consultar(
    'clinical',
    `select p.id, p.prescription_number::int as "number", p.patient_id as "patientId", p.session_id as "sessionId",
            p.status, p.verify_code as "verifyCode", p.pdf_path as "pdfPath", p.pdf_sha256 as "pdfSha256",
            to_char(p.issued_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "issuedAt",
            (select array_agg(i.medication_name order by i.position) from prescription_items i where i.prescription_id = p.id) as "medications"
       from prescriptions p where p.patient_id = any($1::uuid[]) order by p.prescription_number`,
    [ids.pacientes],
  );
  const esperadoRecipes = [...world.prescriptions]
    .sort((left, right) => left.number - right.number)
    .map((prescription) => ({
      id: prescription.id,
      number: prescription.number,
      patientId: prescription.patientId,
      sessionId: prescription.sessionId,
      status: 'emitida',
      verifyCode: prescription.verifyCode,
      issuedAt: prescription.issuedAt,
      medications: prescription.items.map((item) => item.medicationName),
    }));
  comparar(
    'clinical.prescriptions',
    fingerprint(esperadoRecipes),
    fingerprint(
      recipes.map((recipe) => ({
        id: recipe.id,
        number: recipe.number,
        patientId: recipe.patientId,
        sessionId: recipe.sessionId,
        status: recipe.status,
        verifyCode: recipe.verifyCode,
        issuedAt: recipe.issuedAt,
        medications: recipe.medications,
      })),
    ),
    `${String(recipes.length)} de ${String(esperadoRecipes.length)} récipes`,
  );

  // El PDF archivado tiene que ser el mismo que el seed habría escrito hoy.
  let pdfsOk = 0;
  for (const recipe of recipes) {
    const esperado = pdfDePrueba([
      'MODO TEST - ODONTOCRM',
      `Recipe ${`RX-${String(recipe.number).padStart(6, '0')}`}`,
      `Verificacion: ${recipe.verifyCode}`,
      'Documento de prueba: no corresponde a un paciente real.',
      'Para ver el A5 real, emita un recipe desde la aplicacion.',
    ]);
    const { createHash } = await import('node:crypto');
    const huella = createHash('sha256').update(esperado).digest('hex');
    if (huella === recipe.pdfSha256) pdfsOk += 1;
  }
  comparar(
    'clinical.prescriptions.pdf',
    fingerprint({ pdfs: world.prescriptions.length }),
    fingerprint({ pdfs: pdfsOk }),
    'PDF archivado y su sha256',
  );
};

// ── Odontograma ───────────────────────────────────────────────────────────────
const verificarOdontograma = async () => {
  const hallazgos = await consultar(
    'odontogram',
    `select id, odontogram_id as "odontogramId", patient_id as "patientId", tooth_number as "toothNumber",
            surface, condition, state, recorded_in_session_id as "sessionId", resolved_at as "resolvedAt",
            to_char(recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "recordedAt"
       from tooth_findings where patient_id = any($1::uuid[]) order by patient_id, tooth_number, condition, surface nulls last`,
    [ids.pacientes],
  );
  const esperado = [...world.findings]
    .sort((left, right) => {
      if (left.patientId !== right.patientId) return left.patientId < right.patientId ? -1 : 1;
      if (left.toothNumber !== right.toothNumber) return left.toothNumber - right.toothNumber;
      if (left.condition !== right.condition) return left.condition < right.condition ? -1 : 1;
      // En Postgres los NULL van al final (`surface nulls last`).
      const cara = left.surface ?? '\uffff';
      const otra = right.surface ?? '\uffff';
      return cara < otra ? -1 : cara > otra ? 1 : 0;
    })
    .map((finding) => ({
      id: finding.id,
      odontogramId: finding.odontogramId,
      patientId: finding.patientId,
      toothNumber: finding.toothNumber,
      surface: finding.surface,
      condition: finding.condition,
      state: finding.state,
      sessionId: finding.sessionId,
      resolvedAt: null,
      recordedAt: finding.recordedAt,
    }));
  comparar(
    'odontogram.tooth_findings',
    fingerprint(esperado),
    fingerprint(hallazgos),
    `${String(hallazgos.length)} de ${String(esperado.length)} hallazgos`,
  );

  const historial = await consultar(
    'odontogram',
    `select count(1)::int as total from tooth_finding_history where patient_id = any($1::uuid[])`,
    [ids.pacientes],
  );
  comparar(
    'odontogram.tooth_finding_history',
    fingerprint({ total: world.findings.length }),
    fingerprint({ total: historial[0]?.total ?? 0 }),
  );
};

// ── Read model de reportes (la cola tiene que haber corrido) ──────────────────
const verificarProyeccion = async () => {
  const eventos = worldEventIds(world);
  const [procesados, tablas, vistas] = await Promise.all([
    consultar(
      'reporting',
      'select count(1)::int as total from processed_events where event_id = any($1::uuid[])',
      [eventos],
    ),
    consultar(
      'reporting',
      `select
         (select count(1)::int from dim_patient where patient_id = any($1::uuid[])) as pacientes,
         (select count(1)::int from dim_day_capacity where date = any($2::date[])) as cupos,
         (select count(1)::int from fact_request where request_id = any($3::uuid[])) as solicitudes,
         (select count(1)::int from fact_appointment where appointment_id = any($4::uuid[])) as citas,
         (select count(1)::int from fact_clinical_session where patient_id = any($1::uuid[])) as sesiones,
         (select count(1)::int from fact_prescription where patient_id = any($1::uuid[])) as recipes,
         (select count(1)::int from fact_tooth_finding where patient_id = any($1::uuid[])) as hallazgos`,
      [ids.pacientes, ids.cupos, ids.solicitudes, ids.citas],
    ),
    consultar(
      'reporting',
      `select
         (select count(1)::int from mv_daily_kpis) as kpis,
         (select count(1)::int from mv_demographics) as demografia,
         (select count(1)::int from mv_oral_health) as salud_bucal,
         (select count(1)::int from mv_prescriptions) as recetas,
         (select count(1)::int from mv_funnel) as embudo`,
    ),
  ]);

  const fila = tablas[0] ?? {};
  const esperado = {
    pacientes: world.patients.length,
    cupos: world.capacities.length,
    solicitudes: world.requests.length,
    citas: world.appointments.length,
    sesiones: world.sessions.length,
    recipes: world.prescriptions.length,
    hallazgos: world.findings.length,
  };
  const obtenido = {
    pacientes: fila.pacientes ?? 0,
    cupos: fila.cupos ?? 0,
    solicitudes: fila.solicitudes ?? 0,
    citas: fila.citas ?? 0,
    sesiones: fila.sesiones ?? 0,
    recipes: fila.recipes ?? 0,
    hallazgos: fila.hallazgos ?? 0,
  };

  dato(
    `eventos proyectados: ${String(procesados[0]?.total ?? 0)} de ${String(eventos.length)} ` +
      '(los ignorados y los duplicados no se cuentan)',
  );
  comparar('reporting.read_model', fingerprint(esperado), fingerprint(obtenido));

  const vista = vistas[0] ?? {};
  for (const [nombre, valor] of Object.entries(vista)) {
    comprobaciones += 1;
    if (Number(valor) > 0) ok(`reporting.${nombre}: ${String(valor)} fila(s)`);
    else {
      fallos.push(`reporting.${nombre}`);
      aviso(`reporting.${nombre}: vacía (¿se refrescaron las vistas?)`);
    }
  }

  if ((procesados[0]?.total ?? 0) === 0) {
    aviso(
      'La proyección está vacía: arranca la pila y vuelve a comprobar (los eventos se entregan solos).',
    );
  }
};

const main = async () => {
  console.log('\nOdontoCRM · seed:verify (modo test)');
  if (!silencioso) {
    dato(`Semilla: ${world.seed} · ancla: ${world.anchor}`);
    dato(`Eventos del mundo: ${String(worldEventIds(world).length)}`);
  }

  titulo('Huellas del mundo frente a las bases');
  await verificarPacientes();
  await verificarAgenda();
  await verificarClinica();
  await verificarOdontograma();

  if (conProyeccion) {
    titulo('Read model de reportes');
    await verificarProyeccion();
  }

  titulo('Resultado');
  if (fallos.length === 0) {
    ok(`${String(comprobaciones)} comprobaciones en verde: lo sembrado es el mundo.`);
    console.log('');
    return;
  }

  error(
    `${String(fallos.length)} de ${String(comprobaciones)} comprobaciones fallaron: ${fallos.join(', ')}`,
  );
  dato(
    'Vuelve a sembrar con "npm run seed:test" (o borra con "npm run seed:reset" y siembra de nuevo).',
  );
  console.log('');
  process.exitCode = 1;
};

main().catch((fallo) => {
  error(fallo instanceof Error ? fallo.message : String(fallo));
  process.exitCode = 1;
});
