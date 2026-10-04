import { TEST_WAIT_MS } from '@odontocrm/testing';
import { reportFiltersSchema, reportToCsv, shiftIsoDate } from '@odontocrm/contracts';
import {
  consumerQueueName,
  createBoss,
  createOutboxRunner,
  ensureDomainEventsQueue,
  outboxEvents,
  registerDomainEventHandler,
  startBoss,
  stopBoss,
  toOutboxInsert,
} from '@odontocrm/db';
import {
  EVENT_TOPICS,
  createDomainEvent,
  type DomainEvent,
  type EventTopic,
} from '@odontocrm/events';
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadReportingConfig } from './config.js';
import { applyDomainEvent, handleDomainEvents } from './consumer.js';
import { createReportingDatabase } from './db/client.js';
import {
  dimDayCapacity,
  dimPatient,
  factAppointment,
  factClinicalSession,
  factPrescription,
  factPrescriptionItem,
  factRequest,
  factToothFinding,
  patientProfiles,
  processedEvents,
  reportRefreshes,
} from './db/schema.js';
import { buildReportSummary, hoyEnElConsultorio } from './reports/index.js';
import { buildClinicalProfileReport } from './reports/clinical-profile.js';
import { buildDemographicsReport } from './reports/demographics.js';
import { buildFunnelReport } from './reports/funnel.js';
import { buildOralHealthReport } from './reports/oral-health.js';
import { buildPrescriptionsReport } from './reports/prescriptions.js';
import type { ReportContext } from './reports/shared.js';
import { MATERIALIZED_VIEWS } from './db/views.js';

/**
 * Pruebas de integración del servicio de reportes contra PostgreSQL real:
 *
 *  1. los eventos que llegan por la **cola compartida** (outbox → pg-boss → consumidor)
 *     se proyectan en el read model;
 *  2. un evento aplicado **dos veces** no duplica la fila (idempotencia);
 *  3. el **embudo cuadra** con las citas insertadas;
 *  4. los filtros de **edad, sexo y estado se combinan**;
 *  5. la **salud bucal** refleja los hallazgos vigentes e ignora la impresión del
 *     odontograma, los hallazgos superados y los borrados;
 *  6. las **recetas** cuentan por medicamento y dejan fuera las anuladas;
 *  7. el **CSV** sale con BOM, separador `;`, CRLF y acentos correctos;
 *  8. el **orden de llegada** entre servicios no importa: el perfil clínico que se
 *     adelanta al alta del paciente se aplica cuando la ficha aparece.
 *
 * La suite usa su **propia cola** (`domain-events.prueba-reporting`) y publica ahí
 * mismo (`createOutboxRunner` con `consumerQueue`), así que no reparte eventos a las
 * colas de los servicios reales mientras corren las pruebas.
 *
 * **Se aísla vaciando el read model antes de empezar.** Afirma cifras absolutas
 * («el embudo cuenta 4 solicitudes»), y `odonto_reporting` es la misma base del
 * entorno de desarrollo: lo que dejaron el humo u otras corridas cambiaría los
 * totales. Vaciar el read model no pierde nada del sistema —es dato **derivado y
 * reconstruible**, y lo repueblan los eventos que lleguen después— y es la misma
 * regla que dejó la Fase 7: cada suite se aísla de lo que dejaron las demás.
 */

const reportingUrl = process.env['TEST_REPORTING_DATABASE_URL'];
const eventsUrl = process.env['TEST_EVENTS_DATABASE_URL'];
const ready = reportingUrl !== undefined && eventsUrl !== undefined;
const describeConBases = ready ? describe : describe.skip;

const sufijo = String(Date.now()).slice(-7);
const PRODUCTOR = `prueba-reporting-${sufijo}`;
const colaDePrueba = consumerQueueName('prueba-reporting');

/** Fechas de la prueba, relativas a hoy (el reporte usa la fecha del consultorio). */
const HOY = hoyEnElConsultorio('America/Caracas');
const DIA_1 = shiftIsoDate(HOY, -6);
const DIA_2 = shiftIsoDate(HOY, -3);
const DIA_3 = shiftIsoDate(HOY, -1);
const DESDE = DIA_1;

interface EntradaPaciente {
  id: string;
  document: string;
  fullName: string;
  sex: string;
  birthDate: string;
  status: string;
}

/** Cuatro pacientes: dos mujeres, dos hombres; uno inactivo y uno en espera de cita. */
const PACIENTES: Readonly<Record<string, EntradaPaciente>> = {
  maria: {
    id: globalThis.crypto.randomUUID(),
    document: 'V-90111111',
    fullName: 'María Peña',
    sex: 'F',
    birthDate: '1990-05-10',
    status: 'activo',
  },
  jose: {
    id: globalThis.crypto.randomUUID(),
    document: 'V-90222222',
    fullName: 'José Pérez',
    sex: 'M',
    birthDate: '1950-01-01',
    status: 'en_espera_cita',
  },
  ana: {
    id: globalThis.crypto.randomUUID(),
    document: 'V-90333333',
    fullName: 'Ana Gómez',
    sex: 'F',
    birthDate: '2015-03-03',
    status: 'activo',
  },
  luis: {
    id: globalThis.crypto.randomUUID(),
    document: 'V-90444444',
    fullName: 'Luis Niño',
    sex: 'M',
    birthDate: '2018-06-06',
    status: 'inactivo',
  },
};

const maria = PACIENTES['maria'] as EntradaPaciente;
const jose = PACIENTES['jose'] as EntradaPaciente;
const ana = PACIENTES['ana'] as EntradaPaciente;
const luis = PACIENTES['luis'] as EntradaPaciente;
const idsPacientes = [maria.id, jose.id, ana.id, luis.id];

/** Alta de paciente con el bloque `patient` que publica el servicio de pacientes. */
const eventoPaciente = (entrada: EntradaPaciente, occurredAt: string): DomainEvent =>
  createDomainEvent({
    topic: EVENT_TOPICS.patientCreated,
    aggregateId: entrada.id,
    producer: PRODUCTOR,
    occurredAt: new Date(occurredAt),
    payload: {
      patientId: entrada.id,
      document: entrada.document,
      fullName: entrada.fullName,
      action: 'created',
      changedFields: ['fullName', 'docNumber', 'birthDate', 'sex'],
      before: null,
      after: null,
      reason: 'alta de paciente',
      patient: {
        patientId: entrada.id,
        document: entrada.document,
        fullName: entrada.fullName,
        sex: entrada.sex,
        birthDate: entrada.birthDate,
        status: entrada.status,
        isFictitious: false,
      },
    },
  });

const eventoSolicitud = (input: {
  requestId: string;
  ticketNumber: number;
  patientId: string;
  occurredAt: string;
}): DomainEvent =>
  createDomainEvent({
    topic: EVENT_TOPICS.requestCreated,
    aggregateId: input.requestId,
    producer: PRODUCTOR,
    occurredAt: new Date(input.occurredAt),
    payload: {
      requestId: input.requestId,
      ticket: `#${String(input.ticketNumber).padStart(6, '0')}`,
      ticketNumber: input.ticketNumber,
      channel: 'telefono',
      patientId: input.patientId,
      reason: 'dolor dental',
      requestedAt: input.occurredAt,
      after: {
        ticket: String(input.ticketNumber),
        channel: 'telefono',
        patientId: input.patientId,
      },
    },
  });

interface EntradaCita {
  appointmentId: string;
  requestId: string;
  patientId: string;
  date: string;
  startTime: string;
  occurredAt: string;
  topic: EventTopic;
  status: string;
  after?: Record<string, unknown>;
  previousAppointmentId?: string;
  reason?: string;
}

/**
 * Evento de cita tal como lo publica la agenda: el bloque `appointment` (sin
 * paciente) más el aviso de la agenda, que es quien trae `patientId`.
 */
const eventoCita = (cita: EntradaCita): DomainEvent =>
  createDomainEvent({
    topic: cita.topic,
    aggregateId: cita.appointmentId,
    producer: PRODUCTOR,
    occurredAt: new Date(cita.occurredAt),
    payload: {
      entityType: 'appointment',
      entityId: cita.appointmentId,
      action: 'appointment_transition',
      summary: `cita ${cita.status}`,
      changedFields: ['status'],
      before: null,
      after: cita.after ?? { status: cita.status },
      reason: cita.reason ?? null,
      appointment: {
        id: cita.appointmentId,
        date: cita.date,
        startTime: cita.startTime,
        endTime: '10:00',
        status: cita.status,
        requestId: cita.requestId,
      },
      previousAppointmentId: cita.previousAppointmentId ?? null,
      notification: {
        appointmentId: cita.appointmentId,
        patientId: cita.patientId,
        patientName: 'paciente de prueba',
        ticket: null,
      },
    },
  });

const eventoHallazgo = (input: {
  patientId: string;
  toothNumber: number;
  condition: string;
  surface?: string | null;
  state?: string | null;
  occurredAt: string;
  topic?: EventTopic;
  action?: string;
  resolved?: boolean;
}): DomainEvent =>
  createDomainEvent({
    topic: input.topic ?? EVENT_TOPICS.toothFindingRecorded,
    aggregateId: globalThis.crypto.randomUUID(),
    producer: PRODUCTOR,
    occurredAt: new Date(input.occurredAt),
    payload: {
      entityType: 'odontogram',
      entityId: globalThis.crypto.randomUUID(),
      action: input.action ?? 'tooth_finding_recorded',
      summary: 'hallazgo',
      patientId: input.patientId,
      odontogramId: globalThis.crypto.randomUUID(),
      toothNumber: input.toothNumber,
      dentition: 'permanente',
      surface: input.surface ?? null,
      condition: input.condition,
      state: input.state ?? 'pendiente',
      resolved: input.resolved ?? false,
    },
  });

const eventoRecipe = (input: {
  prescriptionId: string;
  patientId: string;
  number: string;
  occurredAt: string;
  medications: string[];
  topic?: EventTopic;
  printCount?: number;
}): DomainEvent => {
  const emitida = input.topic === undefined || input.topic === EVENT_TOPICS.prescriptionIssued;
  return createDomainEvent({
    topic: input.topic ?? EVENT_TOPICS.prescriptionIssued,
    aggregateId: input.prescriptionId,
    producer: PRODUCTOR,
    occurredAt: new Date(input.occurredAt),
    payload: {
      entityType: 'prescription',
      entityId: input.prescriptionId,
      action: 'prescription_event',
      summary: `récipe ${input.number}`,
      after:
        input.printCount === undefined ? { status: 'emitida' } : { printCount: input.printCount },
      prescription: emitida
        ? {
            id: input.prescriptionId,
            number: input.number,
            sessionId: null,
            patientId: input.patientId,
            issuedAt: input.occurredAt,
            medications: input.medications,
          }
        : null,
    },
  });
};

/**
 * Impresión del odontograma: **reutiliza el tópico de «hallazgo registrado»** con la
 * carga de auditoría y sin pieza. Es el caso que el consumidor tiene que distinguir.
 */
const eventoImpresionOdontograma = (patientId: string, occurredAt: string): DomainEvent =>
  createDomainEvent({
    topic: EVENT_TOPICS.toothFindingRecorded,
    aggregateId: globalThis.crypto.randomUUID(),
    producer: PRODUCTOR,
    occurredAt: new Date(occurredAt),
    payload: {
      entityType: 'odontogram',
      entityId: globalThis.crypto.randomUUID(),
      action: 'odontogram_printed',
      summary: 'Odontograma impreso',
      changedFields: [],
      before: null,
      after: { printCount: 1, patientId },
      reason: null,
    },
  });

const eventoAviso = (ok: boolean, occurredAt: string): DomainEvent =>
  createDomainEvent({
    topic: ok ? EVENT_TOPICS.messageSent : EVENT_TOPICS.messageFailed,
    aggregateId: globalThis.crypto.randomUUID(),
    producer: PRODUCTOR,
    occurredAt: new Date(occurredAt),
    payload: {
      notificationId: globalThis.crypto.randomUUID(),
      patientId: maria.id,
      appointmentId: null,
      templateKey: 'confirmacion_cita',
      summary: ok ? 'aviso enviado' : 'aviso fallido',
    },
  });

describeConBases('reporting: read model por eventos, reportes y exportación', () => {
  let handle: ReturnType<typeof createReportingDatabase>;
  let boss: PgBoss;
  const inicioDeLaSuite = new Date();
  /** Cita y solicitud de María, compartidas con la prueba de la sesión clínica. */
  const compartidas: { solicitud: string; cita: string } = { solicitud: '', cita: '' };

  const db = () => handle.db;

  const contexto = (
    filtros: Record<string, unknown> = {},
    range = { from: DESDE, to: HOY },
  ): ReportContext => ({
    filters: reportFiltersSchema.parse(filtros),
    range,
    generatedAt: new Date().toISOString(),
  });

  /** Vacía el outbox por completo (un ciclo reclama como mucho 50 eventos). */
  const flushOutbox = async (): Promise<void> => {
    const runner = createOutboxRunner({ pool: handle.pool, boss, consumerQueue: colaDePrueba });
    for (let ciclo = 0; ciclo < 10; ciclo += 1) {
      const resultado = await runner.flush();
      if (resultado.claimed === 0) return;
    }
  };

  /** Emite eventos por el camino real: outbox → cola → consumidor. */
  const emitir = async (eventos: readonly DomainEvent[]): Promise<void> => {
    await db()
      .insert(outboxEvents)
      .values(eventos.map((evento) => toOutboxInsert(evento)));
    await flushOutbox();
  };

  /** Espera a que el consumidor haya aplicado los eventos (la cola es asíncrona). */
  const esperarA = async (condicion: () => Promise<boolean>, que: string): Promise<void> => {
    const limite = Date.now() + TEST_WAIT_MS;
    while (Date.now() < limite) {
      if (await condicion()) return;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`Se agotó el tiempo esperando: ${que}`);
  };

  /**
   * Espera a que un **reporte** cuadre con lo esperado.
   *
   * Los reportes sin filtros de paciente se sirven de una **vista materializada**, y
   * la vista se refresca al cerrar cada lote de eventos: si la cola entrega los
   * eventos en dos tandas (pasa cuando la máquina está cargada, con las 68 suites en
   * paralelo), la foto va una tanda por detrás. Se espera a que cuadre en vez de
   * afirmar contra una foto a medio hacer; si no cuadra, la aserción de después
   * enseña la diferencia.
   */
  const esperarReporte = async <T>(
    leer: () => Promise<T>,
    cuadra: (valor: T) => boolean,
    que: string,
  ): Promise<T> => {
    const limite = Date.now() + TEST_WAIT_MS;
    let ultimo = await leer();
    while (Date.now() < limite && !cuadra(ultimo)) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      ultimo = await leer();
    }
    void que;
    return ultimo;
  };

  /** `select count(*)` de una tabla con una condición opcional, sin SQL armado. */
  const contar = async (tabla: string, condicion?: SQL): Promise<number> => {
    const resultado = await db().execute(
      sql`select count(*)::int as n from ${sql.identifier(tabla)}${
        condicion === undefined ? sql`` : sql` where ${condicion}`
      }`,
    );
    return Number(resultado.rows[0]?.['n'] ?? 0);
  };

  const leerCita = async (appointmentId: string) =>
    (
      await db()
        .select()
        .from(factAppointment)
        .where(eq(factAppointment.appointmentId, appointmentId))
    )[0] ?? null;

  beforeAll(async () => {
    if (!ready) throw new Error('faltan TEST_REPORTING_DATABASE_URL o TEST_EVENTS_DATABASE_URL');

    handle = createReportingDatabase(
      loadReportingConfig({
        DATABASE_URL: reportingUrl,
        EVENTS_DATABASE_URL: eventsUrl,
        LOG_LEVEL: 'silent',
      }),
    );

    boss = createBoss({ connectionString: eventsUrl, applicationName: 'odontocrm-test-reporting' });
    await startBoss(boss);
    await ensureDomainEventsQueue(boss);
    await registerDomainEventHandler(
      boss,
      async (eventos) => {
        /**
         * Solo los eventos **de esta suite**.
         *
         * El publicador reparte cada evento entre todas las colas que empiezan por
         * `domain-events.`, y la de prueba existe mientras corre la suite: los
         * servicios reales (que están en marcha durante `npm run test:integration`)
         * entregan aquí sus eventos, y sin este filtro las cifras de la suite se
         * mezclaban con las del humo y las demás suites —que es exactamente lo que
         * pasaba antes de aislarla—.
         */
        const propios = eventos.filter((evento) => evento.producer === PRODUCTOR);
        if (propios.length > 0) await handleDomainEvents({ db: handle.db }, propios);
      },
      { queue: colaDePrueba, pollingIntervalSeconds: 0.5 },
    );

    /**
     * Aislamiento (una sola vez, **no** antes de cada prueba: la suite es una
     * secuencia y las pruebas se apoyan en lo que emitieron las anteriores).
     *
     * `npm run test:integration` le prepara a esta suite una **base temporal propia**
     * (`tools/test-integration.mjs`), porque es la única que afirma cifras absolutas
     * y el servicio de reportes en marcha proyecta en la base del servicio lo que
     * publican las demás suites. Si alguien apunta `TEST_REPORTING_DATABASE_URL` a una
     * base compartida, esta limpieza —y el rango de fechas de cada prueba— siguen
     * dejándola aislada.
     */
    await db().delete(factToothFinding);
    await db().delete(factPrescriptionItem);
    await db().delete(factPrescription);
    await db().delete(factClinicalSession);
    await db().delete(factAppointment);
    await db().delete(factRequest);
    await db().delete(patientProfiles);
    await db().delete(dimPatient);
    await db().delete(dimDayCapacity);
    await db().delete(reportRefreshes);
    await db().delete(processedEvents);
    for (const vista of MATERIALIZED_VIEWS) {
      await db().execute(sql`refresh materialized view ${sql.identifier(vista)}`);
    }
  }, 30_000);

  afterAll(async () => {
    if (!ready) return;

    await db().delete(outboxEvents).where(eq(outboxEvents.producer, PRODUCTOR));
    await db().delete(processedEvents).where(eq(processedEvents.producer, PRODUCTOR));
    await db().delete(factToothFinding).where(inArray(factToothFinding.patientId, idsPacientes));
    await db()
      .delete(factPrescriptionItem)
      .where(inArray(factPrescriptionItem.patientId, idsPacientes));
    await db().delete(factPrescription).where(inArray(factPrescription.patientId, idsPacientes));
    await db()
      .delete(factClinicalSession)
      .where(inArray(factClinicalSession.patientId, idsPacientes));
    await db().delete(factAppointment).where(inArray(factAppointment.patientId, idsPacientes));
    await db().delete(factRequest).where(inArray(factRequest.patientId, idsPacientes));
    await db().delete(dimPatient).where(inArray(dimPatient.patientId, idsPacientes));
    await db()
      .delete(dimDayCapacity)
      .where(inArray(dimDayCapacity.date, [DIA_1, DIA_2, DIA_3, HOY]));
    await db()
      .delete(reportRefreshes)
      .where(sql`${reportRefreshes.startedAt} >= ${inicioDeLaSuite.toISOString()}::timestamptz`);

    await boss.deleteQueue(colaDePrueba).catch(() => undefined);
    await stopBoss(boss).catch(() => undefined);
    await handle.close();
  }, 30_000);

  /* ── 1. Pacientes ────────────────────────────────────────────────────────── */

  it('proyecta las altas de pacientes y guarda los acentos tal cual', async () => {
    await emitir([
      eventoPaciente(maria, `${DIA_1}T09:00:00.000Z`),
      eventoPaciente(jose, `${DIA_1}T09:05:00.000Z`),
      eventoPaciente(ana, `${DIA_1}T09:10:00.000Z`),
      eventoPaciente(luis, `${DIA_1}T09:15:00.000Z`),
    ]);

    await esperarA(async () => (await contar('dim_patient')) >= 4, 'las cuatro altas de paciente');

    const filas = await db()
      .select()
      .from(dimPatient)
      .where(inArray(dimPatient.patientId, idsPacientes));
    expect(filas).toHaveLength(4);

    const proyectada = filas.find((fila) => fila.patientId === maria.id);
    expect(proyectada).toMatchObject({
      fullName: 'María Peña',
      document: 'V-90111111',
      sex: 'F',
      status: 'activo',
      birthDate: '1990-05-10',
      isFictitious: false,
    });
    // El alta se queda con la fecha del evento y todavía no hay visitas.
    expect(proyectada?.createdAt.toISOString().slice(0, 10)).toBe(DIA_1);
    expect(proyectada?.firstVisitAt).toBeNull();
    expect(proyectada?.lastVisitAt).toBeNull();
  }, 40_000);

  /* ── 2. Embudo y tablero ─────────────────────────────────────────────────── */

  it('el embudo cuadra con las citas insertadas', async () => {
    const r1 = globalThis.crypto.randomUUID();
    const r2 = globalThis.crypto.randomUUID();
    const r3 = globalThis.crypto.randomUUID();
    const r4 = globalThis.crypto.randomUUID();
    const a1 = globalThis.crypto.randomUUID();
    const a2 = globalThis.crypto.randomUUID();
    const a3 = globalThis.crypto.randomUUID();
    const a4 = globalThis.crypto.randomUUID();
    compartidas.solicitud = r1;
    compartidas.cita = a1;

    const flujo: readonly {
      topic: EventTopic;
      status: string;
      hora: string;
      after?: Record<string, unknown>;
    }[] = [
      { topic: EVENT_TOPICS.appointmentScheduled, status: 'programada', hora: '10:00' },
      { topic: EVENT_TOPICS.appointmentNotified, status: 'notificada', hora: '11:00' },
      { topic: EVENT_TOPICS.appointmentCheckedIn, status: 'en_sala_espera', hora: '12:00' },
      { topic: EVENT_TOPICS.appointmentCalled, status: 'llamado', hora: '12:30' },
      { topic: EVENT_TOPICS.appointmentInConsultation, status: 'en_consulta', hora: '13:00' },
      {
        topic: EVENT_TOPICS.appointmentAttended,
        status: 'atendido',
        hora: '14:00',
        after: { status: 'atendido', clinicalSessionId: null, forceAttendedReason: null },
      },
    ];

    await emitir([
      eventoSolicitud({
        requestId: r1,
        ticketNumber: 101,
        patientId: maria.id,
        occurredAt: `${DIA_1}T08:00:00.000Z`,
      }),
      eventoSolicitud({
        requestId: r2,
        ticketNumber: 102,
        patientId: jose.id,
        occurredAt: `${DIA_2}T08:00:00.000Z`,
      }),
      eventoSolicitud({
        requestId: r3,
        ticketNumber: 103,
        patientId: ana.id,
        occurredAt: `${DIA_3}T08:00:00.000Z`,
      }),
      eventoSolicitud({
        requestId: r4,
        ticketNumber: 104,
        patientId: luis.id,
        occurredAt: `${DIA_3}T08:30:00.000Z`,
      }),
      ...flujo.map((paso) =>
        eventoCita({
          appointmentId: a1,
          requestId: r1,
          patientId: maria.id,
          date: DIA_1,
          startTime: '09:00',
          occurredAt: `${DIA_1}T${paso.hora}:00.000Z`,
          topic: paso.topic,
          status: paso.status,
          ...(paso.after === undefined ? {} : { after: paso.after }),
        }),
      ),
      // Cita 2: avisada y no asistió.
      eventoCita({
        appointmentId: a2,
        requestId: r2,
        patientId: jose.id,
        date: DIA_2,
        startTime: '10:00',
        occurredAt: `${DIA_2}T10:00:00.000Z`,
        topic: EVENT_TOPICS.appointmentScheduled,
        status: 'programada',
      }),
      eventoCita({
        appointmentId: a2,
        requestId: r2,
        patientId: jose.id,
        date: DIA_2,
        startTime: '10:00',
        occurredAt: `${DIA_2}T11:00:00.000Z`,
        topic: EVENT_TOPICS.appointmentNotified,
        status: 'notificada',
      }),
      eventoCita({
        appointmentId: a2,
        requestId: r2,
        patientId: jose.id,
        date: DIA_2,
        startTime: '10:00',
        occurredAt: `${DIA_2}T16:00:00.000Z`,
        topic: EVENT_TOPICS.appointmentNoShow,
        status: 'no_asistio',
        reason: 'no llegó',
      }),
      // Cita 3 (hoy): programada y avisada, sin desenlace todavía.
      eventoCita({
        appointmentId: a3,
        requestId: r3,
        patientId: ana.id,
        date: HOY,
        startTime: '08:30',
        occurredAt: `${DIA_3}T09:00:00.000Z`,
        topic: EVENT_TOPICS.appointmentScheduled,
        status: 'programada',
      }),
      eventoCita({
        appointmentId: a3,
        requestId: r3,
        patientId: ana.id,
        date: HOY,
        startTime: '08:30',
        occurredAt: `${HOY}T09:00:00.000Z`,
        topic: EVENT_TOPICS.appointmentNotified,
        status: 'notificada',
      }),
      // Cita 4: programada y cancelada.
      eventoCita({
        appointmentId: a4,
        requestId: r4,
        patientId: luis.id,
        date: DIA_3,
        startTime: '15:00',
        occurredAt: `${DIA_3}T09:30:00.000Z`,
        topic: EVENT_TOPICS.appointmentScheduled,
        status: 'programada',
      }),
      eventoCita({
        appointmentId: a4,
        requestId: r4,
        patientId: luis.id,
        date: DIA_3,
        startTime: '15:00',
        occurredAt: `${DIA_3}T12:00:00.000Z`,
        topic: EVENT_TOPICS.appointmentCancelled,
        status: 'cancelada',
        reason: 'el paciente avisó',
      }),
      // Avisos de hoy para el tablero.
      eventoAviso(true, `${HOY}T13:00:00.000Z`),
      eventoAviso(true, `${HOY}T13:05:00.000Z`),
      eventoAviso(false, `${HOY}T13:10:00.000Z`),
    ]);

    await esperarA(async () => (await contar('fact_appointment')) >= 4, 'las cuatro citas');

    const atendida = await leerCita(a1);
    expect(atendida).toMatchObject({
      status: 'atendido',
      patientId: maria.id,
      requestId: r1,
      ticketNumber: 101,
      appointmentDate: DIA_1,
      startTime: '09:00',
    });
    // Cada transición con su instante: es lo que mide la espera y la hora pico.
    for (const marca of [
      atendida?.scheduledAt,
      atendida?.notifiedAt,
      atendida?.checkedInAt,
      atendida?.calledAt,
      atendida?.startedAt,
      atendida?.finishedAt,
    ]) {
      expect(marca).not.toBeNull();
    }

    // La cita atendida deja la primera visita del paciente.
    const pacienteProyectado = (
      await db().select().from(dimPatient).where(eq(dimPatient.patientId, maria.id))
    )[0];
    expect(pacienteProyectado?.firstVisitAt).not.toBeNull();
    expect(pacienteProyectado?.lastVisitAt).not.toBeNull();

    // La cita cancelada devolvió el ticket a la cola (como hace la agenda).
    const solicitud4 = (
      await db().select().from(factRequest).where(eq(factRequest.requestId, r4))
    )[0];
    expect(solicitud4?.status).toBe('en_espera_cita');
    const citas = await Promise.all([a1, a2, a3, a4].map((id) => leerCita(id)));
    expect(citas.map((cita) => cita?.status)).toEqual([
      'atendido',
      'no_asistio',
      'notificada',
      'cancelada',
    ]);

    /**
     * El embudo con el grano del día se sirve de `mv_funnel`, y la vista se refresca
     * **al cerrar cada lote** de eventos: si la cola entrega los eventos en dos
     * tandas, la vista va una tanda por detrás. Se espera a que cuadre (con el mismo
     * tope que el resto de esperas) en vez de afirmar contra una foto a medio hacer.
     */
    const sumarEmbudo = async (): Promise<Record<string, number>> => {
      const documento = await buildFunnelReport({ db: db() }, contexto({ granularity: 'day' }));
      return documento.table.rows.reduce<Record<string, number>>((suma, fila) => {
        for (const clave of [
          'solicitudes',
          'programadas',
          'notificadas',
          'atendidas',
          'inasistencias',
          'canceladas',
        ]) {
          const valor = fila[clave];
          suma[clave] = (suma[clave] ?? 0) + (typeof valor === 'number' ? valor : 0);
        }
        return suma;
      }, {});
    };

    const embudoEsperado = {
      solicitudes: 4,
      programadas: 4,
      notificadas: 3,
      atendidas: 1,
      inasistencias: 1,
      canceladas: 1,
    };
    const totales = await esperarReporte(
      sumarEmbudo,
      (valor) =>
        Object.entries(embudoEsperado).every(([clave, esperado]) => valor[clave] === esperado),
      'el embudo cuadra con las cuatro citas',
    );

    expect(totales).toEqual(embudoEsperado);

    // El tablero del día sale de `mv_daily_kpis` (día + pacientes + avisos).
    const resumen = await buildReportSummary({ db: db() }, HOY);
    expect(resumen.appointments).toMatchObject({
      scheduled: 1,
      attended: 0,
      noShow: 0,
      pending: 1,
      cancelled: 0,
    });
    // El cupo de hoy: nadie lo fijó a mano (no hubo `scheduling.capacity.changed`),
    // así que el tablero usa las citas asignadas como suelo y deja 0 libres.
    expect(resumen.capacity).toMatchObject({ capacity: 1, assigned: 1, freeSlots: 0 });
    expect(resumen.notifications).toEqual({ sent: 2, failed: 1 });
    expect(resumen.patients.active).toBe(2);
    expect(resumen.patients.waiting).toBe(1);
    expect(resumen.refreshedAt).not.toBeNull();
  }, 60_000);

  /* ── 3. Idempotencia ─────────────────────────────────────────────────────── */

  it('un evento aplicado dos veces no duplica la fila', async () => {
    const evento = eventoPaciente(luis, `${DIA_2}T08:00:00.000Z`);

    const primera = await applyDomainEvent({ db: db() }, evento);
    const segunda = await applyDomainEvent({ db: db() }, evento);
    expect(primera.estado).toBe('aplicado');
    expect(segunda.estado).toBe('duplicado');

    expect(await contar('processed_events', eq(processedEvents.eventId, evento.eventId))).toBe(1);
    expect(await contar('dim_patient', eq(dimPatient.patientId, luis.id))).toBe(1);

    // Y por la cola: reenviar el mismo sobre (doble entrega de pg-boss) no cambia nada.
    await boss.send(colaDePrueba, evento as unknown as object);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(await contar('processed_events', eq(processedEvents.eventId, evento.eventId))).toBe(1);
    expect(await contar('dim_patient', eq(dimPatient.patientId, luis.id))).toBe(1);
  }, 40_000);

  /* ── 4. Filtros combinados ───────────────────────────────────────────────── */

  it('los filtros de edad, sexo y estado se combinan', async () => {
    const pacientes = async (filtros: Record<string, unknown>): Promise<number> => {
      const documento = await buildDemographicsReport({ db: db() }, contexto(filtros));
      // El total por tramo; el tramo «sin fecha» no existe aquí (los cuatro
      // pacientes tienen fecha de nacimiento).
      return documento.table.rows.reduce((suma, fila) => {
        const total = fila['total'];
        return suma + (typeof total === 'number' ? total : 0);
      }, 0);
    };

    // Sin filtros: los cuatro del período (las altas son de DIA_1).
    expect(await pacientes({})).toBe(4);
    // Solo el sexo: María y Ana.
    expect(await pacientes({ sex: 'F' })).toBe(2);
    // Solo el estado: los activos (María y Ana); José está en espera y Luis inactivo.
    expect(await pacientes({ status: 'activo' })).toBe(2);
    // Solo la edad: Ana (11) y Luis (8) son menores de 13; José tiene 76.
    expect(await pacientes({ ageMax: 12 })).toBe(2);
    expect(await pacientes({ ageMin: 66 })).toBe(1);
    // Combinados (Y lógico): mujer, activa y de 18 a 40 años → solo María.
    expect(await pacientes({ sex: 'F', status: 'activo', ageMin: 18, ageMax: 40 })).toBe(1);
    // La misma combinación con otro sexo no deja a nadie: los filtros no se pisan.
    expect(await pacientes({ sex: 'M', status: 'activo', ageMin: 18, ageMax: 40 })).toBe(0);
    // Edad + estado: José entra por edad pero su estado no es el pedido.
    expect(await pacientes({ ageMin: 66, status: 'en_espera_cita' })).toBe(1);
    expect(await pacientes({ ageMin: 66, status: 'activo' })).toBe(0);
  }, 40_000);

  it('un rango sin altas deja el reporte vacío y lo explica', async () => {
    const documento = await buildDemographicsReport(
      { db: db() },
      contexto({}, { from: shiftIsoDate(HOY, -60), to: shiftIsoDate(HOY, -30) }),
    );
    const total = documento.table.rows.reduce((suma, fila) => {
      const valor = fila['total'];
      return suma + (typeof valor === 'number' ? valor : 0);
    }, 0);
    expect(total).toBe(0);
    expect(documento.notes.join(' ')).toContain('Sin datos');
  }, 40_000);

  /* ── 5. Salud bucal ──────────────────────────────────────────────────────── */

  it('la salud bucal refleja los hallazgos vigentes del período', async () => {
    // La impresión del odontograma comparte tópico con «registrado» pero no es un
    // hallazgo: se ignora sin escribir nada.
    const impresion = await applyDomainEvent(
      { db: db() },
      eventoImpresionOdontograma(maria.id, `${DIA_1}T12:00:00.000Z`),
    );
    expect(impresion).toMatchObject({ estado: 'ignorado', motivo: 'impresion_del_odontograma' });

    await emitir([
      // María: caries en la 16 (oclusal), obturación en la 26 y ausencia de la 36.
      eventoHallazgo({
        patientId: maria.id,
        toothNumber: 16,
        surface: 'occlusal',
        condition: 'caries',
        occurredAt: `${DIA_1}T12:10:00.000Z`,
      }),
      eventoHallazgo({
        patientId: maria.id,
        toothNumber: 26,
        surface: 'occlusal',
        condition: 'restauracion',
        state: 'completado',
        occurredAt: `${DIA_1}T12:11:00.000Z`,
      }),
      eventoHallazgo({
        patientId: maria.id,
        toothNumber: 36,
        condition: 'ausente',
        occurredAt: `${DIA_1}T12:12:00.000Z`,
      }),
      // José: caries en la 16 (misma pieza y condición, otro paciente).
      eventoHallazgo({
        patientId: jose.id,
        toothNumber: 16,
        surface: 'occlusal',
        condition: 'caries',
        occurredAt: `${DIA_2}T12:00:00.000Z`,
      }),
      // Luis: caries en la 46 que después queda superada (no debe contar).
      eventoHallazgo({
        patientId: luis.id,
        toothNumber: 46,
        surface: 'occlusal',
        condition: 'caries',
        occurredAt: `${DIA_2}T12:05:00.000Z`,
      }),
      eventoHallazgo({
        patientId: luis.id,
        toothNumber: 46,
        surface: 'occlusal',
        condition: 'caries',
        occurredAt: `${DIA_2}T12:06:00.000Z`,
        topic: EVENT_TOPICS.toothFindingRemoved,
        action: 'tooth_finding_superseded',
        resolved: true,
      }),
      // Ana: una caries que se registra y luego se corrige (se borra la fila).
      eventoHallazgo({
        patientId: ana.id,
        toothNumber: 11,
        surface: 'vestibular',
        condition: 'caries',
        occurredAt: `${DIA_2}T12:10:00.000Z`,
      }),
      eventoHallazgo({
        patientId: ana.id,
        toothNumber: 11,
        surface: 'vestibular',
        condition: 'caries',
        occurredAt: `${DIA_2}T12:11:00.000Z`,
        topic: EVENT_TOPICS.toothFindingRemoved,
        action: 'tooth_finding_removed',
      }),
    ]);

    await esperarA(async () => (await contar('fact_tooth_finding')) >= 5, 'los hallazgos vigentes');

    // La impresión no creó fila y la corrección de Ana tampoco dejó nada.
    expect(await contar('fact_tooth_finding', eq(factToothFinding.patientId, maria.id))).toBe(3);
    expect(await contar('fact_tooth_finding', eq(factToothFinding.patientId, ana.id))).toBe(0);
    const superada = (
      await db()
        .select()
        .from(factToothFinding)
        .where(and(eq(factToothFinding.patientId, luis.id), eq(factToothFinding.toothNumber, 46)))
    )[0];
    expect(superada?.resolvedAt).not.toBeNull();

    // `tooth_finding_updated` es un upsert por clave natural: misma fila, nuevo estado.
    await emitir([
      eventoHallazgo({
        patientId: maria.id,
        toothNumber: 16,
        surface: 'occlusal',
        condition: 'caries',
        state: 'completado',
        occurredAt: `${DIA_3}T09:00:00.000Z`,
        action: 'tooth_finding_updated',
      }),
    ]);
    await esperarA(async () => {
      const filas = await db()
        .select()
        .from(factToothFinding)
        .where(and(eq(factToothFinding.patientId, maria.id), eq(factToothFinding.toothNumber, 16)));
      return filas.length === 1 && filas[0]?.state === 'completado';
    }, 'la actualización del hallazgo de la pieza 16');

    const documento = await esperarReporte(
      () => buildOralHealthReport({ db: db() }, contexto()),
      (valor) => valor.table.rows.length === 3,
      'la salud bucal con las tres piezas',
    );
    const porPieza = new Map(documento.table.rows.map((fila) => [fila['pieza'], fila]));
    expect([...porPieza.keys()]).toEqual([16, 26, 36]);
    expect(porPieza.get(16)).toMatchObject({ caries: 2, obturaciones: 0, ausentes: 0 });
    expect(porPieza.get(26)).toMatchObject({ caries: 0, obturaciones: 1, ausentes: 0 });
    expect(porPieza.get(36)).toMatchObject({ caries: 0, obturaciones: 0, ausentes: 1 });
    expect(documento.kpis.find((kpi) => kpi.label === 'Pacientes con hallazgos')?.value).toBe(2);
    expect(documento.kpis.find((kpi) => kpi.label === 'Piezas afectadas')?.value).toBe(3);
  }, 60_000);

  /* ── 6. Sesión clínica y perfil clínico ─────────────────────────────────── */

  it('proyecta la sesión clínica, la enlaza con su cita y guarda el perfil clínico', async () => {
    const recordId = globalThis.crypto.randomUUID();
    const sessionId = globalThis.crypto.randomUUID();

    const eventoHistoria = (input: {
      topic: EventTopic;
      action: string;
      recordStatus: string;
      alertCodes: string[];
      occurredAt: string;
    }): DomainEvent =>
      createDomainEvent({
        topic: input.topic,
        aggregateId: recordId,
        producer: PRODUCTOR,
        occurredAt: new Date(input.occurredAt),
        payload: {
          entityType: 'medical_record',
          entityId: recordId,
          action: input.action,
          summary: 'historia clínica',
          after: { status: input.recordStatus },
          profile: {
            patientId: maria.id,
            recordId,
            recordStatus: input.recordStatus,
            alertCodes: input.alertCodes,
          },
        },
      });

    await emitir([
      eventoHistoria({
        topic: EVENT_TOPICS.recordCreated,
        action: 'medical_record_created',
        recordStatus: 'borrador',
        alertCodes: [],
        occurredAt: `${DIA_2}T15:00:00.000Z`,
      }),
      createDomainEvent({
        topic: EVENT_TOPICS.sessionCreated,
        aggregateId: sessionId,
        producer: PRODUCTOR,
        occurredAt: new Date(`${DIA_2}T15:05:00.000Z`),
        payload: {
          entityType: 'clinical_session',
          entityId: sessionId,
          action: 'clinical_session_created',
          summary: 'sesión abierta',
          after: { patientId: maria.id, appointmentId: compartidas.cita, sessionNumber: 1 },
          session: {
            sessionId,
            patientId: maria.id,
            appointmentId: compartidas.cita,
            sessionNumber: 1,
            status: 'borrador',
            openedAt: `${DIA_2}T15:05:00.000Z`,
          },
        },
      }),
      createDomainEvent({
        topic: EVENT_TOPICS.sessionClosed,
        aggregateId: sessionId,
        producer: PRODUCTOR,
        occurredAt: new Date(`${DIA_2}T16:00:00.000Z`),
        payload: {
          entityType: 'clinical_session',
          entityId: sessionId,
          action: 'clinical_session_closed',
          summary: 'sesión cerrada',
          after: { status: 'cerrada', diagnostico: 'caries oclusal' },
          session: {
            sessionId,
            patientId: maria.id,
            appointmentId: compartidas.cita,
            sessionNumber: 1,
            status: 'cerrada',
            openedAt: `${DIA_2}T15:05:00.000Z`,
            closedAt: `${DIA_2}T16:00:00.000Z`,
            procedureCodes: ['limpieza', 'obturacion'],
            procedureCount: 2,
          },
        },
      }),
      eventoHistoria({
        topic: EVENT_TOPICS.recordSigned,
        action: 'medical_record_signed',
        recordStatus: 'firmada',
        alertCodes: ['diabetes', 'anticoagulante'],
        occurredAt: `${DIA_2}T16:10:00.000Z`,
      }),
    ]);

    await esperarA(async () => {
      const filas = await db()
        .select()
        .from(factClinicalSession)
        .where(eq(factClinicalSession.sessionId, sessionId));
      return filas.length === 1 && filas[0]?.status === 'cerrada';
    }, 'la sesión clínica cerrada');

    const sesion = (
      await db()
        .select()
        .from(factClinicalSession)
        .where(eq(factClinicalSession.sessionId, sessionId))
    )[0];
    expect(sesion).toMatchObject({
      patientId: maria.id,
      appointmentId: compartidas.cita,
      sessionNumber: 1,
      status: 'cerrada',
      diagnosisText: 'caries oclusal',
      procedureCodes: ['limpieza', 'obturacion'],
      procedureCount: 2,
    });
    expect(sesion?.closedAt).not.toBeNull();

    // La sesión queda enlazada con su cita (el reporte de ocupación la puede contar).
    await esperarA(async () => {
      const cita = await leerCita(compartidas.cita);
      return cita?.clinicalSessionId === sessionId;
    }, 'el enlace de la sesión con la cita');

    // El perfil clínico del paciente sale del bloque `profile` de la historia.
    const pacienteProyectado = (
      await db().select().from(dimPatient).where(eq(dimPatient.patientId, maria.id))
    )[0];
    expect(pacienteProyectado?.profileAlerts).toEqual(['diabetes', 'anticoagulante']);
    expect(pacienteProyectado?.recordStatus).toBe('firmada');
    expect(pacienteProyectado?.recordSignedAt).not.toBeNull();

    // Y el reporte de perfil clínico lo cuenta (María es la única con visita en el
    // período: la cita atendida le dejó la última visita en DIA_1).
    const documento = await buildClinicalProfileReport({ db: db() }, contexto());
    const porGrupo = new Map(
      documento.table.rows.map((fila) => [fila['grupo'], fila['pacientes']]),
    );
    expect(porGrupo.get('Diabetes')).toBe(1);
    expect(porGrupo.get('Anticoagulados')).toBe(1);
    expect(porGrupo.get('Hipertensión')).toBe(0);
    expect(documento.kpis.find((kpi) => kpi.label === 'Pacientes atendidos')?.value).toBe(1);
    expect(documento.kpis.find((kpi) => kpi.label === 'Historias firmadas')?.value).toBe(1);
  }, 60_000);

  /* ── 7. Recetas ──────────────────────────────────────────────────────────── */

  it('las recetas cuentan por medicamento y dejan fuera las anuladas', async () => {
    const receta1 = globalThis.crypto.randomUUID();
    const receta2 = globalThis.crypto.randomUUID();
    const receta3 = globalThis.crypto.randomUUID();

    await emitir([
      eventoRecipe({
        prescriptionId: receta1,
        patientId: maria.id,
        number: 'RX-000001',
        occurredAt: `${DIA_1}T16:00:00.000Z`,
        medications: ['Amoxicilina 500 mg', 'Ibuprofeno 400 mg'],
      }),
      eventoRecipe({
        prescriptionId: receta2,
        patientId: jose.id,
        number: 'RX-000002',
        occurredAt: `${DIA_2}T16:00:00.000Z`,
        medications: ['Amoxicilina 500 mg'],
      }),
      eventoRecipe({
        prescriptionId: receta3,
        patientId: ana.id,
        number: 'RX-000003',
        occurredAt: `${DIA_2}T17:00:00.000Z`,
        medications: ['Ibuprofeno 400 mg'],
      }),
      // La tercera se anula (solo trae `entityId`, sin bloque `prescription`).
      eventoRecipe({
        prescriptionId: receta3,
        patientId: ana.id,
        number: 'RX-000003',
        occurredAt: `${DIA_2}T18:00:00.000Z`,
        medications: [],
        topic: EVENT_TOPICS.prescriptionAnnulled,
      }),
      // Y la primera se reimprime: solo sube el contador de copias.
      eventoRecipe({
        prescriptionId: receta1,
        patientId: maria.id,
        number: 'RX-000001',
        occurredAt: `${DIA_3}T10:00:00.000Z`,
        medications: [],
        topic: EVENT_TOPICS.prescriptionReprinted,
        printCount: 2,
      }),
    ]);

    await esperarA(
      async () => (await contar('fact_prescription')) >= 3,
      'las tres recetas proyectadas',
    );

    // Dos renglones de la primera receta, uno de la segunda y uno de la tercera
    // (que se anula después: el renglón se queda, el reporte lo ignora).
    expect(
      await contar('fact_prescription_item', inArray(factPrescriptionItem.patientId, idsPacientes)),
    ).toBe(4);

    const anulada = (
      await db().select().from(factPrescription).where(eq(factPrescription.prescriptionId, receta3))
    )[0];
    expect(anulada?.status).toBe('anulada');
    expect(anulada?.annulledAt).not.toBeNull();

    const reimpresa = (
      await db().select().from(factPrescription).where(eq(factPrescription.prescriptionId, receta1))
    )[0];
    expect(reimpresa?.reprintCount).toBe(2);
    expect(reimpresa?.itemCount).toBe(2);

    const documento = await esperarReporte(
      () => buildPrescriptionsReport({ db: db() }, contexto()),
      (valor) => valor.kpis.find((kpi) => kpi.label === 'Récipes emitidos')?.value === 3,
      'las tres recetas en el reporte',
    );
    const porMedicamento = new Map(documento.table.rows.map((fila) => [fila['medicamento'], fila]));
    expect([...porMedicamento.keys()]).toEqual(['Amoxicilina 500 mg', 'Ibuprofeno 400 mg']);
    expect(porMedicamento.get('Amoxicilina 500 mg')).toMatchObject({
      recetas: 2,
      renglones: 2,
      porcentaje: 66.7,
    });
    expect(porMedicamento.get('Ibuprofeno 400 mg')).toMatchObject({ recetas: 1, renglones: 1 });
    expect(documento.kpis.find((kpi) => kpi.label === 'Récipes emitidos')?.value).toBe(3);
    expect(documento.kpis.find((kpi) => kpi.label === 'Más recetado')?.value).toBe(
      'Amoxicilina 500 mg',
    );

    // Con filtros de paciente el reporte se calcula en vivo (sin la vista agregada)
    // y sigue cuadrando: solo el récipe de María (mujer, activa, 36 años).
    const filtrado = await buildPrescriptionsReport(
      { db: db() },
      contexto({ sex: 'F', status: 'activo', ageMin: 18, ageMax: 40 }),
    );
    expect(filtrado.kpis.find((kpi) => kpi.label === 'Récipes emitidos')?.value).toBe(1);
    expect(filtrado.table.rows.map((fila) => fila['medicamento'])).toEqual([
      'Amoxicilina 500 mg',
      'Ibuprofeno 400 mg',
    ]);
    expect(filtrado.table.rows[1]).toMatchObject({ renglones: 1 });
  }, 60_000);

  /* ── 7. Exportación CSV ──────────────────────────────────────────────────── */

  it('el CSV sale con BOM, separador `;`, CRLF y acentos correctos', async () => {
    const embudo = await buildFunnelReport({ db: db() }, contexto({ granularity: 'day' }));
    const csv = reportToCsv(embudo);

    // BOM UTF-8 (sin él Excel en Windows destroza los acentos) y CRLF.
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain('\r\n');
    // Cabecera con acentos intactos y el separador que espera Excel en español.
    expect(csv.split('\r\n')[0]).toBe(
      '\uFEFFPeríodo;Solicitudes;Programadas;Avisadas;Atendidas;Inasistencias;Canceladas;Tasa de inasistencia',
    );

    // Los porcentajes salen con coma decimal: 2 de 3 renglones son de Amoxicilina.
    const csvRecetas = await esperarReporte(
      async () => reportToCsv(await buildPrescriptionsReport({ db: db() }, contexto())),
      (valor) => valor.includes(';66,7\r\n'),
      'el CSV de recetas con sus porcentajes',
    );
    expect(csvRecetas).toContain(';66,7\r\n');
    expect(csvRecetas).toContain('Amoxicilina 500 mg;');
  }, 40_000);

  /* ── 8. Orden de llegada entre servicios ─────────────────────────────────── */

  /**
   * Regresión medida en la prueba de humo (2026-10-04): los eventos de `patients`
   * y los de `clinical` los publican **dos servicios distintos**, sin orden
   * garantizado. En una corrida el alta del paciente se procesó **un segundo
   * después** de la firma de su historia, el `UPDATE` del perfil no encontró fila y
   * las alertas (diabetes, alergia) se perdieron en silencio: el reporte de perfil
   * clínico las contaba como cero.
   */
  it('el perfil clínico no se pierde si llega antes que el alta del paciente', async () => {
    const pacienteId = globalThis.crypto.randomUUID();
    const recordId = globalThis.crypto.randomUUID();
    const documento = `V-88${String(Date.now()).slice(-6)}`;

    // 1) Primero el perfil clínico, cuando la ficha todavía no existe.
    await emitir([
      createDomainEvent({
        topic: EVENT_TOPICS.recordSigned,
        aggregateId: recordId,
        producer: PRODUCTOR,
        occurredAt: new Date(`${DIA_2}T09:00:00.000Z`),
        payload: {
          entityType: 'medical_record',
          entityId: recordId,
          action: 'medical_record_signed',
          summary: 'historia firmada',
          after: { status: 'firmada' },
          profile: {
            patientId: pacienteId,
            recordId,
            recordStatus: 'firmada',
            alertCodes: ['diabetes', 'alergia_penicilina'],
          },
        },
      }),
    ]);

    await esperarA(
      async () =>
        (await contar('patient_profiles', eq(patientProfiles.patientId, pacienteId))) === 1,
      'el perfil clínico guardado de paso',
    );
    // El perfil **no** inventa una ficha: espera en su tabla.
    expect(await contar('dim_patient', eq(dimPatient.patientId, pacienteId))).toBe(0);

    // 2) Y después llega el alta.
    await emitir([
      createDomainEvent({
        topic: EVENT_TOPICS.patientCreated,
        aggregateId: pacienteId,
        producer: PRODUCTOR,
        occurredAt: new Date(`${DIA_2}T09:05:00.000Z`),
        payload: {
          patientId: pacienteId,
          document: documento,
          fullName: 'Paciente Fuera De Orden',
          action: 'created',
          changedFields: ['fullName'],
          before: null,
          after: null,
          reason: 'alta de paciente',
          patient: {
            patientId: pacienteId,
            document: documento,
            fullName: 'Paciente Fuera De Orden',
            sex: 'M',
            birthDate: '1970-01-01',
            status: 'activo',
            isFictitious: false,
          },
        },
      }),
    ]);

    await esperarA(async () => {
      const fila = (
        await db().select().from(dimPatient).where(eq(dimPatient.patientId, pacienteId))
      )[0];
      return fila?.profileAlerts.length === 2;
    }, 'el perfil aplicado al llegar el alta');

    const ficha = (
      await db().select().from(dimPatient).where(eq(dimPatient.patientId, pacienteId))
    )[0];
    expect(ficha?.profileAlerts).toEqual(['diabetes', 'alergia_penicilina']);
    expect(ficha?.recordStatus).toBe('firmada');
    expect(ficha?.recordSignedAt).not.toBeNull();

    // El reporte de perfil clínico lo cuenta igual que si hubiera llegado en orden.
    const documentoPerfil = await buildClinicalProfileReport({ db: db() }, contexto());
    const diabetes = documentoPerfil.table.rows.find((fila) => fila['grupo'] === 'Diabetes');
    expect(Number(diabetes?.['pacientes'])).toBeGreaterThanOrEqual(1);

    await db().delete(patientProfiles).where(eq(patientProfiles.patientId, pacienteId));
    await db().delete(dimPatient).where(eq(dimPatient.patientId, pacienteId));
  }, 40_000);
});
