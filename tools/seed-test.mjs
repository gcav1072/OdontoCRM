#!/usr/bin/env node
/**
 * **Modo test** (ADR 0020): siembra el mundo de prueba completo y determinista.
 *
 * ```
 * npm run seed:test                    # siembra (idempotente: repetirlo no duplica)
 * npm run seed:test -- --dry-run       # explica lo que haría, sin tocar nada
 * npm run seed:test -- --anchor 2026-10-02   # fija el día de referencia
 * npm run seed:test -- --solo clinical # siembra solo una parte
 * npm run seed:reset                   # borra SOLO lo ficticio de este mundo
 * npm run seed:verify                  # comprueba que lo sembrado es el mundo
 * ```
 *
 * Qué escribe: 40 pacientes ficticios (cédulas 90.000.000+, `is_fictitious`), sus
 * solicitudes y citas (atendidas, inasistencias, canceladas, reprogramadas y la
 * jornada de hoy con sala de espera y consultorio), historias firmadas, sesiones
 * cerradas, odontogramas y récipes emitidos; los **cupos** del mes; y —esto es lo
 * que faltaba desde la Fase 9— los **eventos de dominio** en el outbox de cada
 * servicio, con lo que el read model de reportes, la auditoría y las pantallas se
 * llenan exactamente igual que si el trabajo lo hubiera hecho una persona.
 *
 * Tres decisiones que conviene tener presentes:
 *
 * 1. **Nada se toca fuera del mundo.** Cada fila y cada evento llevan identificadores
 *    derivados de la semilla, así que `seed:reset` borra exactamente eso y ni un
 *    registro real más. Los consecutivos (tickets y récipes) van al rango reservado
 *    900.000+, y al terminar la secuencia se deja apuntando al último número real.
 * 2. **Sin modo test no corre.** `TEST_MODE=true` **y** `ALLOW_TEST_MODE=true`, y
 *    nunca con `NODE_ENV=production`: la instalación de la clínica se niega.
 * 3. **Los eventos se entregan solos** cuando la pila está arriba: el publicador de
 *    cada servicio los manda a la cola y los consumidores proyectan. Este comando no
 *    necesita la pila para escribir, pero para que los reportes cuadren hay que
 *    arrancarla (o usar `seed:verify --con-proyeccion` tras arrancarla).
 *
 * Ver docs/COMANDOS.md y la guía de la PC de pruebas (infra/fedora/DESARROLLO.md).
 */
import pg from 'pg';

import {
  buildTestWorld,
  buildTestWorldEvents,
  deterministicUuid,
  worldEventIds,
  worldEventsFor,
  worldFingerprints,
} from '@odontocrm/testing';

import {
  ajustarSecuencia,
  almacenClinico,
  aviso,
  borrarEventos,
  conexionDe,
  dato,
  error,
  exigirModoTest,
  leerEnv,
  ok,
  pdfDePrueba,
  sembrarEventos,
  titulo,
} from './lib/modo-test.mjs';

const { Client } = pg;

// ── Argumentos ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const CONOCIDAS = ['--dry-run', '--anchor', '--solo', '--reset', '--silencioso'];
const desconocida = args.find((arg) => arg.startsWith('--') && !CONOCIDAS.includes(arg));
if (desconocida !== undefined) {
  error(`Bandera desconocida: ${desconocida}. Opciones: ${CONOCIDAS.join(', ')}`);
  process.exit(1);
}

const dryRun = args.includes('--dry-run');
const soloIndex = args.indexOf('--solo');
const solo = soloIndex === -1 ? undefined : args[soloIndex + 1];
const anchorIndex = args.indexOf('--anchor');
const anchor = anchorIndex === -1 ? undefined : args[anchorIndex + 1];
const silencioso = args.includes('--silencioso');

if (anchor !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(anchor)) {
  error(`El ancla debe ser una fecha AAAA-MM-DD (recibí "${anchor}").`);
  process.exit(1);
}

const PARTES = ['patients', 'scheduling', 'clinical', 'odontogram', 'reporting'];
if (solo !== undefined && !PARTES.includes(solo)) {
  error(`No hay una parte llamada "${solo}". Opciones: ${PARTES.join(', ')}`);
  process.exit(1);
}

// ── Guardas y mundo ───────────────────────────────────────────────────────────
const estadoModoTest = exigirModoTest('sembrar datos de prueba');
const world = buildTestWorld(anchor === undefined ? {} : { anchor });
const eventos = buildTestWorldEvents(world);
const huellas = worldFingerprints(world);
const idsDeEventos = worldEventIds(world);

const ids = {
  pacientes: world.patients.map((patient) => patient.id),
  solicitudes: world.requests.map((request) => request.id),
  citas: world.appointments.map((appointment) => appointment.id),
  historias: world.records.map((record) => record.id),
  sesiones: world.sessions.map((session) => session.id),
  recipes: world.prescriptions.map((prescription) => prescription.id),
  odontogramas: world.findings.map((finding) => finding.odontogramId),
  cupos: world.capacities.map((capacity) => capacity.date),
  entidades: [
    ...world.patients.map((patient) => patient.id),
    ...world.requests.map((request) => request.id),
    ...world.appointments.map((appointment) => appointment.id),
    ...world.records.map((record) => record.id),
    ...world.sessions.map((session) => session.id),
    ...world.prescriptions.map((prescription) => prescription.id),
    ...world.findings.map((finding) => finding.odontogramId),
    ...world.capacities.map((capacity) => deterministicUuid('day_capacity', capacity.date)),
  ],
};

const clinico = leerEnv('services/clinical/.env');
const almacen = almacenClinico(clinico);

const conectar = (servicio) => conexionDe(servicio, pg).client;

const enTransaccion = async (client, tarea) => {
  await client.query('begin');
  try {
    await tarea();
    await client.query('commit');
  } catch (fallo) {
    await client.query('rollback');
    throw fallo;
  }
};

// ── Siembra por servicio ──────────────────────────────────────────────────────

const sembrarPacientes = async (client) => {
  for (const patient of world.patients) {
    await client.query(
      `insert into patients (
         id, doc_type, doc_number, full_name, birth_date, sex, phone, phone_alt, email,
         address, occupation, notes, status, is_fictitious, created_at, updated_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,true,$14,$14)
       on conflict (id) do update set
         full_name = excluded.full_name,
         birth_date = excluded.birth_date,
         sex = excluded.sex,
         phone = excluded.phone,
         phone_alt = excluded.phone_alt,
         email = excluded.email,
         address = excluded.address,
         occupation = excluded.occupation,
         status = excluded.status,
         is_fictitious = true,
         updated_at = excluded.updated_at`,
      [
        patient.id,
        patient.docType,
        patient.docNumber,
        patient.fullName,
        patient.birthDate,
        patient.sex,
        patient.phone,
        patient.phoneAlt,
        patient.email,
        patient.address,
        patient.occupation,
        'MODO TEST: paciente ficticio (ADR 0020)',
        patient.status,
        patient.registeredAt,
      ],
    );
  }

  // Un representante por menor (la tabla admite uno solo por paciente).
  await client.query('delete from patient_guardians where patient_id = any($1::uuid[])', [
    ids.pacientes,
  ]);
  for (const patient of world.patients) {
    if (patient.guardian === null) continue;
    await client.query(
      `insert into patient_guardians (id, patient_id, full_name, doc_type, doc_number, relationship, phone, created_at, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$8)`,
      [
        deterministicUuid('guardian', patient.docNumber),
        patient.id,
        patient.guardian.fullName,
        patient.guardian.docType,
        patient.guardian.docNumber,
        patient.guardian.relationship,
        patient.guardian.phone,
        patient.registeredAt,
      ],
    );
  }

  const eventosPacientes = worldEventsFor(world, 'patients');
  return { eventos: await sembrarEventos(client, eventosPacientes) };
};

const sembrarAgenda = async (client) => {
  for (const capacity of world.capacities) {
    await client.query(
      `insert into day_capacities (date, capacity, notes, updated_at)
       values ($1,$2,$3, now())
       on conflict (date) do update set capacity = excluded.capacity, notes = excluded.notes, updated_at = now()`,
      [capacity.date, capacity.capacity, capacity.notes],
    );
  }

  for (const request of world.requests) {
    await client.query(
      `insert into appointment_requests (
         id, ticket_number, channel, patient_id, patient_name, patient_document, patient_phone,
         reason, status, priority, requested_at, notes, created_by, created_at, updated_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,null,$11,$11)
       on conflict (id) do update set
         status = excluded.status, reason = excluded.reason, priority = excluded.priority,
         requested_at = excluded.requested_at, updated_at = excluded.updated_at`,
      [
        request.id,
        request.ticketNumber,
        request.channel,
        request.patientId,
        request.patientName,
        request.patientDocument,
        request.patientPhone,
        request.reason,
        request.status,
        request.priority,
        request.requestedAt,
        request.notes,
      ],
    );
  }

  await client.query(
    'delete from status_history where entity_type = $1 and entity_id = any($2::uuid[])',
    ['appointment', ids.citas],
  );
  await client.query(
    'delete from status_history where entity_type = $1 and entity_id = any($2::uuid[])',
    ['request', ids.solicitudes],
  );

  for (const appointment of world.appointments) {
    await client.query(
      `insert into appointments (
         id, request_id, patient_id, patient_name, patient_document, patient_phone, appointment_date,
         start_time, end_time, duration_minutes, slot_kind, status, call_count, checked_in_at,
         started_at, finished_at, no_show_reason, force_attended_reason, clinical_session_id,
         overbook_authorized, overbook_reason, rescheduled_from_id, ics_sequence, notes,
         created_by, created_at, updated_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'franja',$11,$12,$13,$14,$15,$16,$17,$18,false,null,$19,0,$20,null,$21,$21)
       on conflict (id) do update set
         status = excluded.status, call_count = excluded.call_count,
         checked_in_at = excluded.checked_in_at, started_at = excluded.started_at,
         finished_at = excluded.finished_at, no_show_reason = excluded.no_show_reason,
         clinical_session_id = excluded.clinical_session_id, updated_at = excluded.updated_at`,
      [
        appointment.id,
        appointment.requestId,
        appointment.patientId,
        appointment.patientName,
        appointment.patientDocument,
        appointment.patientPhone,
        appointment.date,
        appointment.startTime,
        appointment.endTime,
        appointment.durationMinutes,
        appointment.status,
        appointment.callCount,
        appointment.checkedInAt,
        appointment.startedAt,
        appointment.finishedAt,
        appointment.noShowReason,
        null,
        appointment.clinicalSessionId,
        appointment.rescheduledFromId,
        appointment.notes,
        appointment.scheduledAt,
      ],
    );

    // El historial de estados es lo que lee la pantalla de historial de la cita:
    // se reconstruye con las mismas horas que los eventos.
    const pasos = [];
    if (appointment.status !== 'cancelada' || appointment.cancelledAt === null) {
      pasos.push({
        desde: null,
        hasta: 'programada',
        cuando: appointment.scheduledAt,
        motivo: null,
      });
    } else {
      pasos.push({
        desde: null,
        hasta: 'programada',
        cuando: appointment.scheduledAt,
        motivo: null,
      });
      pasos.push({
        desde: 'programada',
        hasta: 'cancelada',
        cuando: appointment.cancelledAt,
        motivo: appointment.cancelReason,
      });
    }
    if (appointment.notifiedAt !== null)
      pasos.push({
        desde: 'programada',
        hasta: 'notificada',
        cuando: appointment.notifiedAt,
        motivo: null,
      });
    if (appointment.checkedInAt !== null)
      pasos.push({
        desde: 'notificada',
        hasta: 'en_sala_espera',
        cuando: appointment.checkedInAt,
        motivo: null,
      });
    if (appointment.calledAt !== null)
      pasos.push({
        desde: 'en_sala_espera',
        hasta: 'llamado',
        cuando: appointment.calledAt,
        motivo: null,
      });
    if (appointment.startedAt !== null)
      pasos.push({
        desde: 'llamado',
        hasta: 'en_consulta',
        cuando: appointment.startedAt,
        motivo: null,
      });
    if (appointment.finishedAt !== null)
      pasos.push({
        desde: 'en_consulta',
        hasta: 'atendido',
        cuando: appointment.finishedAt,
        motivo: null,
      });
    if (appointment.noShowAt !== null)
      pasos.push({
        desde: 'notificada',
        hasta: 'no_asistio',
        cuando: appointment.noShowAt,
        motivo: appointment.noShowReason,
      });
    if (appointment.rescheduledAt !== null)
      pasos.push({
        desde: 'programada',
        hasta: 'reprogramada',
        cuando: appointment.rescheduledAt,
        motivo: 'reprogramada con la cita nueva',
      });

    for (const [index, paso] of pasos.entries()) {
      await client.query(
        `insert into status_history (id, entity_type, entity_id, from_status, to_status, reason, actor_id, actor_username, occurred_at)
         values ($1,'appointment',$2,$3,$4,$5,null,'seed-test',$6)`,
        [
          deterministicUuid('status_history', `${appointment.id}:${String(index)}`),
          appointment.id,
          paso.desde,
          paso.hasta,
          paso.motivo,
          paso.cuando,
        ],
      );
    }

    await client.query(
      `insert into status_history (id, entity_type, entity_id, from_status, to_status, reason, actor_id, actor_username, occurred_at)
       values ($1,'request',$2,null,'programada',$3,null,'seed-test',$4)`,
      [
        deterministicUuid('status_history', `${appointment.requestId}:programada`),
        appointment.requestId,
        'MODO TEST: cita programada por el seed',
        appointment.scheduledAt,
      ],
    );
  }

  await ajustarSecuencia(client, 'ticket_seq', 'appointment_requests', 'ticket_number');
  const eventos = await sembrarEventos(client, worldEventsFor(world, 'scheduling'));
  return { eventos };
};

const sembrarClinica = async (client) => {
  for (const record of world.records) {
    await client.query(
      `insert into medical_records (id, patient_id, status, signed_at, signed_by, signed_by_username, print_count, created_by, updated_by, created_at, updated_at)
       values ($1,$2,'firmada',$3,null,'seed-test',0,null,null,$4,$3)
       on conflict (id) do update set status = 'firmada', signed_at = excluded.signed_at, signed_by_username = 'seed-test', updated_at = excluded.updated_at`,
      [record.id, record.patientId, record.signedAt, record.createdAt],
    );

    for (const [sectionKey, content] of Object.entries(record.sections)) {
      await client.query(
        `insert into medical_record_sections (id, record_id, section_key, content, updated_by, updated_at)
         values ($1,$2,$3,$4::jsonb,null,$5)
         on conflict (record_id, section_key) do update set content = excluded.content, updated_at = excluded.updated_at`,
        [
          deterministicUuid('section', `${record.id}:${sectionKey}`),
          record.id,
          sectionKey,
          JSON.stringify(content),
          record.signedAt,
        ],
      );
    }

    const patient = world.patients.find((item) => item.id === record.patientId);
    await client.query(
      `insert into medical_record_consents (id, record_id, accepted, accepted_at, accepted_by_name, accepted_by_document, relationship, witness_name, notes, registered_by, registered_by_username, updated_at)
       values ($1,$2,true,$3,$4,$5,$6,null,'Consentimiento informado del modo test',null,'seed-test',$3)
       on conflict (record_id) do update set accepted = true, accepted_at = excluded.accepted_at, updated_at = excluded.updated_at`,
      [
        deterministicUuid('consent', record.id),
        record.id,
        record.consentRegisteredAt,
        patient?.guardian?.fullName ?? patient?.fullName ?? 'Paciente de prueba',
        patient?.guardian?.docNumber ?? patient?.docNumber ?? null,
        patient?.guardian?.relationship ?? 'Paciente',
      ],
    );
  }

  for (const session of world.sessions) {
    await client.query(
      `insert into clinical_sessions (id, record_id, patient_id, appointment_id, session_number, status, content, opened_by, opened_by_username, closed_at, closed_by, closed_by_username, closure_note, created_at, updated_at)
       values ($1,$2,$3,$4,$5,'cerrada',$6::jsonb,null,'seed-test',$7,null,'seed-test','Sesión cerrada en el día de la cita (modo test)',$8,$7)
       on conflict (id) do update set status = 'cerrada', content = excluded.content, closed_at = excluded.closed_at, updated_at = excluded.updated_at`,
      [
        session.id,
        session.recordId,
        session.patientId,
        session.appointmentId,
        session.sessionNumber,
        JSON.stringify(session.content),
        session.closedAt,
        session.openedAt,
      ],
    );
  }

  let recetas = 0;
  for (const prescription of world.prescriptions) {
    const pdf = pdfDePrueba([
      'MODO TEST - ODONTOCRM',
      `Recipe ${`RX-${String(prescription.number).padStart(6, '0')}`}`,
      `Verificacion: ${prescription.verifyCode}`,
      'Documento de prueba: no corresponde a un paciente real.',
      'Para ver el A5 real, emita un recipe desde la aplicacion.',
    ]);
    const clave = `clinical/${prescription.patientId}/${prescription.id}.pdf`;
    const guardado = await almacen.save({ key: clave, data: pdf });

    await client.query(
      `insert into prescriptions (id, prescription_number, session_id, patient_id, status, general_instructions, patient_snapshot, issued_at, issued_by, issued_by_username, verify_code, pdf_path, pdf_sha256, generated_at, print_count, created_by, created_by_username, created_at, updated_at)
       values ($1,$2,$3,$4,'emitida',$5,$6::jsonb,$7,null,'seed-test',$8,$9,$10,$7,0,null,'seed-test',$7,$7)
       on conflict (id) do update set
         status = 'emitida', general_instructions = excluded.general_instructions,
         issued_at = excluded.issued_at, verify_code = excluded.verify_code,
         pdf_path = excluded.pdf_path, pdf_sha256 = excluded.pdf_sha256,
         generated_at = excluded.generated_at, updated_at = excluded.updated_at`,
      [
        prescription.id,
        prescription.number,
        prescription.sessionId,
        prescription.patientId,
        prescription.generalInstructions,
        JSON.stringify({ modoTest: true, pacienteId: prescription.patientId }),
        prescription.issuedAt,
        prescription.verifyCode,
        guardado.path,
        guardado.sha256,
      ],
    );

    await client.query('delete from prescription_items where prescription_id = $1', [
      prescription.id,
    ]);
    for (const [index, item] of prescription.items.entries()) {
      await client.query(
        `insert into prescription_items (id, prescription_id, position, medication_id, medication_name, presentation, route, dose, frequency, duration, instructions, quantity)
         values ($1,$2,$3,null,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          deterministicUuid('prescription_item', `${prescription.id}:${String(index)}`),
          prescription.id,
          index + 1,
          item.medicationName,
          item.presentation,
          item.route,
          item.dose,
          item.frequency,
          item.duration,
          item.instructions,
          item.quantity,
        ],
      );
    }
    recetas += 1;
  }

  await ajustarSecuencia(client, 'prescription_number_seq', 'prescriptions', 'prescription_number');
  const eventos = await sembrarEventos(client, worldEventsFor(world, 'clinical'));
  return { eventos, recetas };
};

const sembrarOdontograma = async (client) => {
  const porPaciente = new Map();
  for (const finding of world.findings) {
    if (!porPaciente.has(finding.patientId))
      porPaciente.set(finding.patientId, finding.odontogramId);
  }

  for (const [patientId, odontogramId] of porPaciente.entries()) {
    const paciente = world.patients.find((item) => item.id === patientId);
    const denticion = (paciente?.age ?? 30) <= 12 ? 'temporal' : 'permanente';
    await client.query(
      `insert into odontograms (id, patient_id, dentition, notes, print_count, recorded_by, recorded_by_username, created_at, updated_at)
       values ($1,$2,$3,'MODO TEST: odontograma ficticio',0,null,'seed-test',now(),now())
       on conflict (patient_id) do update set dentition = excluded.dentition, updated_at = now()`,
      [odontogramId, patientId, denticion],
    );
  }

  for (const finding of world.findings) {
    await client.query(
      `insert into tooth_findings (id, odontogram_id, patient_id, tooth_number, surface, condition, state, notes, recorded_by, recorded_by_username, recorded_in_session_id, recorded_at, updated_at, resolved_at)
       values ($1,$2,$3,$4,$5,$6,$7,null,null,'seed-test',$8,$9,$9,null)
       on conflict (id) do update set state = excluded.state, notes = excluded.notes, updated_at = excluded.updated_at`,
      [
        finding.id,
        finding.odontogramId,
        finding.patientId,
        finding.toothNumber,
        finding.surface,
        finding.condition,
        finding.state,
        finding.sessionId,
        finding.recordedAt,
      ],
    );

    await client.query(
      `insert into tooth_finding_history (id, odontogram_id, finding_id, patient_id, tooth_number, surface, condition, state, event, reason, notes, actor_id, actor_username, session_id, occurred_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,'registrado','MODO TEST: hallazgo ficticio',null,null,'seed-test',$9,$10)`,
      [
        deterministicUuid('finding_history', finding.id),
        finding.odontogramId,
        finding.id,
        finding.patientId,
        finding.toothNumber,
        finding.surface,
        finding.condition,
        finding.state,
        finding.sessionId,
        finding.recordedAt,
      ],
    );
  }

  const eventos = await sembrarEventos(client, worldEventsFor(world, 'odontogram'));
  return { eventos };
};

/** Proyecta el read model de reportes sin esperar a la cola (para `--solo reporting`). */
const refrescarReportes = async (client) => {
  const vistas = [
    'mv_daily_kpis',
    'mv_funnel',
    'mv_demographics',
    'mv_oral_health',
    'mv_prescriptions',
  ];
  for (const vista of vistas) {
    await client.query(`refresh materialized view ${vista}`);
  }
  return vistas.length;
};

// ── Reset: borra SOLO lo del mundo ────────────────────────────────────────────

const borrarPacientes = async (client) => {
  const borrados = await client.query('delete from patients where id = any($1::uuid[])', [
    ids.pacientes,
  ]);
  return (
    (borrados.rowCount ?? 0) +
    (await borrarEventos(
      client,
      worldEventsFor(world, 'patients').map((e) => e.id),
    ))
  );
};

const borrarAgenda = async (client) => {
  await client.query('delete from appointments where id = any($1::uuid[])', [ids.citas]);
  await client.query('delete from appointment_requests where id = any($1::uuid[])', [
    ids.solicitudes,
  ]);
  await client.query('delete from status_history where entity_id = any($1::uuid[])', [
    ids.entidades,
  ]);
  await client.query('delete from day_capacities where date = any($1::date[])', [ids.cupos]);
  await ajustarSecuencia(client, 'ticket_seq', 'appointment_requests', 'ticket_number');
  return await borrarEventos(
    client,
    worldEventsFor(world, 'scheduling').map((e) => e.id),
  );
};

const borrarClinica = async (client) => {
  // Los binarios no caen con la cascada: se borran a mano.
  for (const prescription of world.prescriptions) {
    await almacen.remove(`clinical/${prescription.patientId}/${prescription.id}.pdf`);
  }
  const borrados = await client.query(
    'delete from medical_records where patient_id = any($1::uuid[])',
    [ids.pacientes],
  );
  await ajustarSecuencia(client, 'prescription_number_seq', 'prescriptions', 'prescription_number');
  return (
    (borrados.rowCount ?? 0) +
    (await borrarEventos(
      client,
      worldEventsFor(world, 'clinical').map((e) => e.id),
    ))
  );
};

const borrarOdontograma = async (client) => {
  const borrados = await client.query(
    'delete from odontograms where patient_id = any($1::uuid[])',
    [ids.pacientes],
  );
  return (
    (borrados.rowCount ?? 0) +
    (await borrarEventos(
      client,
      worldEventsFor(world, 'odontogram').map((e) => e.id),
    ))
  );
};

/** Quita de la proyección lo que dejó el seed (y permite volver a proyectarlo). */
const borrarProyeccion = async (client) => {
  let borrados = 0;
  borrados +=
    (
      await client.query('delete from patient_profiles where patient_id = any($1::uuid[])', [
        ids.pacientes,
      ])
    ).rowCount ?? 0;
  borrados +=
    (
      await client.query('delete from fact_tooth_finding where patient_id = any($1::uuid[])', [
        ids.pacientes,
      ])
    ).rowCount ?? 0;
  borrados +=
    (
      await client.query('delete from fact_prescription_item where patient_id = any($1::uuid[])', [
        ids.pacientes,
      ])
    ).rowCount ?? 0;
  borrados +=
    (
      await client.query('delete from fact_prescription where patient_id = any($1::uuid[])', [
        ids.pacientes,
      ])
    ).rowCount ?? 0;
  borrados +=
    (
      await client.query('delete from fact_clinical_session where patient_id = any($1::uuid[])', [
        ids.pacientes,
      ])
    ).rowCount ?? 0;
  borrados +=
    (
      await client.query('delete from fact_appointment where appointment_id = any($1::uuid[])', [
        ids.citas,
      ])
    ).rowCount ?? 0;
  borrados +=
    (
      await client.query('delete from fact_request where request_id = any($1::uuid[])', [
        ids.solicitudes,
      ])
    ).rowCount ?? 0;
  borrados +=
    (await client.query('delete from dim_day_capacity where date = any($1::date[])', [ids.cupos]))
      .rowCount ?? 0;
  borrados +=
    (
      await client.query('delete from dim_patient where patient_id = any($1::uuid[])', [
        ids.pacientes,
      ])
    ).rowCount ?? 0;
  borrados +=
    (
      await client.query('delete from processed_events where event_id = any($1::uuid[])', [
        idsDeEventos,
      ])
    ).rowCount ?? 0;
  return borrados;
};

const borrarAuditoria = async (client) => {
  const porActor = await client.query(
    "delete from audit_events where actor_username = 'seed-test'",
  );
  const porEntidad = await client.query(
    'delete from audit_events where entity_id = any($1::uuid[])',
    [ids.entidades],
  );
  await client.query('delete from processed_events where event_id = any($1::uuid[])', [
    idsDeEventos,
  ]);
  return (porActor.rowCount ?? 0) + (porEntidad.rowCount ?? 0);
};

const borrarAvisos = async (client) => {
  let borrados = 0;
  borrados +=
    (
      await client.query('delete from notifications where appointment_id = any($1::uuid[])', [
        ids.citas,
      ])
    ).rowCount ?? 0;
  borrados +=
    (
      await client.query('delete from notifications where patient_id = any($1::uuid[])', [
        ids.pacientes,
      ])
    ).rowCount ?? 0;
  borrados +=
    (
      await client.query('delete from ics_artifacts where appointment_id = any($1::uuid[])', [
        ids.citas,
      ])
    ).rowCount ?? 0;
  return borrados;
};

const borrarPantallas = async (client) => {
  let borrados = 0;
  borrados +=
    (
      await client.query('delete from room_state where appointment_id = any($1::uuid[])', [
        ids.citas,
      ])
    ).rowCount ?? 0;
  borrados +=
    (
      await client.query('delete from room_state where patient_id = any($1::uuid[])', [
        ids.pacientes,
      ])
    ).rowCount ?? 0;
  borrados +=
    (
      await client.query('delete from call_events where appointment_id = any($1::uuid[])', [
        ids.citas,
      ])
    ).rowCount ?? 0;
  return borrados;
};

// ── Ejecución ─────────────────────────────────────────────────────────────────

const sembrar = async () => {
  const resultado = {};
  const partes = solo === undefined ? PARTES.filter((parte) => parte !== 'reporting') : [solo];

  if (partes.includes('patients')) {
    const client = conectar('patients');
    await client.connect();
    try {
      await enTransaccion(client, async () => {
        resultado.patients = await sembrarPacientes(client);
      });
    } finally {
      await client.end();
    }
  }

  if (partes.includes('scheduling')) {
    const client = conectar('scheduling');
    await client.connect();
    try {
      await enTransaccion(client, async () => {
        resultado.scheduling = await sembrarAgenda(client);
      });
    } finally {
      await client.end();
    }
  }

  if (partes.includes('clinical')) {
    const client = conectar('clinical');
    await client.connect();
    try {
      await enTransaccion(client, async () => {
        resultado.clinical = await sembrarClinica(client);
      });
    } finally {
      await client.end();
    }
  }

  if (partes.includes('odontogram')) {
    const client = conectar('odontogram');
    await client.connect();
    try {
      await enTransaccion(client, async () => {
        resultado.odontogram = await sembrarOdontograma(client);
      });
    } finally {
      await client.end();
    }
  }

  if (solo === 'reporting') {
    const client = conectar('reporting');
    await client.connect();
    try {
      resultado.reporting = { vistas: await refrescarReportes(client) };
    } finally {
      await client.end();
    }
  }

  return resultado;
};

const borrar = async () => {
  const resultado = {};
  const orden = [
    ['scheduling', borrarAgenda],
    ['clinical', borrarClinica],
    ['odontogram', borrarOdontograma],
    ['patients', borrarPacientes],
    ['notifications', borrarAvisos],
    ['screens', borrarPantallas],
    ['identity', borrarAuditoria],
    ['reporting', borrarProyeccion],
  ];

  for (const [servicio, tarea] of orden) {
    const client = conectar(servicio);
    await client.connect();
    try {
      resultado[servicio] = await tarea(client);
    } catch (fallo) {
      aviso(`${servicio}: ${fallo instanceof Error ? fallo.message : String(fallo)}`);
      resultado[servicio] = 0;
    } finally {
      await client.end();
    }
  }

  // Las vistas materializadas se quedan contando lo borrado hasta que se refrescan.
  const reporting = conectar('reporting');
  await reporting.connect();
  try {
    await refrescarReportes(reporting);
  } finally {
    await reporting.end();
  }

  return resultado;
};

const resumenDelMundo = () => {
  titulo('Mundo de prueba (modo test)');
  dato(`Semilla: ${world.seed} · ancla: ${world.anchor}`);
  dato(`Pacientes: ${String(world.totals.patients)}`);
  dato(
    `Solicitudes: ${String(world.totals.requests)} · citas: ${String(world.totals.appointments)} ` +
      `(atendidas ${String(world.totals.attended)}, inasistencias ${String(world.totals.noShows)}, hoy ${String(world.totals.today)})`,
  );
  dato(
    `Historias: ${String(world.totals.records)} · sesiones: ${String(world.totals.sessions)} · ` +
      `récipes: ${String(world.totals.prescriptions)} · hallazgos: ${String(world.totals.findings)}`,
  );
  dato(`Eventos: ${String(eventos.length)} (repartidos en los outbox de 4 servicios)`);
  dato(
    `Huellas: pacientes ${huellas.patients} · citas ${huellas.appointments} · eventos ${huellas.events}`,
  );
  if (!silencioso) {
    dato(
      `Cupos: ${String(world.capacities.length)} días · jornada de ${world.anchor}: ` +
        `${String(world.totals.today)} citas`,
    );
  }
};

const main = async () => {
  console.log('\nOdontoCRM · modo test (ADR 0020)');
  resumenDelMundo();

  if (args.includes('--reset')) {
    if (dryRun) {
      titulo('Reset (simulación)');
      dato(
        `Borraría ${String(ids.pacientes.length)} pacientes ficticios y todo lo que cuelga de ellos:`,
      );
      dato('citas, solicitudes, historias, sesiones, récipes (y sus PDF), odontogramas,');
      dato('avisos, pantallas, auditoría del seed, proyección de reportes y sus eventos.');
      ok('No se tocó nada (--dry-run).');
      return;
    }

    titulo('Reset: borrando solo lo ficticio');
    const resultado = await borrar();
    for (const [servicio, cantidad] of Object.entries(resultado)) {
      ok(`${servicio}: ${String(cantidad)} fila(s)`);
    }
    ok('Vistas materializadas refrescadas.');
    return;
  }

  if (dryRun) {
    titulo('Siembra (simulación)');
    dato('Escribiría en odonto_patients, odonto_scheduling, odonto_clinical y odonto_odontogram,');
    dato('y dejaría los eventos en el outbox de cada servicio.');
    ok('No se tocó nada (--dry-run).');
    return;
  }

  titulo('Sembrando');
  const resultado = await sembrar();
  for (const [parte, datos] of Object.entries(resultado)) {
    if (datos.eventos !== undefined) {
      ok(`${parte}: ${String(datos.eventos)} evento(s) nuevos en el outbox`);
    } else if (datos.vistas !== undefined) {
      ok(`${parte}: ${String(datos.vistas)} vista(s) refrescadas`);
    }
  }

  titulo('Listo');
  ok(`Modo test: ${estadoModoTest.message}`);
  aviso('Los reportes cuadran cuando la pila esté arriba y los eventos se proyecten.');
  dato('Comprobar:  npm run seed:verify');
  dato('Borrar:     npm run seed:reset');
  console.log('');
};

main().catch((fallo) => {
  error(fallo instanceof Error ? fallo.message : String(fallo));
  process.exitCode = 1;
});

export { Client };
