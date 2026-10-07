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
 * cerradas, odontogramas y récipes emitidos; los **cupos** del mes; la
 * **facturación** —el histórico de tasas, los aranceles de la clínica, la factura de
 * cada sesión cerrada (la última cola en borrador), sus cobros y la nota de crédito
 * de la que se anuló—; y —esto es lo que faltaba desde la Fase 9— los **eventos de
 * dominio** en el outbox de cada servicio, con lo que el read model de reportes, la
 * auditoría y las pantallas se llenan exactamente igual que si el trabajo lo hubiera
 * hecho una persona.
 *
 * Tres decisiones que conviene tener presentes:
 *
 * 1. **Nada se toca fuera del mundo.** Cada fila y cada evento llevan identificadores
 *    derivados de la semilla, así que `seed:reset` borra exactamente eso y ni un
 *    registro real más. Los consecutivos (tickets, récipes, facturas, recibos y notas
 *    de crédito) van al rango reservado 900.000+, y al terminar cada secuencia se deja
 *    apuntando al último número real.
 * 2. **Sin modo test no corre.** `TEST_MODE=true` **y** `ALLOW_TEST_MODE=true`, y
 *    nunca con `NODE_ENV=production`: la instalación de la clínica se niega.
 * 3. **Los eventos se entregan solos** cuando la pila está arriba: el publicador de
 *    cada servicio los manda a la cola y los consumidores proyectan. Este comando no
 *    necesita la pila para escribir, pero para que los reportes cuadren hay que
 *    arrancarla (o usar `seed:verify --con-proyeccion` tras arrancarla).
 *
 * La facturación se escribe **en la base**, no esperando a la cola (ADR 0044): el
 * borrador nace del cierre de la sesión, así que el seed escribe el borrador —y su
 * factura, si ya se cobró— y **reclama el evento de cierre en `processed_events`**.
 * Con eso la cola puede entregar los eventos cuando quiera: la factura ya está y ni
 * se duplica ni se queda a medias. Lo que sí queda en el outbox son los eventos de
 * facturación (la tasa de cada día, cada emisión, cada cobro y la nota de crédito),
 * para que la auditoría tenga el recorrido del dinero.
 *
 * Ver docs/COMANDOS.md y la guía de la PC de pruebas (infra/fedora/DESARROLLO.md).
 */
import pg from 'pg';

import {
  formatCreditNoteNumber,
  formatInvoiceNumber,
  formatReceiptNumber,
} from '@odontocrm/contracts';
import { buildStorageKey } from '@odontocrm/storage';
import {
  buildTestWorld,
  buildTestWorldEvents,
  deterministicUuid,
  sessionClosedEventId,
  SISTEMA_USER_ID,
  worldEventIds,
  worldEventsFor,
  worldFingerprints,
} from '@odontocrm/testing';

import {
  ajustarSecuencia,
  almacenBilling,
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

const PARTES = ['patients', 'scheduling', 'clinical', 'odontogram', 'billing', 'reporting'];
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
  facturas: world.billing.invoices.map((invoice) => invoice.id),
  cobros: world.billing.invoices.flatMap((invoice) => invoice.payments.map((pago) => pago.id)),
  notas: world.billing.invoices.flatMap((invoice) =>
    invoice.creditNote === null ? [] : [invoice.creditNote.id],
  ),
  tasas: world.billing.rates.map((rate) => rate.rateDate),
  aranceles: world.billing.aranceles.map((arancel) => arancel.code),
  /** Los cierres de sesión que el mundo ya facturó: se reclaman en `billing`. */
  cierres: world.sessions.map((session) => sessionClosedEventId(session.id)),
  entidades: [
    ...world.patients.map((patient) => patient.id),
    ...world.requests.map((request) => request.id),
    ...world.appointments.map((appointment) => appointment.id),
    ...world.records.map((record) => record.id),
    ...world.sessions.map((session) => session.id),
    ...world.prescriptions.map((prescription) => prescription.id),
    ...world.findings.map((finding) => finding.odontogramId),
    ...world.capacities.map((capacity) => deterministicUuid('day_capacity', capacity.date)),
    ...world.billing.invoices.map((invoice) => invoice.id),
    ...world.billing.invoices.flatMap((invoice) => invoice.payments.map((pago) => pago.id)),
    ...world.billing.invoices.flatMap((invoice) =>
      invoice.creditNote === null ? [] : [invoice.creditNote.id],
    ),
  ],
};

const clinico = leerEnv('services/clinical/.env');
const almacen = almacenClinico(clinico);
const facturacion = leerEnv('services/billing/.env');
const almacenDeCobro = almacenBilling(facturacion);

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

  // Una solicitud puede tener dos citas (la reprogramada y la nueva): su historial
  // se escribe una sola vez, con la primera programación.
  const solicitudesHistoriadas = new Set();

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

    if (!solicitudesHistoriadas.has(appointment.requestId)) {
      solicitudesHistoriadas.add(appointment.requestId);
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
       values ($1,$2,$3,$4,$5,$6,$7,$8,'registrado','MODO TEST: hallazgo ficticio',null,null,'seed-test',$9,$10)
       on conflict (id) do nothing`,
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

// ── Facturación ───────────────────────────────────────────────────────────────

/** Las tres secuencias de la caja: el seed las deja apuntando al último número real. */
const SECUENCIAS_DE_CAJA = [
  ['invoice_number_seq', 'invoices', 'invoice_number'],
  ['receipt_number_seq', 'payments', 'receipt_number'],
  ['credit_note_number_seq', 'credit_notes', 'credit_note_number'],
];

/**
 * Borra las facturas que cuelgan de las sesiones del mundo —las escriba el seed o la
 * pila, si alguien arrancó la cola antes de sembrar— con sus cobros, sus notas y sus
 * PDF. Es el paso previo de la siembra (para que el mundo mande) y el corazón del
 * reset (para que no quede nada del mundo).
 */
const borrarFacturasDeSesiones = async (client) => {
  const vinculadas = await client.query(
    `select id, pdf_path as "pdfPath" from invoices
      where id in (select invoice_id from invoice_sessions where clinical_session_id = any($1::uuid[]))`,
    [ids.sesiones],
  );
  const facturaIds = vinculadas.rows.map((fila) => fila.id);
  if (facturaIds.length === 0) return { facturas: 0, cobros: 0, notas: 0 };

  // Los binarios no caen con la cascada: se borran a mano (ADR 0048).
  const archivos = await client.query(
    `select pdf_path as "pdfPath" from invoices where id = any($1::uuid[])
      union all select pdf_path as "pdfPath" from payments where invoice_id = any($1::uuid[])
      union all select pdf_path as "pdfPath" from credit_notes where invoice_id = any($1::uuid[])`,
    [facturaIds],
  );
  for (const fila of archivos.rows) {
    if (fila.pdfPath !== null) await almacenDeCobro.remove(fila.pdfPath);
  }

  const cobros = await client.query('delete from payments where invoice_id = any($1::uuid[])', [
    facturaIds,
  ]);
  const notas = await client.query('delete from credit_notes where invoice_id = any($1::uuid[])', [
    facturaIds,
  ]);
  await client.query('delete from invoice_items where invoice_id = any($1::uuid[])', [facturaIds]);
  const facturas = await client.query('delete from invoices where id = any($1::uuid[])', [
    facturaIds,
  ]);

  return {
    facturas: facturas.rowCount ?? 0,
    cobros: cobros.rowCount ?? 0,
    notas: notas.rowCount ?? 0,
  };
};

/** Guarda un documento de prueba en el almacén de facturación y devuelve su ruta y su sha256. */
const archivarDocumento = async (key, lineas) =>
  almacenDeCobro.save({ key, data: pdfDePrueba(lineas) });

const sembrarFacturacion = async (client) => {
  // 1. Los aranceles: sin precio, `billing` no deja emitir (marca la partida como
  //    «sin precio»). El mundo los declara y el reset los devuelve a cero.
  for (const arancel of world.billing.aranceles) {
    await client.query('update treatment_catalog set price_cents_usd = $2 where code = $1', [
      arancel.code,
      arancel.priceCentsUsd,
    ]);
  }

  // 2. El histórico de tasas. El mundo es dueño de esos días: se reescriben para que
  //    la siembra sea reproducible (una corrección a mano de la clínica se pierde, y
  //    `seed:verify` lo diría de todas formas).
  await client.query('delete from exchange_rates where rate_date = any($1::date[])', [ids.tasas]);
  for (const rate of world.billing.rates) {
    await client.query(
      `insert into exchange_rates (id, rate_date, rate_micros, source, note, raw_payload, set_by_user_id, set_by_username, created_at)
       values ($1,$2,$3,$4,$5,null,null,'seed-test',$6)`,
      [
        rate.id,
        rate.rateDate,
        rate.rateMicros,
        rate.source,
        rate.note,
        `${rate.rateDate}T08:00:00-04:00`,
      ],
    );
  }

  // 3. Lo que la pila hubiera facturado antes de sembrar: se borra para que el mundo
  //    sea la única versión de esas sesiones (y no choque el índice único de sesión).
  await borrarFacturasDeSesiones(client);

  // 4. Facturas, partidas y a qué sesión cubren. El enlace es la segunda red de
  //    idempotencia del consumidor: un evento repetido no crea otra factura.
  const catalogo = await client.query('select id, code from treatment_catalog');
  const catalogoPorCodigo = new Map(catalogo.rows.map((fila) => [fila.code, fila.id]));

  for (const invoice of world.billing.invoices) {
    const esBorrador = invoice.status === 'borrador';
    const factura = esBorrador
      ? null
      : await archivarDocumento(
          buildStorageKey(
            'billing',
            invoice.id,
            `factura-${formatInvoiceNumber(invoice.series, invoice.invoiceNumber ?? 0)}`,
            'pdf',
          ),
          invoice.pdfLines ?? [],
        );

    await client.query(
      `insert into invoices (
         id, series, invoice_number, control_number, fiscal_form_id, status,
         patient_id, patient_name, patient_doc_type, patient_doc_number, patient_tax_id, patient_fiscal_address,
         rate_at_draft_micros, exchange_rate_micros,
         exempt_amount_cents_usd, taxable_amount_cents_usd, iva_amount_cents_usd, total_cents_usd, balance_cents_usd,
         exempt_amount_ves_centimos, taxable_amount_ves_centimos, iva_amount_ves_centimos, total_ves_centimos,
         pdf_path, pdf_sha256, generated_at, print_count, last_printed_at,
         voided_at, void_reason, voided_by_user_id, voided_by_username,
         is_test, created_by_user_id, created_by_username, created_at, issued_at, issued_by_user_id
       ) values (
         $1,$2,$3,null,null,$4,
         $5,$6,$7,$8,null,null,
         $9,$10,
         $11,$12,$13,$14,$15,
         $16,$17,$18,$19,
         $20,$21,$22,0,null,
         $23,$24,$25,$26,
         true,$27,$28,$29,$30,null
       )
       on conflict (id) do update set
         status = excluded.status, invoice_number = excluded.invoice_number,
         rate_at_draft_micros = excluded.rate_at_draft_micros,
         exchange_rate_micros = excluded.exchange_rate_micros,
         exempt_amount_cents_usd = excluded.exempt_amount_cents_usd,
         taxable_amount_cents_usd = excluded.taxable_amount_cents_usd,
         iva_amount_cents_usd = excluded.iva_amount_cents_usd,
         total_cents_usd = excluded.total_cents_usd, balance_cents_usd = excluded.balance_cents_usd,
         exempt_amount_ves_centimos = excluded.exempt_amount_ves_centimos,
         taxable_amount_ves_centimos = excluded.taxable_amount_ves_centimos,
         iva_amount_ves_centimos = excluded.iva_amount_ves_centimos,
         total_ves_centimos = excluded.total_ves_centimos,
         pdf_path = excluded.pdf_path, pdf_sha256 = excluded.pdf_sha256, generated_at = excluded.generated_at,
         voided_at = excluded.voided_at, void_reason = excluded.void_reason,
         voided_by_user_id = excluded.voided_by_user_id, voided_by_username = excluded.voided_by_username,
         issued_at = excluded.issued_at`,
      [
        invoice.id,
        invoice.series,
        invoice.invoiceNumber,
        invoice.status,
        invoice.patientId,
        invoice.patientName,
        invoice.patientDocType,
        invoice.patientDocNumber,
        invoice.rateAtDraftMicros,
        invoice.exchangeRateMicros,
        invoice.exemptAmountCentsUsd,
        invoice.taxableAmountCentsUsd,
        invoice.ivaAmountCentsUsd,
        invoice.totalCentsUsd,
        invoice.balanceCentsUsd,
        invoice.venBs?.exemptAmountVesCentimos ?? 0,
        invoice.venBs?.taxableAmountVesCentimos ?? 0,
        invoice.venBs?.ivaAmountVesCentimos ?? 0,
        invoice.venBs?.totalVesCentimos ?? 0,
        factura?.path ?? null,
        factura?.sha256 ?? null,
        invoice.issuedAt,
        invoice.voidedAt,
        invoice.voidReason,
        invoice.voidedByUsername === null ? null : SISTEMA_USER_ID,
        invoice.voidedByUsername,
        SISTEMA_USER_ID,
        invoice.createdByUsername,
        invoice.createdAt,
        invoice.issuedAt,
      ],
    );

    await client.query('delete from invoice_items where invoice_id = $1', [invoice.id]);
    for (const item of invoice.items) {
      await client.query(
        `insert into invoice_items (id, invoice_id, catalog_id, code, description, tooth_number, surfaces, quantity, unit_price_cents_usd, total_price_cents_usd, tax_category, tax_rate_basis_points, iva_amount_cents_usd, needs_pricing)
         values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14)`,
        [
          item.id,
          invoice.id,
          catalogoPorCodigo.get(item.code) ?? null,
          item.code,
          item.description,
          item.toothNumber,
          item.surfaces === null ? null : JSON.stringify(item.surfaces),
          item.quantity,
          item.unitPriceCentsUsd,
          item.totalPriceCentsUsd,
          item.taxCategory,
          item.taxRateBasisPoints,
          item.ivaAmountCentsUsd,
          item.needsPricing,
        ],
      );
    }

    await client.query(
      `insert into invoice_sessions (invoice_id, clinical_session_id, created_at)
       values ($1,$2,$3) on conflict (clinical_session_id) do update set invoice_id = excluded.invoice_id`,
      [invoice.id, invoice.sessionId, invoice.createdAt],
    );
  }

  // 5. Los cobros, con su recibo archivado (ADR 0048) y la tasa del día del pago.
  for (const invoice of world.billing.invoices) {
    for (const pago of invoice.payments) {
      const recibo = await archivarDocumento(
        buildStorageKey(
          'billing',
          invoice.id,
          `recibo-${formatReceiptNumber(pago.receiptNumber)}`,
          'pdf',
        ),
        pago.pdfLines,
      );

      await client.query(
        `insert into payments (
           id, invoice_id, receipt_number, method, reference, tendered_amount, tendered_currency,
           amount_cents_usd, exchange_rate_micros, imputation_policy, fx_difference_cents_usd,
           applies_igtf, igtf_basis_points, igtf_perceived_by, igtf_amount_cents_usd, igtf_amount_ves_centimos,
           pdf_path, pdf_sha256, print_count, last_printed_at,
           received_by_user_id, received_by_username, is_test, created_at, voided_at, void_reason, voided_by_user_id
         ) values (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,0,null,
           $19,$20,true,$21,$22,$23,$24
         )
         on conflict (id) do update set
           amount_cents_usd = excluded.amount_cents_usd, tendered_amount = excluded.tendered_amount,
           exchange_rate_micros = excluded.exchange_rate_micros, fx_difference_cents_usd = excluded.fx_difference_cents_usd,
           applies_igtf = excluded.applies_igtf, igtf_basis_points = excluded.igtf_basis_points,
           igtf_perceived_by = excluded.igtf_perceived_by,
           igtf_amount_cents_usd = excluded.igtf_amount_cents_usd,
           igtf_amount_ves_centimos = excluded.igtf_amount_ves_centimos,
           pdf_path = excluded.pdf_path, pdf_sha256 = excluded.pdf_sha256,
           voided_at = excluded.voided_at, void_reason = excluded.void_reason`,
        [
          pago.id,
          invoice.id,
          pago.receiptNumber,
          pago.method,
          pago.reference,
          pago.tenderedAmount,
          pago.tenderedCurrency,
          pago.amountCentsUsd,
          pago.exchangeRateMicros,
          pago.imputationPolicy,
          pago.fxDifferenceCentsUsd,
          pago.appliesIgtf,
          pago.igtfBasisPoints,
          pago.igtfPerceivedBy,
          pago.igtfAmountCentsUsd,
          pago.igtfAmountVesCentimos,
          recibo.path,
          recibo.sha256,
          SISTEMA_USER_ID,
          pago.receivedByUsername,
          pago.createdAt,
          pago.voidedAt,
          pago.voidReason,
          pago.voidedAt === null ? null : SISTEMA_USER_ID,
        ],
      );
    }
  }

  // 6. La nota de crédito de la factura anulada, con su PDF.
  let notas = 0;
  for (const invoice of world.billing.invoices) {
    const nota = invoice.creditNote;
    if (nota === null) continue;
    const documento = await archivarDocumento(
      buildStorageKey(
        'billing',
        invoice.id,
        `nota-credito-${formatCreditNoteNumber(nota.creditNoteNumber)}`,
        'pdf',
      ),
      nota.pdfLines,
    );

    await client.query(
      `insert into credit_notes (
         id, credit_note_number, invoice_id, invoice_number, invoice_issued_at, invoice_total_cents_usd,
         kind, reason, total_cents_usd, exchange_rate_micros, total_ves_centimos,
         pdf_path, pdf_sha256, is_test, issued_by_user_id, issued_by_username, issued_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,true,$14,$15,$16)
       on conflict (id) do update set
         reason = excluded.reason, total_cents_usd = excluded.total_cents_usd,
         exchange_rate_micros = excluded.exchange_rate_micros,
         total_ves_centimos = excluded.total_ves_centimos,
         pdf_path = excluded.pdf_path, pdf_sha256 = excluded.pdf_sha256,
         issued_at = excluded.issued_at`,
      [
        nota.id,
        nota.creditNoteNumber,
        invoice.id,
        invoice.invoiceNumber,
        invoice.issuedAt,
        invoice.totalCentsUsd,
        nota.kind,
        nota.reason,
        nota.totalCentsUsd,
        nota.exchangeRateMicros,
        nota.totalVesCentimos,
        documento.path,
        documento.sha256,
        SISTEMA_USER_ID,
        nota.issuedByUsername,
        nota.issuedAt,
      ],
    );
    notas += 1;
  }

  /**
   * 7. El mundo **reclama** el cierre de cada sesión que ya facturó: cuando la cola
   * entregue el evento, `billing` lo verá como duplicado y no creará otra factura.
   * Es lo que hace que la caja abra igual con la pila parada o con la pila arriba.
   */
  for (const cierre of ids.cierres) {
    await client.query(
      `insert into processed_events (event_id, topic) values ($1,'clinical.session.closed')
       on conflict (event_id) do nothing`,
      [cierre],
    );
  }

  for (const [secuencia, tabla, columna] of SECUENCIAS_DE_CAJA) {
    await ajustarSecuencia(client, secuencia, tabla, columna);
  }

  // 8. Los eventos de facturación, al outbox: la tasa, cada emisión, cada cobro y la
  //    nota de crédito. La cola los entrega y la auditoría guarda el rastro del dinero.
  const eventos = await sembrarEventos(client, worldEventsFor(world, 'billing'));

  return {
    eventos,
    aranceles: world.billing.aranceles.length,
    tasas: world.billing.rates.length,
    facturas: world.billing.invoices.length,
    cobros: ids.cobros.length,
    notas,
  };
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

/**
 * Borra la facturación del mundo: sus tasas, sus facturas (las del mundo **y** las que
 * la pila hubiera creado para esas sesiones), sus cobros, su nota de crédito, sus PDF,
 * el reclamo de los cierres y los eventos de facturación del outbox.
 *
 * Los aranceles vuelven a **cero**, que es como los deja la migración: el seed solo
 * toca los servicios, así que los bienes del catálogo conservan su precio.
 */
const borrarFacturacion = async (client) => {
  const documentos = await borrarFacturasDeSesiones(client);

  const tasas = await client.query('delete from exchange_rates where rate_date = any($1::date[])', [
    ids.tasas,
  ]);
  const aranceles = await client.query(
    'update treatment_catalog set price_cents_usd = 0 where code = any($1::text[])',
    [ids.aranceles],
  );
  const reclamos = await client.query(
    // `billing.processed_events.event_id` es **text** (no uuid, como en reporting).
    'delete from processed_events where event_id = any($1::text[])',
    [ids.cierres],
  );

  for (const [secuencia, tabla, columna] of SECUENCIAS_DE_CAJA) {
    await ajustarSecuencia(client, secuencia, tabla, columna);
  }

  return (
    documentos.facturas +
    documentos.cobros +
    documentos.notas +
    (tasas.rowCount ?? 0) +
    (aranceles.rowCount ?? 0) +
    (reclamos.rowCount ?? 0) +
    (await borrarEventos(
      client,
      worldEventsFor(world, 'billing').map((e) => e.id),
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
  // `audit_events.entity_id` es texto (la auditoría guarda entidades de varios
  // servicios): se compara como texto.
  const porEntidad = await client.query(
    'delete from audit_events where entity_id = any($1::text[])',
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

  if (partes.includes('billing')) {
    const client = conectar('billing');
    await client.connect();
    try {
      await enTransaccion(client, async () => {
        resultado.billing = await sembrarFacturacion(client);
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
    ['billing', borrarFacturacion],
    ['patients', borrarPacientes],
    ['notifications', borrarAvisos],
    ['screens', borrarPantallas],
    ['identity', borrarAuditoria],
    ['reporting', borrarProyeccion],
  ];

  for (const [servicio, tarea] of orden) {
    let client;
    try {
      client = conectar(servicio);
      await client.connect();
      resultado[servicio] = await tarea(client);
    } catch (fallo) {
      aviso(`${servicio}: ${fallo instanceof Error ? fallo.message : String(fallo)}`);
      resultado[servicio] = 0;
    } finally {
      if (client !== undefined) await client.end();
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
  dato(
    `Facturación: ${String(world.totals.invoices)} factura(s) —${String(world.totals.drafts)} en borrador— · ` +
      `${String(world.totals.payments)} cobro(s) · ${String(world.totals.creditNotes)} nota(s) de crédito · ` +
      `${String(world.totals.rates)} tasa(s) · ${String(world.totals.aranceles)} arancel(es)`,
  );
  dato(`Eventos: ${String(eventos.length)} (repartidos en los outbox de 5 servicios)`);
  dato(
    `Huellas: pacientes ${huellas.patients} · citas ${huellas.appointments} · ` +
      `facturas ${huellas.invoices} · eventos ${huellas.events}`,
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
      dato(
        `facturas (${String(ids.facturas.length)}), cobros (${String(ids.cobros.length)}), notas de crédito,`,
      );
      dato('tasas del mundo, aranceles a cero, avisos, pantallas, auditoría del seed,');
      dato('proyección de reportes y sus eventos.');
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
    dato('Escribiría en odonto_patients, odonto_scheduling, odonto_clinical, odonto_odontogram');
    dato('y odonto_billing (tasas, aranceles, facturas, cobros y nota de crédito),');
    dato('y dejaría los eventos en el outbox de cada servicio.');
    ok('No se tocó nada (--dry-run).');
    return;
  }

  titulo('Sembrando');
  const resultado = await sembrar();
  for (const [parte, datos] of Object.entries(resultado)) {
    if (parte === 'billing') {
      ok(
        `billing: ${String(datos.facturas)} factura(s), ${String(datos.cobros)} cobro(s), ` +
          `${String(datos.notas)} nota(s) y ${String(datos.tasas)} tasa(s) · ` +
          `${String(datos.eventos)} evento(s) nuevos en el outbox`,
      );
    } else if (datos.eventos !== undefined) {
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
