import {
  formatTime12h,
  weekdayOf,
  type AssignAppointmentInput,
  type CreateRequestInput,
  type RequestFilters,
} from '@odontocrm/contracts';
import {
  consumerQueueName,
  createBoss,
  createOutboxRunner,
  ensureDomainEventsQueue,
  registerDomainEventHandler,
  startBoss,
  stopBoss,
} from '@odontocrm/db';
import { TEST_WAIT_MS } from '@odontocrm/testing';
import { and, eq, like, sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { handleDomainEvent } from '../../identity/dist/audit/event-consumer.js';
import { loadIdentityConfig } from '../../identity/dist/config.js';
import { createIdentityDatabase } from '../../identity/dist/db/client.js';
import * as identitySchema from '../../identity/dist/db/schema.js';
import { loadSchedulingConfig } from './config.js';
import { createSchedulingDatabase } from './db/client.js';
import { appointmentRequests, appointments } from './db/schema.js';
import {
  assignAppointment,
  cancelAppointment,
  confirmAppointment,
  getAppointment,
  getHistory,
  listAppointmentActivity,
  listAppointments,
  listPatientCancellations,
  rescheduleAppointment,
  transitionAppointment,
} from './appointments/appointment-service.js';
import { capacityFor, setCapacity, listTemplates } from './agenda/capacity-service.js';
import { getDayView } from './agenda/day-view-service.js';
import { notifyBatch, notifyPreview } from './agenda/notify-service.js';
import {
  createRequest,
  getRequestRow,
  listRequests,
  waitingQueue,
} from './requests/request-service.js';
import { todayInClinic, type ActorContext } from './shared/context.js';

/**
 * Pruebas de integración de la Fase 3 contra PostgreSQL real:
 *  - dos solicitudes simultáneas reciben tickets distintos (secuencia atómica);
 *  - el cupo bloquea y solo el admin autoriza sobrecupo; bajarlo avisa y no borra;
 *  - una franja no se puede ocupar dos veces, ni siquiera en paralelo;
 *  - reprogramar conserva el ticket y enlaza la cita nueva;
 *  - toda transición queda en `status_history` con actor y hora;
 *  - la inasistencia respeta la tolerancia;
 *  - la vista previa del lote muestra exactamente los mensajes que se enviarán;
 *  - los eventos llegan a la auditoría de identity con su resumen.
 */
const schedulingUrl = process.env['TEST_SCHEDULING_DATABASE_URL'];
const identityUrl = process.env['TEST_IDENTITY_DATABASE_URL'];
const eventsUrl = process.env['TEST_EVENTS_DATABASE_URL'];

const ready = schedulingUrl !== undefined && identityUrl !== undefined && eventsUrl !== undefined;
const describeWithDatabases = ready ? describe : describe.skip;

const suffix = String(Date.now()).slice(-6);
const MARKER = `prueba-fase3-${suffix}`;
const MARK = `PRUEBA-F3-${suffix}`;

/** Cola propia de esta suite: se borra al terminar (ver el comentario al usarla). */
const colaDePrueba = consumerQueueName('prueba-agenda');

/** Un día de consulta lejos de los datos de la demo (lunes a viernes). */
const workingDayFrom = (offsetDays: number): string => {
  const start = new Date(Date.now() + offsetDays * 86_400_000);
  for (let extra = 0; extra < 7; extra += 1) {
    const date = new Date(start.getTime() + extra * 86_400_000).toISOString().slice(0, 10);
    const weekday = weekdayOf(date);
    if (weekday >= 1 && weekday <= 5) return date;
  }
  throw new Error('no encontré día de consulta');
};

const day = workingDayFrom(40);
const otherDay = workingDayFrom(47);
/** Día propio para las novedades (ADR 0057): no comparte franjas con las demás pruebas. */
const activityDay = workingDayFrom(54);

const admin: ActorContext = {
  actorId: null,
  actorUsername: MARKER,
  roles: ['admin'],
  ip: '127.0.0.1',
  userAgent: 'vitest',
  requestId: `req-${suffix}`,
};

const secretary: ActorContext = { ...admin, roles: ['secretario'] };
const dentist: ActorContext = { ...admin, roles: ['odontologo'] };

const aRequest = (overrides: Partial<CreateRequestInput> = {}): CreateRequestInput => ({
  patientId: globalThis.crypto.randomUUID(),
  patientName: `Paciente ${MARK}`,
  patientDocument: 'V-12345678',
  patientPhone: '+584121234567',
  channel: 'telefono',
  reason: 'Dolor en la muela del juicio',
  priority: 0,
  notes: MARK,
  ...overrides,
});

const anAssignment = (
  requestId: string,
  overrides: Partial<AssignAppointmentInput> = {},
): AssignAppointmentInput => ({
  requestId,
  date: day,
  startTime: '08:00',
  slotKind: 'franja',
  authorizeOverbook: false,
  // La marca también viaja a la cita: sin ella, la limpieza no la encontraría.
  notes: MARK,
  ...overrides,
});

describeWithDatabases('agenda con PostgreSQL real', () => {
  let schedulingHandle: Awaited<ReturnType<typeof createSchedulingDatabase>>;
  let identityHandle: Awaited<ReturnType<typeof createIdentityDatabase>>;
  let boss: PgBoss;
  let config: ReturnType<typeof loadSchedulingConfig>;

  /**
   * Vacía el outbox **por completo**: un ciclo publica un lote, así que con varios
   * eventos pendientes hay que repetir hasta que no quede ninguno.
   */
  const flush = async (): Promise<void> => {
    const runner = createOutboxRunner({
      pool: schedulingHandle.pool,
      boss,
      consumerQueue: colaDePrueba,
    });
    for (let round = 0; round < 10; round += 1) {
      const result = await runner.flush();
      if (result.claimed === 0) return;
    }
  };

  beforeAll(async () => {
    if (!ready) throw new Error('faltan las variables TEST_* de bases de datos');

    config = loadSchedulingConfig({
      DATABASE_URL: schedulingUrl,
      EVENTS_DATABASE_URL: eventsUrl,
      LOG_LEVEL: 'silent',
    });
    schedulingHandle = createSchedulingDatabase(config);
    identityHandle = createIdentityDatabase(
      loadIdentityConfig({
        DATABASE_URL: identityUrl,
        EVENTS_DATABASE_URL: eventsUrl,
        LOG_LEVEL: 'silent',
      }),
    );

    boss = createBoss({ connectionString: eventsUrl, applicationName: 'odontocrm-test-fase3' });
    await startBoss(boss);
    await ensureDomainEventsQueue(boss);
    // El mismo trabajador que corre en identity: convierte los eventos en auditoría.
    await registerDomainEventHandler(
      boss,
      async (events) => {
        for (const event of events) await handleDomainEvent(identityHandle.db, event);
      },
      // Cola propia de la prueba: los servicios reales tienen la suya, así que
      // todos reciben los eventos (reparto por consumidor) sin pisarse. Cada suite
      // usa un nombre distinto y la borra al terminar: mientras exista, el
      // publicador de los servicios reales le manda copias que nadie recoge.
      { queue: colaDePrueba },
    );
  }, 30_000);

  afterAll(async () => {
    if (!ready) return;

    // Lo último que hace la suite es volver a subir el cupo, y eso deja su evento en el outbox. Sin
    // este vaciado, **cada corrida** dejaba un evento sin publicar y el auditor de conexiones
    // denunciaba un «outbox atascado en scheduling» que no era del sistema, sino de la prueba.
    await flush().catch(() => undefined);

    await identityHandle.db
      .delete(identitySchema.auditEvents)
      .where(eq(identitySchema.auditEvents.actorUsername, MARKER));
    await identityHandle.db.delete(identitySchema.processedEvents);
    // Por marca y por las dos fechas de la prueba: si una corrida anterior murió a
    // medias, sus citas no pueden quedar ocupando franjas.
    await schedulingHandle.db
      .delete(appointments)
      .where(
        sql`${appointments.notes} like ${'%' + MARK + '%'} or ${appointments.appointmentDate} in (${day}, ${otherDay})`,
      );
    await schedulingHandle.db
      .delete(appointmentRequests)
      .where(like(appointmentRequests.notes, `%${MARK}%`));
    await schedulingHandle.db.execute(
      sql`delete from day_capacities where date in (${day}, ${otherDay})`,
    );
    await boss.deleteQueue(colaDePrueba).catch(() => undefined);
    await stopBoss(boss).catch(() => undefined);
    await schedulingHandle.close();
    await identityHandle.close();
  });

  it('dos solicitudes simultáneas obtienen tickets distintos', async () => {
    const created = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        createRequest(
          schedulingHandle.db,
          aRequest({ reason: `${MARK} motivo ${String(index)}` }),
          admin,
        ),
      ),
    );

    const tickets = created.map((request) => request.ticketNumber);
    expect(new Set(tickets).size).toBe(20);
    // La secuencia es monótona: el mayor ticket es al menos 20 más que el menor.
    const sorted = [...tickets].sort((left, right) => left - right);
    expect((sorted.at(-1) ?? 0) - (sorted[0] ?? 0)).toBeGreaterThanOrEqual(19);
    for (const request of created) {
      expect(request.ticket).toMatch(/^#\d{6}$/);
      expect(request.status).toBe('en_espera_cita');
    }
  }, 40_000);

  it('la cola ordena por ticket y por antigüedad', async () => {
    const queue = await waitingQueue(schedulingHandle.db);
    expect(queue.length).toBeGreaterThanOrEqual(20);
    // La cola real también trae los datos sembrados (con su propia prioridad), así
    // que el orden se comprueba dentro de las solicitudes de esta prueba.
    const mine = queue.filter((request) => request.patientName.includes(MARK));
    expect(mine.length).toBeGreaterThanOrEqual(20);
    const tickets = mine.map((request) => request.ticketNumber);
    expect([...tickets].sort((left, right) => left - right)).toEqual(tickets);

    const byAntiquity = await listRequests(schedulingHandle.db, {
      order: 'antiguedad',
      page: 1,
      pageSize: 5,
      search: MARK,
    } as RequestFilters);
    expect(byAntiquity.total).toBeGreaterThanOrEqual(20);
    const dates = byAntiquity.items.map((request) => request.requestedAt);
    expect([...dates].sort()).toEqual(dates);
  }, 30_000);

  it('el cupo bloquea la asignación y solo el admin autoriza el sobrecupo', async () => {
    const capacity = await setCapacity(
      schedulingHandle.db,
      { date: day, capacity: 2, notes: `${MARK} cupo de prueba` },
      admin,
      config,
    );
    expect(capacity.capacity).toBe(2);
    expect(capacity.source).toBe('explicito');

    const requests = await Promise.all([
      createRequest(schedulingHandle.db, aRequest({ notes: MARK }), admin),
      createRequest(schedulingHandle.db, aRequest({ notes: MARK }), admin),
      createRequest(schedulingHandle.db, aRequest({ notes: MARK }), admin),
    ]);
    const [first, second, third] = requests;
    if (first === undefined || second === undefined || third === undefined) {
      throw new Error('faltan solicitudes');
    }

    await assignAppointment(schedulingHandle.db, anAssignment(first.id), secretary, { config });
    await assignAppointment(
      schedulingHandle.db,
      anAssignment(second.id, { startTime: '08:30' }),
      secretary,
      { config },
    );

    // Tercera: el día está completo.
    await expect(
      assignAppointment(
        schedulingHandle.db,
        anAssignment(third.id, { startTime: '09:00' }),
        secretary,
        { config },
      ),
    ).rejects.toMatchObject({
      status: 409,
      extensions: { requiresOverbook: true, capacity: 2, assigned: 2 },
    });

    // El sobrecupo sin motivo no pasa la validación del contrato, y con motivo
    // exige el permiso `scheduling:overbook` (que la secretaria no tiene).
    await expect(
      assignAppointment(
        schedulingHandle.db,
        anAssignment(third.id, {
          startTime: '09:00',
          authorizeOverbook: true,
          overbookReason: 'paciente con dolor agudo',
        }),
        secretary,
        { config },
      ),
    ).rejects.toMatchObject({ status: 409, extensions: { forbidden: true } });

    // El admin sí puede, y queda con su motivo.
    const overbooked = await assignAppointment(
      schedulingHandle.db,
      anAssignment(third.id, {
        startTime: '09:00',
        authorizeOverbook: true,
        overbookReason: 'paciente con dolor agudo',
      }),
      admin,
      { config },
    );
    expect(overbooked.status).toBe('programada');
    expect(overbooked.startTime).toBe('09:00');

    // Bajar el cupo por debajo de lo asignado: avisa y no borra ninguna cita.
    const lowered = await setCapacity(
      schedulingHandle.db,
      { date: day, capacity: 1, notes: `${MARK} cupo bajado` },
      admin,
      config,
    );
    expect(lowered.warning).toContain('no se ha borrado ninguna');
    expect(lowered.assigned).toBe(3);
    const stillThere = await listAppointments(schedulingHandle.db, {
      date: day,
      page: 1,
      pageSize: 50,
    });
    expect(stillThere.total).toBe(3);
  }, 60_000);

  it('una franja no se puede ocupar dos veces, ni siquiera en paralelo', async () => {
    const requests = await Promise.all([
      createRequest(schedulingHandle.db, aRequest({ notes: MARK }), admin),
      createRequest(schedulingHandle.db, aRequest({ notes: MARK }), admin),
    ]);
    const [left, right] = requests;
    if (left === undefined || right === undefined) throw new Error('faltan solicitudes');

    const results = await Promise.allSettled([
      assignAppointment(
        schedulingHandle.db,
        anAssignment(left.id, { date: otherDay, startTime: '10:00' }),
        admin,
        { config },
      ),
      assignAppointment(
        schedulingHandle.db,
        anAssignment(right.id, { date: otherDay, startTime: '10:00' }),
        admin,
        { config },
      ),
    ]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ status: 409 });
  }, 60_000);

  it('reprogramar conserva el ticket y enlaza la cita nueva', async () => {
    // El cupo de este día lo fija esta prueba: así no depende del orden de otras.
    await setCapacity(
      schedulingHandle.db,
      { date: day, capacity: 16, notes: `${MARK} cupo para reprogramar` },
      admin,
      config,
    );
    const request = await createRequest(schedulingHandle.db, aRequest({ notes: MARK }), admin);
    const original = await assignAppointment(
      schedulingHandle.db,
      anAssignment(request.id, { startTime: '11:00' }),
      admin,
      { config },
    );

    const moved = await rescheduleAppointment(
      schedulingHandle.db,
      original.id,
      {
        date: day,
        startTime: '11:30',
        slotKind: 'franja',
        reason: 'el paciente pidió cambiarla',
        authorizeOverbook: false,
      },
      admin,
      { config },
    );

    expect(moved.id).not.toBe(original.id);
    expect(moved.rescheduledFromId).toBe(original.id);
    expect(moved.ticket).toBe(original.ticket);
    expect(moved.icsSequence).toBe(original.icsSequence + 1);
    expect(moved.status).toBe('programada');

    const previous = await getAppointment(schedulingHandle.db, original.id);
    expect(previous.status).toBe('reprogramada');
    expect(previous.rescheduledToId).toBe(moved.id);

    // El historial cuenta la historia completa, con actor y hora.
    const previousHistory = await getHistory(schedulingHandle.db, 'appointment', original.id);
    expect(previousHistory.map((entry) => entry.toStatus)).toEqual(['programada', 'reprogramada']);
    expect(previousHistory.every((entry) => entry.actorUsername === MARKER)).toBe(true);
    expect(previousHistory.every((entry) => entry.occurredAt.length > 0)).toBe(true);

    const newHistory = await getHistory(schedulingHandle.db, 'appointment', moved.id);
    expect(newHistory.map((entry) => entry.toStatus)).toEqual(['programada']);
  }, 60_000);

  it('la inasistencia respeta la tolerancia y las transiciones válidas', async () => {
    const request = await createRequest(schedulingHandle.db, aRequest({ notes: MARK }), admin);
    const appointment = await assignAppointment(
      schedulingHandle.db,
      anAssignment(request.id, { date: otherDay, startTime: '08:00' }),
      admin,
      { config },
    );

    // «atendido» directo desde programada no está en la máquina de estados.
    await expect(
      transitionAppointment(schedulingHandle.db, appointment.id, 'atendido', admin, {
        config,
        forceReason: 'prueba',
      }),
    ).rejects.toMatchObject({ status: 409, extensions: { from: 'programada', to: 'atendido' } });

    // El odontólogo no notifica (eso es de secretaría): 409 con lo que sí puede.
    await expect(
      transitionAppointment(schedulingHandle.db, appointment.id, 'notificada', dentist, {
        config,
      }),
    ).rejects.toMatchObject({ status: 409 });

    // Inasistencia antes de la hora + tolerancia: no se puede.
    await expect(
      transitionAppointment(schedulingHandle.db, appointment.id, 'no_asistio', secretary, {
        config,
      }),
    ).rejects.toMatchObject({ status: 400, code: 'no_show_too_early' });

    // Con la hora ya pasada (se simula el momento) sí se puede.
    const later = new Date(`${otherDay}T14:00:00-04:00`);
    const noShow = await transitionAppointment(
      schedulingHandle.db,
      appointment.id,
      'no_asistio',
      secretary,
      { config, reason: 'no llegó', now: later },
    );
    expect(noShow.status).toBe('no_asistio');
    expect(noShow.noShowReason).toBe('no llegó');

    // «Atendido» exige el motivo mientras no exista historia clínica (Fase 6), y
    // la máquina de estados obliga a pasar antes por sala, llamado y consulta.
    const request2 = await createRequest(schedulingHandle.db, aRequest({ notes: MARK }), admin);
    const appointment2 = await assignAppointment(
      schedulingHandle.db,
      anAssignment(request2.id, { date: otherDay, startTime: '08:30' }),
      admin,
      { config },
    );
    await transitionAppointment(schedulingHandle.db, appointment2.id, 'en_sala_espera', secretary, {
      config,
    });
    await transitionAppointment(schedulingHandle.db, appointment2.id, 'llamado', secretary, {
      config,
    });
    await transitionAppointment(schedulingHandle.db, appointment2.id, 'en_consulta', secretary, {
      config,
    });
    await expect(
      transitionAppointment(schedulingHandle.db, appointment2.id, 'atendido', admin, { config }),
    ).rejects.toMatchObject({ status: 400, code: 'clinical_session_required' });

    const attended = await transitionAppointment(
      schedulingHandle.db,
      appointment2.id,
      'atendido',
      secretary,
      { config, forceReason: 'primera visita sin historia clínica todavía' },
    );
    expect(attended.status).toBe('atendido');
    expect(attended.callCount).toBe(1);

    const history = await getHistory(schedulingHandle.db, 'appointment', appointment2.id);
    expect(history.map((entry) => entry.toStatus)).toEqual([
      'programada',
      'en_sala_espera',
      'llamado',
      'en_consulta',
      'atendido',
    ]);
  }, 60_000);

  it('el odontólogo solo lleva el flujo del día completo (Fase 8)', async () => {
    const request = await createRequest(schedulingHandle.db, aRequest({ notes: MARK }), admin);
    const appointment = await assignAppointment(
      schedulingHandle.db,
      anAssignment(request.id, { date: otherDay, startTime: '15:30' }),
      admin,
      { config },
    );

    // Las cinco acciones de la barra de `/flujo`, ejecutadas por el odontólogo.
    const enSala = await transitionAppointment(
      schedulingHandle.db,
      appointment.id,
      'en_sala_espera',
      dentist,
      { config },
    );
    expect(enSala.status).toBe('en_sala_espera');

    const llamado = await transitionAppointment(
      schedulingHandle.db,
      appointment.id,
      'llamado',
      dentist,
      { config },
    );
    expect(llamado.status).toBe('llamado');

    const enConsulta = await transitionAppointment(
      schedulingHandle.db,
      appointment.id,
      'en_consulta',
      dentist,
      { config },
    );
    expect(enConsulta.status).toBe('en_consulta');

    const atendida = await transitionAppointment(
      schedulingHandle.db,
      appointment.id,
      'atendido',
      dentist,
      { config, forceReason: 'visita atendida por la odontóloga' },
    );
    expect(atendida.status).toBe('atendido');

    // Y la inasistencia, que era la única de las cinco reservada a secretaría.
    const request2 = await createRequest(schedulingHandle.db, aRequest({ notes: MARK }), admin);
    const appointment2 = await assignAppointment(
      schedulingHandle.db,
      anAssignment(request2.id, { date: otherDay, startTime: '16:00' }),
      admin,
      { config },
    );
    const later = new Date(`${otherDay}T18:00:00-04:00`);
    const inasistencia = await transitionAppointment(
      schedulingHandle.db,
      appointment2.id,
      'no_asistio',
      dentist,
      { config, reason: 'no llegó y ya pasó la tolerancia', now: later },
    );
    expect(inasistencia.status).toBe('no_asistio');

    // Lo que sigue siendo de la secretaría: notificar, cancelar y reprogramar.
    const request3 = await createRequest(schedulingHandle.db, aRequest({ notes: MARK }), admin);
    const appointment3 = await assignAppointment(
      schedulingHandle.db,
      anAssignment(request3.id, { date: otherDay, startTime: '16:30' }),
      admin,
      { config },
    );
    await expect(
      transitionAppointment(schedulingHandle.db, appointment3.id, 'notificada', dentist, {
        config,
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      transitionAppointment(schedulingHandle.db, appointment3.id, 'cancelada', dentist, {
        config,
        reason: 'la paciente avisó',
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      rescheduleAppointment(
        schedulingHandle.db,
        appointment3.id,
        {
          date: otherDay,
          startTime: '14:00',
          slotKind: 'franja',
          reason: 'la paciente pidió otra hora',
          authorizeOverbook: false,
        },
        dentist,
        { config },
      ),
    ).rejects.toMatchObject({ status: 409 });
  }, 60_000);

  it('«atendido» solo acepta una sesión clínica cerrada y del mismo paciente', async () => {
    const request = await createRequest(schedulingHandle.db, aRequest({ notes: MARK }), admin);
    const appointment = await assignAppointment(
      schedulingHandle.db,
      anAssignment(request.id, { date: otherDay, startTime: '10:30' }),
      admin,
      { config },
    );
    for (const to of ['en_sala_espera', 'llamado', 'en_consulta'] as const) {
      await transitionAppointment(schedulingHandle.db, appointment.id, to, secretary, { config });
    }

    const sessionId = globalThis.crypto.randomUUID();
    const cerrada = {
      sessionId,
      patientId: appointment.patientId,
      appointmentId: appointment.id,
      status: 'cerrada' as const,
      closedAt: new Date().toISOString(),
    };
    const attend = (options: Partial<Parameters<typeof transitionAppointment>[4]>) =>
      transitionAppointment(schedulingHandle.db, appointment.id, 'atendido', secretary, {
        config,
        clinicalSessionId: sessionId,
        ...options,
      });

    // Una sesión de otro paciente no respalda esta cita.
    await expect(
      attend({
        sessionLookup: async () => ({ ...cerrada, patientId: globalThis.crypto.randomUUID() }),
      }),
    ).rejects.toMatchObject({ status: 409, code: 'clinical_session_patient_mismatch' });

    // Una sesión todavía en borrador tampoco: primero se cierra.
    await expect(
      attend({ sessionLookup: async () => ({ ...cerrada, status: 'borrador' }) }),
    ).rejects.toMatchObject({ status: 409, code: 'clinical_session_open' });

    // Y un identificador que el servicio clínico no reconoce no vale como llave.
    await expect(attend({ sessionLookup: async () => null })).rejects.toMatchObject({
      status: 409,
      code: 'clinical_session_unverified',
    });

    // Con la sesión cerrada del paciente, el «atendido» no pide motivo y la deja trazada.
    const attended = await attend({
      sessionLookup: async (id) => (id === sessionId ? cerrada : null),
    });
    expect(attended.status).toBe('atendido');
    expect(attended.clinicalSessionId).toBe(sessionId);
    expect(attended.forceAttendedReason).toBeNull();
  }, 60_000);

  it('cancelar una cita devuelve el ticket a la cola', async () => {
    const request = await createRequest(schedulingHandle.db, aRequest({ notes: MARK }), admin);
    const appointment = await assignAppointment(
      schedulingHandle.db,
      anAssignment(request.id, { date: otherDay, startTime: '09:30' }),
      admin,
      { config },
    );

    const cancelled = await transitionAppointment(
      schedulingHandle.db,
      appointment.id,
      'cancelada',
      secretary,
      { config, reason: 'el paciente no puede ese día' },
    );
    expect(cancelled.status).toBe('cancelada');

    const after = await getRequestRow(schedulingHandle.db, request.id);
    expect(after.status).toBe('en_espera_cita');
  }, 60_000);

  it('la vista del día arma franjas, citas, cola y contadores', async () => {
    await setCapacity(
      schedulingHandle.db,
      { date: day, capacity: 16, notes: `${MARK} cupo de la vista` },
      admin,
      config,
    );
    const view = await getDayView(schedulingHandle.db, day, config);

    expect(view.date).toBe(day);
    expect(view.isWorkingDay).toBe(true);
    expect(view.weekdayName).not.toBe('');
    // La jornada por defecto son 8 franjas por turno (8:00–12:00 y 13:00–17:00).
    expect(view.slots.filter((slot) => slot.state !== 'fuera_de_jornada')).toHaveLength(16);
    expect(view.capacity.capacity).toBe(16);
    expect(view.waiting.length).toBeGreaterThan(0);
    expect(
      view.counts.programadas + view.counts.notificadas + view.counts.canceladas,
    ).toBeGreaterThan(0);

    const occupied = view.slots.filter((slot) => slot.state === 'ocupada');
    expect(occupied.length).toBeGreaterThanOrEqual(3);
    expect(occupied[0]?.appointment?.patientName).toContain(MARK);

    // Una cita con hora manual fuera de la plantilla aparece como hueco propio.
    const request = await createRequest(schedulingHandle.db, aRequest({ notes: MARK }), admin);
    await assignAppointment(
      schedulingHandle.db,
      anAssignment(request.id, { startTime: '12:15', slotKind: 'manual', durationMinutes: 20 }),
      admin,
      { config },
    );
    const withManual = await getDayView(schedulingHandle.db, day, config);
    const manual = withManual.slots.find((slot) => slot.kind === 'manual');
    expect(manual?.startTime).toBe('12:15');
    expect(manual?.state).toBe('ocupada');
  }, 60_000);

  it('la vista previa muestra exactamente los mensajes del lote', async () => {
    const preview = await notifyPreview(schedulingHandle.db, { date: day }, config, {
      force: false,
    });
    expect(preview.date).toBe(day);
    expect(preview.items.length).toBeGreaterThan(0);
    expect(preview.willSendCount).toBeGreaterThan(0);

    const pending = preview.items.filter((item) => item.willSend);
    for (const item of pending) {
      expect(item.body).toContain(item.patientName);
      expect(item.body).toContain('#');
      expect(item.body).toContain(config.CLINIC_ADDRESS);
      expect(item.body).toContain(formatTime12h(item.startTime));
      expect(item.skipReason).toBeNull();
    }
    const skipped = preview.items.filter((item) => !item.willSend);
    for (const item of skipped) expect(item.skipReason).not.toBeNull();

    const result = await notifyBatch(
      schedulingHandle.db,
      { date: day, force: false },
      secretary,
      config,
    );
    expect(result.notified).toBe(pending.length);
    expect(result.appointments.every((appointment) => appointment.status === 'notificada')).toBe(
      true,
    );

    // Un segundo intento no repite los avisos.
    const again = await notifyPreview(schedulingHandle.db, { date: day }, config, { force: false });
    expect(again.willSendCount).toBe(0);
    expect(again.items.every((item) => !item.willSend)).toBe(true);
  }, 60_000);

  it('el paciente confirma su cita y la franja sigue ocupada (ADR 0052)', async () => {
    // Horas al final del día: fuera de la plantilla del consultorio y lejos de los
    // datos de la demo, que es lo que hace que la prueba no dependa de lo sembrado.
    const request = await createRequest(schedulingHandle.db, aRequest({ notes: MARK }), admin);
    const cita = await assignAppointment(
      schedulingHandle.db,
      anAssignment(request.id, { date: otherDay, startTime: '20:00', slotKind: 'manual' }),
      admin,
      { config },
    );

    // Desde `programada`: es el caso «la llamé yo», la secretaría lo deja apuntado
    // sin que haya salido ningún aviso.
    const confirmada = await confirmAppointment(
      schedulingHandle.db,
      cita.id,
      { channel: 'telefono', note: 'dijo que sí a las 10' },
      secretary,
    );
    expect(confirmada.status).toBe('confirmada');
    expect(confirmada.confirmedAt).not.toBeNull();
    expect(confirmada.confirmedChannel).toBe('telefono');

    // Idempotente, y da igual quién lo repita: el botón reenviado y el paciente que
    // pulsa dos veces no mueven la confirmación ni ensucian el historial.
    const bot = { ...admin, roles: [] as const };
    const otraVez = await confirmAppointment(
      schedulingHandle.db,
      cita.id,
      { channel: 'telegram' },
      bot,
    );
    expect(otraVez.confirmedAt).toBe(confirmada.confirmedAt);
    expect(otraVez.confirmedChannel).toBe('telefono');

    const historial = await getHistory(schedulingHandle.db, 'appointment', cita.id);
    const confirmaciones = historial.filter((entrada) => entrada.toStatus === 'confirmada');
    expect(confirmaciones).toHaveLength(1);
    expect(confirmaciones[0]?.reason).toContain('teléfono');
    expect(confirmaciones[0]?.actorUsername).toBe(MARKER);

    // La franja **sigue bloqueada**: confirmar no libera el hueco (si lo hiciera,
    // se podría citar a dos pacientes a la misma hora).
    const otra = await createRequest(schedulingHandle.db, aRequest({ notes: MARK }), admin);
    await expect(
      assignAppointment(
        schedulingHandle.db,
        anAssignment(otra.id, { date: otherDay, startTime: '20:00', slotKind: 'manual' }),
        admin,
        { config },
      ),
    ).rejects.toThrow();

    // Y desde `notificada` también se confirma: es el botón del aviso.
    const conAviso = await createRequest(schedulingHandle.db, aRequest({ notes: MARK }), admin);
    const avisada = await assignAppointment(
      schedulingHandle.db,
      anAssignment(conAviso.id, { date: otherDay, startTime: '20:30', slotKind: 'manual' }),
      admin,
      { config },
    );
    await transitionAppointment(schedulingHandle.db, avisada.id, 'notificada', secretary, {
      config,
    });
    const porElBot = await confirmAppointment(
      schedulingHandle.db,
      avisada.id,
      { channel: 'whatsapp' },
      bot,
    );
    expect(porElBot.status).toBe('confirmada');
    expect(porElBot.confirmedChannel).toBe('whatsapp');

    // En un estado terminal no se confirma: la cita ya ocurrió (o se cayó).
    const atendida = await assignAppointment(
      schedulingHandle.db,
      anAssignment(
        (await createRequest(schedulingHandle.db, aRequest({ notes: MARK }), admin)).id,
        { date: otherDay, startTime: '21:00', slotKind: 'manual' },
      ),
      admin,
      { config },
    );
    await transitionAppointment(schedulingHandle.db, atendida.id, 'cancelada', secretary, {
      config,
    });
    await expect(
      confirmAppointment(schedulingHandle.db, atendida.id, { channel: 'telegram' }, bot),
    ).rejects.toThrow(/No se puede confirmar/);
  }, 60_000);

  it('el paciente cancela su cita y el ticket vuelve a la cola (ADR 0053)', async () => {
    const request = await createRequest(schedulingHandle.db, aRequest({ notes: MARK }), admin);
    const cita = await assignAppointment(
      schedulingHandle.db,
      anAssignment(request.id, { date: otherDay, startTime: '22:00', slotKind: 'manual' }),
      admin,
      { config },
    );

    // El bot cancela con un actor **sin roles** y por su canal (ADR 0053).
    const bot = { ...admin, roles: [] as const };
    const cancelada = await cancelAppointment(
      schedulingHandle.db,
      cita.id,
      { channel: 'telegram', config },
      bot,
    );
    expect(cancelada.status).toBe('cancelada');
    expect(cancelada.cancelledAt).not.toBeNull();
    expect(cancelada.cancelledChannel).toBe('telegram');

    // Idempotente: repetir no mueve la fecha ni escribe otro historial.
    const otraVez = await cancelAppointment(
      schedulingHandle.db,
      cita.id,
      { channel: 'telegram', config },
      bot,
    );
    expect(otraVez.cancelledAt).toBe(cancelada.cancelledAt);
    const historial = await getHistory(schedulingHandle.db, 'appointment', cita.id);
    expect(historial.filter((entrada) => entrada.toStatus === 'cancelada')).toHaveLength(1);
    expect(historial.find((entrada) => entrada.toStatus === 'cancelada')?.reason).toContain(
      'Telegram',
    );

    // El ticket vuelve a la cola: la solicitud queda «en espera de cita».
    expect((await getRequestRow(schedulingHandle.db, request.id)).status).toBe('en_espera_cita');

    // La tarjeta ve las cancelaciones **del paciente** por su canal.
    const hoy = todayInClinic();
    const delPaciente = await listPatientCancellations(schedulingHandle.db, {
      from: hoy,
      to: hoy,
      page: 1,
      pageSize: 50,
    });
    expect(delPaciente.items.some((item) => item.id === cita.id)).toBe(true);

    // Una cita ya en sala no se cancela por aquí (guardia de estado).
    const enSala = await assignAppointment(
      schedulingHandle.db,
      anAssignment(
        (await createRequest(schedulingHandle.db, aRequest({ notes: MARK }), admin)).id,
        { date: otherDay, startTime: '22:30', slotKind: 'manual' },
      ),
      admin,
      { config },
    );
    await transitionAppointment(schedulingHandle.db, enSala.id, 'en_sala_espera', secretary, {
      config,
    });
    await expect(
      cancelAppointment(schedulingHandle.db, enSala.id, { channel: 'telegram', config }, bot),
    ).rejects.toThrow(/ya no puede cancelar/);

    // Y la secretaría cancela **sin canal**: no entra en la tarjeta del paciente.
    const porSecretaria = await assignAppointment(
      schedulingHandle.db,
      anAssignment(
        (await createRequest(schedulingHandle.db, aRequest({ notes: MARK }), admin)).id,
        { date: otherDay, startTime: '23:00', slotKind: 'manual' },
      ),
      admin,
      { config },
    );
    await transitionAppointment(schedulingHandle.db, porSecretaria.id, 'cancelada', secretary, {
      config,
      reason: 'la anuló la secretaría',
    });
    const soloPaciente = await listPatientCancellations(schedulingHandle.db, {
      from: hoy,
      to: hoy,
      page: 1,
      pageSize: 50,
    });
    expect(soloPaciente.items.some((item) => item.id === porSecretaria.id)).toBe(false);
    expect(soloPaciente.items.some((item) => item.id === enSala.id)).toBe(false);
  }, 60_000);

  it('las novedades de citas cuentan lo que hizo el paciente por el bot (ADR 0057)', async () => {
    const bot = { ...admin, roles: [] as const };

    const crear = async (startTime: string) =>
      assignAppointment(
        schedulingHandle.db,
        anAssignment(
          (await createRequest(schedulingHandle.db, aRequest({ notes: MARK }), admin)).id,
          { date: activityDay, startTime, slotKind: 'manual' },
        ),
        admin,
        { config },
      );

    // 1) Le dieron cita y **confirmó** por el bot.
    const confirmada = await crear('09:00');
    await confirmAppointment(schedulingHandle.db, confirmada.id, { channel: 'telegram' }, bot);

    // 2) Le dieron cita y **canceló** sin haber confirmado.
    const cancelada = await crear('10:00');
    await cancelAppointment(
      schedulingHandle.db,
      cancelada.id,
      { channel: 'whatsapp', config },
      bot,
    );

    // 3) Confirmó primero y **luego se arrepintió**: el caso propio de la ADR 0057.
    const arrepentida = await crear('11:00');
    await confirmAppointment(schedulingHandle.db, arrepentida.id, { channel: 'telegram' }, bot);
    await cancelAppointment(
      schedulingHandle.db,
      arrepentida.id,
      { channel: 'telegram', config },
      bot,
    );

    // 4) Confirmó por **teléfono**: lo apuntó la secretaría, no es novedad del bot.
    const porTelefono = await crear('12:00');
    await confirmAppointment(
      schedulingHandle.db,
      porTelefono.id,
      { channel: 'telefono' },
      secretary,
    );

    // 5) La canceló la secretaría: tampoco.
    const porSecretaria = await crear('13:00');
    await transitionAppointment(schedulingHandle.db, porSecretaria.id, 'cancelada', secretary, {
      config,
      reason: 'la anuló la secretaría',
    });

    const items = await listAppointmentActivity(schedulingHandle.db, { limit: 50 });
    const kind = (id: string): string | undefined =>
      items.find((item) => item.appointmentId === id)?.kind;

    expect(kind(confirmada.id)).toBe('confirmada');
    expect(kind(cancelada.id)).toBe('cancelada');
    expect(kind(arrepentida.id)).toBe('confirmada_y_cancelada');
    expect(kind(porTelefono.id)).toBeUndefined();
    expect(kind(porSecretaria.id)).toBeUndefined();

    // El canal viaja en la novedad: por dónde actuó el paciente.
    expect(items.find((item) => item.appointmentId === cancelada.id)?.channel).toBe('whatsapp');

    // Orden: de la más reciente a la más vieja.
    const instantes = items.map((item) => Date.parse(item.occurredAt));
    expect([...instantes].sort((a, b) => b - a)).toEqual(instantes);
  }, 60_000);

  it('las plantillas por defecto son la jornada del consultorio', async () => {
    const templates = await listTemplates(schedulingHandle.db);
    expect(templates.length).toBeGreaterThanOrEqual(10);
    const lunes = templates.filter((template) => template.weekday === 1);
    expect(lunes.map((template) => template.startTime)).toEqual(['08:00', '13:00']);
  }, 30_000);

  it('los eventos de agenda llegan a la auditoría de identity con su resumen', async () => {
    const request = await createRequest(schedulingHandle.db, aRequest({ notes: MARK }), admin);
    const appointment = await assignAppointment(
      schedulingHandle.db,
      anAssignment(request.id, { date: otherDay, startTime: '15:00', slotKind: 'manual' }),
      admin,
      { config },
    );
    await flush();

    const deadline = Date.now() + TEST_WAIT_MS;
    let rows: {
      action: string;
      summary: string | null;
      actorUsername: string | null;
      entityId: string | null;
    }[] = [];

    while (Date.now() < deadline) {
      rows = await identityHandle.db
        .select({
          action: identitySchema.auditEvents.action,
          summary: identitySchema.auditEvents.summary,
          actorUsername: identitySchema.auditEvents.actorUsername,
          entityId: identitySchema.auditEvents.entityId,
        })
        .from(identitySchema.auditEvents)
        .where(
          and(
            eq(identitySchema.auditEvents.entityType, 'appointment'),
            eq(identitySchema.auditEvents.entityId, appointment.id),
          ),
        );
      if (rows.some((row) => row.action === 'appointment_scheduled')) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    const scheduled = rows.find((row) => row.action === 'appointment_scheduled');
    expect(scheduled).toBeDefined();
    expect(scheduled?.actorUsername).toBe(MARKER);
    expect(scheduled?.summary).toContain(appointment.patientName);

    const requestRows = await identityHandle.db
      .select({ action: identitySchema.auditEvents.action })
      .from(identitySchema.auditEvents)
      .where(
        and(
          eq(identitySchema.auditEvents.entityType, 'request'),
          eq(identitySchema.auditEvents.entityId, request.id),
        ),
      );
    expect(requestRows.some((row) => row.action === 'request_created')).toBe(true);
  }, 60_000);

  it('la cola sigue siendo rápida con 2.000 solicitudes', async () => {
    const rows = Array.from({ length: 2000 }, (_, index) => ({
      channel: 'telefono' as const,
      patientId: globalThis.crypto.randomUUID(),
      patientName: `Carga ${MARK} ${String(index)}`,
      patientDocument: `V-${String(10_000_000 + index)}`,
      patientPhone: '+584121234567',
      reason: 'carga de prueba',
      status: 'en_espera_cita' as const,
      priority: 0,
      notes: MARK,
    }));

    for (let offset = 0; offset < rows.length; offset += 500) {
      await schedulingHandle.db
        .insert(appointmentRequests)
        .values(rows.slice(offset, offset + 500));
    }

    const startedAt = performance.now();
    const page = await listRequests(schedulingHandle.db, {
      page: 1,
      pageSize: 25,
      onlyWaiting: true,
      order: 'ticket',
    } as RequestFilters);
    const elapsed = performance.now() - startedAt;

    // eslint-disable-next-line no-console -- informe de la prueba de rendimiento
    console.log(`   · cola con 2.000 solicitudes: ${elapsed.toFixed(1)} ms`);
    expect(page.total).toBeGreaterThanOrEqual(2000);
    expect(page.items).toHaveLength(25);
    expect(elapsed).toBeLessThan(300);
  }, 90_000);

  it('el cupo se puede volver a subir y queda con su procedencia explícita', async () => {
    const restored = await setCapacity(
      schedulingHandle.db,
      { date: day, capacity: 16, notes: `${MARK} cupo restaurado` },
      admin,
      config,
    );
    expect(restored.source).toBe('explicito');
    expect(restored.capacity).toBe(16);
    expect(restored.warning).toBeNull();

    const info = await capacityFor(schedulingHandle.db, day, config);
    expect(info.available).toBeGreaterThanOrEqual(0);
    expect(info.isFull).toBe(false);
  }, 30_000);

  it('sin cupo explícito ni plantilla se usa el cupo por defecto', async () => {
    // Un domingo no tiene plantilla: el cupo sale del valor por defecto.
    const sunday = (() => {
      const start = new Date(Date.now() + 30 * 86_400_000);
      for (let extra = 0; extra < 7; extra += 1) {
        const date = new Date(start.getTime() + extra * 86_400_000).toISOString().slice(0, 10);
        if (weekdayOf(date) === 0) return date;
      }
      throw new Error('no encontré domingo');
    })();

    const info = await capacityFor(schedulingHandle.db, sunday, config);
    expect(info.source).toBe('defecto');
    expect(info.capacity).toBe(config.DEFAULT_DAY_CAPACITY);
    const view = await getDayView(schedulingHandle.db, sunday, config);
    expect(view.isWorkingDay).toBe(false);
    expect(view.slots).toHaveLength(0);
  }, 30_000);
});
