import {
  APPOINTMENT_CONFIRMATION_TEMPLATE,
  APPOINTMENT_CONFIRMATION_TEMPLATE_KEY,
  clinicFullAddress,
  dentitionOfTooth,
  formatTicket,
  formatTime12h,
  renderTemplate,
  type AppointmentStatus,
} from '@odontocrm/contracts';
import { EVENT_TOPICS, type EventTopic, type ServiceName } from '@odontocrm/events';

import { deterministicUuid, fingerprint } from './ids.js';
import type { TestWorld, TestWorldAppointment, TestWorldPatient } from './world.js';

/**
 * Los eventos del mundo de prueba.
 *
 * El seed no inventa datos «a medias»: escribe las filas operativas **y** los
 * eventos que el sistema habría publicado, con el mismo sobre y el mismo payload
 * que arma cada servicio. De ahí salen tres cosas que la Fase 9 dejó pendientes
 * (hallazgo 24):
 *
 * - el **read model de reportes** se llena solo, porque los eventos van al outbox
 *   de su servicio y el publicador los entrega;
 * - la **auditoría** tiene el recorrido completo (con `actorUsername: 'seed-test'`,
 *   para poder distinguirlo de lo que hace una persona);
 * - `seed:verify` puede comprobar que el mundo se **reconstruye** igual, porque
 *   los identificadores de los eventos también son deterministas.
 *
 * El `occurredAt` es histórico a propósito: las citas atendidas ocurrieron en las
 * semanas anteriores y las marcas del ciclo (programada, notificada, en sala,
 * atendida) llevan su hora real. Los `eventId` son fijos, así que volver a
 * sembrar sobre lo mismo no duplica cifras: el consumidor los ve como repetidos.
 */

export interface TestWorldEvent {
  id: string;
  topic: EventTopic;
  aggregateId: string;
  producer: ServiceName;
  occurredAt: string;
  payload: Record<string, unknown>;
}

/** Actor de los eventos sembrados: nadie del consultorio, y se nota. */
const SEED_ACTOR = {
  actorId: null,
  actorUsername: 'seed-test',
  ip: null,
  userAgent: 'tools/seed-test',
  requestId: null,
} as const;

const dateVe = (date: string): string => {
  const [year = '', month = '', day = ''] = date.split('-');
  return `${day}/${month}/${year}`;
};

/** Suma minutos a un instante ISO (para las marcas intermedias del ciclo). */
const masMinutos = (instant: string, minutes: number): string =>
  new Date(new Date(instant).getTime() + minutes * 60_000).toISOString();

const auditar = (input: {
  entityType: string;
  entityId: string;
  action: string;
  summary: string;
  changedFields?: string[];
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  reason?: string | null;
}): Record<string, unknown> => ({
  entityType: input.entityType,
  entityId: input.entityId,
  action: input.action,
  summary: input.summary,
  changedFields: input.changedFields ?? [],
  before: input.before ?? null,
  after: input.after ?? null,
  reason: input.reason ?? null,
  ...SEED_ACTOR,
});

/** Bloque `notification` de las citas: lo que el bot le manda al paciente. */
const avisoDeCita = (
  appointment: TestWorldAppointment,
  request: { ticketNumber: number; reason: string } | undefined,
): Record<string, unknown> => {
  const ticket = request === undefined ? null : formatTicket(request.ticketNumber).value;
  const place = clinicFullAddress();

  return {
    appointmentId: appointment.id,
    patientId: appointment.patientId,
    patientName: appointment.patientName,
    patientPhone: appointment.patientPhone,
    ticket,
    date: appointment.date,
    startTime: appointment.startTime,
    endTime: appointment.endTime,
    place,
    subject: APPOINTMENT_CONFIRMATION_TEMPLATE.subject,
    body: renderTemplate(APPOINTMENT_CONFIRMATION_TEMPLATE.body, {
      paciente: appointment.patientName,
      fecha: dateVe(appointment.date),
      hora: formatTime12h(appointment.startTime),
      lugar: place,
      ticket: ticket ?? '—',
    }),
    channel: 'telegram',
    templateKey: APPOINTMENT_CONFIRMATION_TEMPLATE_KEY,
    icsSequence: 0,
    reason: request?.reason ?? null,
  };
};

const bloqueCita = (appointment: TestWorldAppointment): Record<string, unknown> => ({
  id: appointment.id,
  date: appointment.date,
  startTime: appointment.startTime,
  endTime: appointment.endTime,
  status: appointment.status,
  requestId: appointment.requestId,
  ...(appointment.rescheduledFromId === null
    ? {}
    : { rescheduledFromId: appointment.rescheduledFromId }),
});

/** Identificador estable del cupo de un día (el servicio usa un UUID derivado). */
export const dayCapacityId = (date: string): string => deterministicUuid('day_capacity', date);

const evento = (input: {
  key: string;
  topic: EventTopic;
  aggregateId: string;
  producer: ServiceName;
  occurredAt: string;
  payload: Record<string, unknown>;
}): TestWorldEvent => ({
  id: deterministicUuid('event', input.key),
  topic: input.topic,
  aggregateId: input.aggregateId,
  producer: input.producer,
  occurredAt: input.occurredAt,
  payload: input.payload,
});

/** Eventos de pacientes: alta de cada ficticio, con su bloque `patient` (ADR 0041). */
const eventosDePacientes = (world: TestWorld): TestWorldEvent[] =>
  world.patients.map((patient: TestWorldPatient) =>
    evento({
      key: `patients.patient.created:${patient.docNumber}`,
      topic: EVENT_TOPICS.patientCreated,
      aggregateId: patient.id,
      producer: 'patients',
      occurredAt: patient.registeredAt,
      payload: {
        patientId: patient.id,
        document: patient.document,
        fullName: patient.fullName,
        action: 'created',
        changedFields: ['fullName', 'docNumber', 'birthDate', 'phone', 'sex'],
        before: null,
        after: {
          fullName: patient.fullName,
          docNumber: patient.docNumber,
          birthDate: patient.birthDate,
          phone: patient.phone,
          phoneAlt: patient.phoneAlt,
          email: patient.email,
          address: patient.address,
        },
        reason: 'alta de paciente',
        ...SEED_ACTOR,
        patient: {
          patientId: patient.id,
          document: patient.document,
          fullName: patient.fullName,
          sex: patient.sex,
          birthDate: patient.birthDate,
          status: patient.status,
          isFictitious: true,
        },
      },
    }),
  );

const eventosDeAgenda = (world: TestWorld): TestWorldEvent[] => {
  const events: TestWorldEvent[] = [];
  const solicitudPorId = new Map(world.requests.map((request) => [request.id, request]));

  // Cupos: el día que tiene citas y los de la jornada, para que el tablero sepa
  // de qué capacidad habla (hallazgo 28 de la Fase 9).
  for (const capacity of world.capacities) {
    const assigned = world.appointments.filter(
      (appointment) =>
        appointment.date === capacity.date &&
        !['cancelada', 'reprogramada', 'no_asistio'].includes(appointment.status),
    ).length;
    events.push(
      evento({
        key: `scheduling.capacity.changed:${capacity.date}`,
        topic: EVENT_TOPICS.capacityChanged,
        aggregateId: dayCapacityId(capacity.date),
        producer: 'scheduling',
        occurredAt: `${capacity.date}T07:00:00-04:00`,
        payload: {
          ...auditar({
            entityType: 'day_capacity',
            entityId: dayCapacityId(capacity.date),
            action: 'day_capacity_changed',
            summary: `Cupo del ${dateVe(capacity.date)} fijado en ${String(capacity.capacity)} citas`,
            changedFields: ['capacity'],
            after: { capacity: capacity.capacity, assigned },
          }),
          date: capacity.date,
          capacity: capacity.capacity,
          assigned,
        },
      }),
    );
  }

  // Solicitudes: todas, en el orden en que se pidieron.
  for (const request of world.requests) {
    events.push(
      evento({
        key: `scheduling.request.created:${String(request.ticketNumber)}`,
        topic: EVENT_TOPICS.requestCreated,
        aggregateId: request.id,
        producer: 'scheduling',
        occurredAt: request.requestedAt,
        payload: {
          ...auditar({
            entityType: 'appointment_request',
            entityId: request.id,
            action: 'request_created',
            summary: `Solicitud ${formatTicket(request.ticketNumber).value} para ${request.patientName}`,
            changedFields: ['status'],
            after: {
              status: 'en_espera_cita',
              ticket: formatTicket(request.ticketNumber).value,
              channel: request.channel,
              reason: request.reason,
              patientId: request.patientId,
            },
          }),
          requestId: request.id,
          ticket: formatTicket(request.ticketNumber).value,
          ticketNumber: request.ticketNumber,
          channel: request.channel,
          patientId: request.patientId,
          patientName: request.patientName,
          patientDocument: request.patientDocument,
          patientPhone: request.patientPhone,
          reason: request.reason,
          priority: request.priority,
          requestedAt: request.requestedAt,
        },
      }),
    );
  }

  // Citas: alta y cada transición del ciclo, con su hora real.
  for (const appointment of world.appointments) {
    const request = solicitudPorId.get(appointment.requestId);
    const aviso = avisoDeCita(appointment, request);

    events.push(
      evento({
        key: `scheduling.appointment.scheduled:${appointment.id}`,
        topic: EVENT_TOPICS.appointmentScheduled,
        aggregateId: appointment.id,
        producer: 'scheduling',
        occurredAt: appointment.scheduledAt,
        payload: {
          ...auditar({
            entityType: 'appointment',
            entityId: appointment.id,
            action: 'appointment_scheduled',
            summary: `Cita para ${appointment.patientName} el ${dateVe(appointment.date)} a las ${formatTime12h(appointment.startTime)}`,
            changedFields: ['appointmentDate', 'startTime', 'status'],
            after: {
              date: appointment.date,
              startTime: appointment.startTime,
              endTime: appointment.endTime,
              requestId: appointment.requestId,
              ticket: request === undefined ? null : formatTicket(request.ticketNumber).value,
            },
          }),
          appointment: {
            id: appointment.id,
            date: appointment.date,
            startTime: appointment.startTime,
            endTime: appointment.endTime,
            status: 'programada',
            requestId: appointment.requestId,
          },
          notification: aviso,
        },
      }),
    );

    const transiciones: {
      topic: EventTopic;
      status: AppointmentStatus;
      occurredAt: string | null;
      action: string;
      resumen: string;
      extra?: Record<string, unknown>;
    }[] = [
      {
        topic: EVENT_TOPICS.appointmentNotified,
        status: 'notificada',
        occurredAt: appointment.notifiedAt,
        action: 'appointment_notified',
        resumen: `Aviso enviado a ${appointment.patientName} por la cita del ${dateVe(appointment.date)}`,
      },
      {
        topic: EVENT_TOPICS.appointmentCheckedIn,
        status: 'en_sala_espera',
        occurredAt: appointment.checkedInAt,
        action: 'appointment_checked_in',
        resumen: `${appointment.patientName} registró su llegada`,
      },
      {
        topic: EVENT_TOPICS.appointmentCalled,
        status: 'llamado',
        occurredAt: appointment.calledAt,
        action: 'appointment_called',
        resumen: `${appointment.patientName} pasó a ser llamado`,
      },
      {
        topic: EVENT_TOPICS.appointmentInConsultation,
        status: 'en_consulta',
        occurredAt: appointment.startedAt,
        action: 'appointment_in_consultation',
        resumen: `${appointment.patientName} pasó al consultorio`,
      },
      {
        topic: EVENT_TOPICS.appointmentAttended,
        status: 'atendido',
        occurredAt: appointment.finishedAt,
        action: 'appointment_attended',
        resumen: `${appointment.patientName} fue atendido`,
        extra:
          appointment.clinicalSessionId === null
            ? {}
            : { clinicalSessionId: appointment.clinicalSessionId },
      },
      {
        topic: EVENT_TOPICS.appointmentNoShow,
        status: 'no_asistio',
        occurredAt: appointment.noShowAt,
        action: 'appointment_no_show',
        resumen: `${appointment.patientName} no asistió a la cita`,
      },
      {
        topic: EVENT_TOPICS.appointmentCancelled,
        status: 'cancelada',
        occurredAt: appointment.cancelledAt,
        action: 'appointment_cancelled',
        resumen: `Cita de ${appointment.patientName} cancelada`,
      },
      {
        topic: EVENT_TOPICS.appointmentRescheduled,
        status: 'reprogramada',
        occurredAt: appointment.rescheduledAt,
        action: 'appointment_rescheduled',
        resumen: `Cita de ${appointment.patientName} reprogramada`,
      },
    ];

    for (const transicion of transiciones) {
      if (transicion.occurredAt === null) continue;
      events.push(
        evento({
          key: `${transicion.topic}:${appointment.id}`,
          topic: transicion.topic,
          aggregateId: appointment.id,
          producer: 'scheduling',
          occurredAt: transicion.occurredAt,
          payload: {
            ...auditar({
              entityType: 'appointment',
              entityId: appointment.id,
              action: transicion.action,
              summary: transicion.resumen,
              changedFields: ['status'],
              before: { status: 'programada' },
              after: {
                status: transicion.status,
                ...(transicion.extra ?? {}),
                ...(transicion.status === 'no_asistio' && appointment.noShowReason !== null
                  ? { noShowReason: appointment.noShowReason }
                  : {}),
              },
              reason:
                transicion.status === 'no_asistio'
                  ? appointment.noShowReason
                  : transicion.status === 'cancelada'
                    ? appointment.cancelReason
                    : null,
            }),
            appointment: { ...bloqueCita(appointment), status: transicion.status },
            notification: aviso,
            ...(transicion.status === 'atendido' && appointment.clinicalSessionId !== null
              ? { clinicalSessionId: appointment.clinicalSessionId }
              : {}),
          },
        }),
      );
    }
  }

  return events;
};

const eventosDeClinica = (world: TestWorld): TestWorldEvent[] => {
  const events: TestWorldEvent[] = [];

  for (const record of world.records) {
    const patient = world.patients.find((item) => item.id === record.patientId);
    const nombre = patient?.fullName ?? 'Paciente de prueba';

    events.push(
      evento({
        key: `clinical.record.created:${record.id}`,
        topic: EVENT_TOPICS.recordCreated,
        aggregateId: record.id,
        producer: 'clinical',
        occurredAt: record.createdAt,
        payload: {
          ...auditar({
            entityType: 'medical_record',
            entityId: record.id,
            action: 'medical_record_created',
            summary: `Historia clínica abierta para ${nombre}`,
            changedFields: ['status'],
            after: { patientId: record.patientId, status: 'borrador' },
            reason: 'primera visita',
          }),
          profile: {
            patientId: record.patientId,
            recordId: record.id,
            recordStatus: 'borrador',
            alertCodes: [],
          },
        },
      }),
    );

    events.push(
      evento({
        key: `clinical.record.updated:${record.id}`,
        topic: EVENT_TOPICS.recordUpdated,
        aggregateId: record.id,
        producer: 'clinical',
        occurredAt: masMinutos(record.createdAt, 20),
        payload: {
          ...auditar({
            entityType: 'medical_record',
            entityId: record.id,
            action: 'medical_record_updated',
            summary: `Anamnesis y examen de ${nombre} guardados`,
            changedFields: ['anamnesis', 'sectionKey'],
            after: { patientId: record.patientId },
          }),
          sectionKey: 'anamnesis',
          profile: {
            patientId: record.patientId,
            recordId: record.id,
            recordStatus: 'borrador',
            alertCodes: record.alertCodes,
          },
        },
      }),
    );

    events.push(
      evento({
        key: `clinical.record.signed:${record.id}`,
        topic: EVENT_TOPICS.recordSigned,
        aggregateId: record.id,
        producer: 'clinical',
        occurredAt: record.signedAt,
        payload: {
          ...auditar({
            entityType: 'medical_record',
            entityId: record.id,
            action: 'medical_record_signed',
            summary: `Historia clínica de ${nombre} firmada`,
            changedFields: ['status'],
            before: { status: 'borrador' },
            after: { status: 'firmada' },
          }),
          profile: {
            patientId: record.patientId,
            recordId: record.id,
            recordStatus: 'firmada',
            alertCodes: record.alertCodes,
          },
        },
      }),
    );
  }

  for (const session of world.sessions) {
    events.push(
      evento({
        key: `clinical.session.created:${session.id}`,
        topic: EVENT_TOPICS.sessionCreated,
        aggregateId: session.id,
        producer: 'clinical',
        occurredAt: session.openedAt,
        payload: {
          ...auditar({
            entityType: 'clinical_session',
            entityId: session.id,
            action: 'clinical_session_created',
            summary: `Sesión clínica S-${String(session.sessionNumber).padStart(6, '0')} abierta`,
            changedFields: ['status'],
            after: {
              patientId: session.patientId,
              appointmentId: session.appointmentId,
              sessionNumber: session.sessionNumber,
              status: 'borrador',
            },
          }),
          session: {
            sessionId: session.id,
            patientId: session.patientId,
            appointmentId: session.appointmentId,
            sessionNumber: session.sessionNumber,
            status: 'borrador',
            openedAt: session.openedAt,
          },
        },
      }),
    );

    events.push(
      evento({
        key: `clinical.session.closed:${session.id}`,
        topic: EVENT_TOPICS.sessionClosed,
        aggregateId: session.id,
        producer: 'clinical',
        occurredAt: session.closedAt,
        payload: {
          ...auditar({
            entityType: 'clinical_session',
            entityId: session.id,
            action: 'clinical_session_closed',
            summary: `Sesión clínica S-${String(session.sessionNumber).padStart(6, '0')} cerrada`,
            changedFields: ['status'],
            before: { status: 'borrador' },
            after: {
              status: 'cerrada',
              sessionNumber: session.sessionNumber,
              patientId: session.patientId,
              appointmentId: session.appointmentId,
              diagnostico: session.content.diagnostico,
            },
          }),
          session: {
            sessionId: session.id,
            patientId: session.patientId,
            appointmentId: session.appointmentId,
            sessionNumber: session.sessionNumber,
            status: 'cerrada',
            openedAt: session.openedAt,
            closedAt: session.closedAt,
            procedureCodes: session.procedureCodes,
            procedureCount: session.procedureCodes.length,
          },
        },
      }),
    );
  }

  for (const prescription of world.prescriptions) {
    const session = world.sessions.find((item) => item.id === prescription.sessionId);
    events.push(
      evento({
        key: `clinical.prescription.issued:${prescription.id}`,
        topic: EVENT_TOPICS.prescriptionIssued,
        aggregateId: prescription.id,
        producer: 'clinical',
        occurredAt: prescription.issuedAt,
        payload: {
          ...auditar({
            entityType: 'prescription',
            entityId: prescription.id,
            action: 'prescription_issued',
            summary: `Récipe RX-${String(prescription.number).padStart(6, '0')} emitido: ${String(prescription.items.length)} medicamento(s)`,
            changedFields: ['status'],
            before: { status: 'borrador' },
            after: {
              status: 'emitida',
              number: prescription.number,
              sessionId: prescription.sessionId,
              sessionNumber: session?.sessionNumber ?? 1,
              patientId: prescription.patientId,
              itemCount: prescription.items.length,
              verifyCode: prescription.verifyCode,
            },
          }),
          prescription: {
            id: prescription.id,
            number: prescription.number,
            sessionId: prescription.sessionId,
            patientId: prescription.patientId,
            issuedAt: prescription.issuedAt,
            medications: prescription.items.map((item) => item.medicationName),
          },
        },
      }),
    );
  }

  return events;
};

const eventosDeOdontograma = (world: TestWorld): TestWorldEvent[] => {
  const events: TestWorldEvent[] = [];

  for (const finding of world.findings) {
    events.push(
      evento({
        key: `odontogram.finding.recorded:${finding.id}`,
        topic: EVENT_TOPICS.toothFindingRecorded,
        aggregateId: finding.odontogramId,
        producer: 'odontogram',
        occurredAt: finding.recordedAt,
        payload: {
          ...auditar({
            entityType: 'odontogram',
            entityId: finding.odontogramId,
            action: 'tooth_finding_recorded',
            summary: `Hallazgo en la pieza ${String(finding.toothNumber)}: ${finding.condition}`,
            changedFields: ['toothNumber', 'condition'],
            after: {
              toothNumber: finding.toothNumber,
              surface: finding.surface,
              condition: finding.condition,
              state: finding.state,
            },
          }),
          patientId: finding.patientId,
          odontogramId: finding.odontogramId,
          toothNumber: finding.toothNumber,
          dentition: dentitionOfTooth(finding.toothNumber),
          surface: finding.surface,
          condition: finding.condition,
          state: finding.state,
          resolved: false,
        },
      }),
    );
  }

  return events;
};

/** Todos los eventos del mundo, ordenados por cuándo ocurrieron. */
export const buildTestWorldEvents = (world: TestWorld): TestWorldEvent[] =>
  [
    ...eventosDePacientes(world),
    ...eventosDeAgenda(world),
    ...eventosDeClinica(world),
    ...eventosDeOdontograma(world),
  ].sort((left, right) =>
    left.occurredAt === right.occurredAt
      ? left.id < right.id
        ? -1
        : 1
      : left.occurredAt < right.occurredAt
        ? -1
        : 1,
  );

/** Los eventos que le toca publicar a un servicio (su outbox). */
export const worldEventsFor = (world: TestWorld, producer: ServiceName): TestWorldEvent[] =>
  buildTestWorldEvents(world).filter((event) => event.producer === producer);

/** Identificadores de todos los eventos: lo que hay que limpiar al resetear. */
export const worldEventIds = (world: TestWorld): string[] =>
  buildTestWorldEvents(world).map((event) => event.id);

/**
 * Huella de cada parte del mundo. `seed:verify` compara estas huellas con lo que
 * hay en las bases: si alguien cambia el reparto de pacientes, las horas o los
 * récipes, la huella deja de cuadrar.
 */
export const worldFingerprints = (
  world: TestWorld,
): {
  seed: string;
  anchor: string;
  patients: string;
  requests: string;
  appointments: string;
  capacities: string;
  records: string;
  sessions: string;
  prescriptions: string;
  findings: string;
  events: string;
} => ({
  seed: world.seed,
  anchor: world.anchor,
  patients: fingerprint(world.patients),
  requests: fingerprint(world.requests),
  appointments: fingerprint(world.appointments),
  capacities: fingerprint(world.capacities),
  records: fingerprint(world.records),
  sessions: fingerprint(world.sessions),
  prescriptions: fingerprint(world.prescriptions),
  findings: fingerprint(world.findings),
  events: fingerprint(
    buildTestWorldEvents(world).map((event) => [event.id, event.topic, event.occurredAt]),
  ),
});
