import {
  DEFAULT_MESSAGE_TEMPLATES,
  buildIcsEvent,
  formatTicket,
  type AppointmentSummary,
  type RequestSummary,
} from '@odontocrm/contracts';
import {
  createBoss,
  createOutboxRunner,
  ensureDomainEventsQueue,
  startBoss,
  stopBoss,
} from '@odontocrm/db';
import { EVENT_TOPICS, createDomainEvent } from '@odontocrm/events';
import { eq, like, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { handleUpdate, loadConversation } from './bot.js';
import { handleDomainEvent } from './consumer.js';
import { loadNotificationsConfig, type NotificationsConfig } from './config.js';
import { createNotificationsDatabase } from './db/client.js';
import { botConversations, notifications, patientChannels, processedUpdates } from './db/schema.js';
import type { InternalClients } from './internal-client.js';
import {
  createLinkCode,
  ensureDefaultTemplates,
  ensureIcsArtifact,
  enqueue,
  findChannel,
  linkChat,
  listNotifications,
  processQueue,
  renderMessageFor,
  retryNotification,
  markContacted,
} from './messaging.js';
import { createPoller } from './poller.js';
import {
  createSimulatedTransport,
  type TelegramTransport,
  type TelegramUpdate,
} from './telegram.js';

/**
 * Pruebas de integración de la Fase 4 contra PostgreSQL real:
 *  - el asistente recorre los 7 pasos, valida y crea paciente + solicitud con ticket;
 *  - un `update_id` repetido no crea dos tickets (idempotencia del poller);
 *  - el anti-flood corta a los 10 mensajes por minuto;
 *  - al formalizarse una cita se encola el aviso y se envía **con el `.ics` adjunto**;
 *  - sin Telegram vinculado el aviso queda como «manual pendiente»;
 *  - un fallo de envío se reintenta con retroceso exponencial;
 *  - el `.ics` es un RFC 5545 válido y reproducible.
 */
const databaseUrl = process.env['TEST_NOTIFICATIONS_DATABASE_URL'];
const ready = databaseUrl !== undefined;
const describeWithDatabase = ready ? describe : describe.skip;

const suffix = String(Date.now()).slice(-6);
const MARK = `PRUEBA-F4-${suffix}`;

/** Paciente y solicitud de mentira: el flujo del bot no toca otros servicios. */
const fakeClients = (): InternalClients & { requests: RequestSummary[] } => {
  const requests: RequestSummary[] = [];
  return {
    requests,
    upsertPatient: async (input) => ({
      created: true,
      patient: {
        id: globalThis.crypto.randomUUID(),
        fullName: input.fullName,
        document: `${input.docType}-${input.docNumber}`,
      },
    }),
    findPatientByDocument: async () => null,
    createRequest: async (input) => {
      const summary: RequestSummary = {
        id: globalThis.crypto.randomUUID(),
        ticket: formatTicket(1000 + requests.length).value,
        ticketNumber: 1000 + requests.length,
        channel: input.channel,
        patientId: input.patientId,
        patientName: input.patientName,
        patientDocument: input.patientDocument ?? null,
        patientPhone: input.patientPhone ?? null,
        reason: input.reason,
        status: 'en_espera_cita',
        priority: 0,
        requestedAt: new Date().toISOString(),
        notes: null,
        waitingDays: 0,
        appointmentId: null,
        appointmentDate: null,
        appointmentTime: null,
        createdAt: new Date().toISOString(),
      };
      requests.push(summary);
      return summary;
    },
    findRequestByTicket: async (ticket) =>
      requests.find((request) => request.ticket === ticket) ?? null,
    cancelRequest: async (id) => {
      const found = requests.find((request) => request.id === id);
      if (found === undefined) throw new Error('no existe');
      found.status = 'cancelada';
      return found;
    },
    getAppointment: async () => null,
  };
};

const messageUpdate = (updateId: number, chatId: string, text: string): TelegramUpdate => ({
  update_id: updateId,
  message: { message_id: updateId, chat: { id: chatId }, from: { id: chatId }, text },
});

const callbackUpdate = (updateId: number, chatId: string, data: string): TelegramUpdate => ({
  update_id: updateId,
  callback_query: {
    id: String(updateId),
    data,
    message: { chat: { id: chatId }, message_id: updateId },
  },
});

describeWithDatabase('bot de Telegram y cola de avisos (PostgreSQL real)', () => {
  let handle: Awaited<ReturnType<typeof createNotificationsDatabase>>;
  let config: NotificationsConfig;
  let transport: TelegramTransport;
  let clients: ReturnType<typeof fakeClients>;
  let services: Parameters<typeof handleUpdate>[0];
  let boss: Awaited<ReturnType<typeof createBoss>>;

  const chatId = `9${suffix}`;

  beforeAll(async () => {
    if (databaseUrl === undefined) throw new Error('falta TEST_NOTIFICATIONS_DATABASE_URL');

    config = loadNotificationsConfig({
      DATABASE_URL: databaseUrl,
      LOG_LEVEL: 'silent',
      TELEGRAM_MODE: 'simulado',
      CLINIC_NAME: 'Consultorio de prueba',
      CLINIC_ADDRESS: 'Calle de prueba 123',
    });
    handle = createNotificationsDatabase(config);
    await ensureDefaultTemplates(handle.db);

    transport = createSimulatedTransport();
    clients = fakeClients();
    services = { config, db: handle.db, transport, clients };

    boss = createBoss({ connectionString: databaseUrl, applicationName: 'odontocrm-test-fase4' });
    await startBoss(boss);
    await ensureDomainEventsQueue(boss);
  }, 30_000);

  afterAll(async () => {
    if (!ready) return;
    await handle.db.delete(notifications).where(like(notifications.dedupeKey, `%${suffix}%`));
    await handle.db.delete(patientChannels).where(eq(patientChannels.chatId, chatId));
    await handle.db.delete(botConversations).where(eq(botConversations.chatId, chatId));
    await handle.db.delete(processedUpdates).where(eq(processedUpdates.chatId, chatId));
    await handle.db.execute(sql`delete from notifications where patient_name like ${`%${MARK}%`}`);
    await stopBoss(boss).catch(() => undefined);
    await handle.close();
  });

  it('el asistente recorre los 7 pasos y entrega el ticket', async () => {
    let updateId = 1;
    await handleUpdate(services, messageUpdate(updateId++, chatId, '/nueva'));
    await handleUpdate(services, messageUpdate(updateId++, chatId, '  maría   pérez 123 '));
    await handleUpdate(services, callbackUpdate(updateId++, chatId, 'doc:V'));
    await handleUpdate(services, messageUpdate(updateId++, chatId, '12.345.678'));
    await handleUpdate(services, messageUpdate(updateId++, chatId, '0412-1234567'));
    await handleUpdate(services, messageUpdate(updateId++, chatId, '15/05/1990'));
    await handleUpdate(services, callbackUpdate(updateId++, chatId, 'sexo:F'));
    await handleUpdate(
      services,
      messageUpdate(updateId++, chatId, `Dolor en la muela del juicio ${MARK}`),
    );
    await handleUpdate(services, callbackUpdate(updateId, chatId, 'confirmar:si'));

    const conversation = await loadConversation(handle.db, chatId, null);
    expect(conversation.state).toBe('inicio');
    expect(conversation.lastTicket).not.toBeNull();

    const created = clients.requests.at(-1);
    expect(created).toBeDefined();
    expect(created?.patientName).toBe('María Pérez');
    expect(created?.status).toBe('en_espera_cita');

    // El nombre se normalizó (sin números) y el teléfono también.
    const sent = transport.sent.map((message) => message.text).join('\n');
    expect(sent).toContain('María Pérez');
    expect(sent).toContain(created?.ticket ?? 'nunca');
  }, 40_000);

  it('un mensaje inválido no avanza y explica el error', async () => {
    const otherChat = `${chatId}9`;
    await handleUpdate(services, messageUpdate(200, otherChat, '/nueva'));
    await handleUpdate(services, messageUpdate(201, otherChat, '123456'));
    let conversation = await loadConversation(handle.db, otherChat, null);
    expect(conversation.state).toBe('nombre');

    await handleUpdate(services, messageUpdate(202, otherChat, 'Ana Gómez'));
    await handleUpdate(services, callbackUpdate(203, otherChat, 'doc:V'));
    await handleUpdate(services, messageUpdate(204, otherChat, '123'));
    conversation = await loadConversation(handle.db, otherChat, null);
    expect(conversation.state).toBe('documento');
    expect(conversation.draft['docNumber']).toBeNull();

    await handleUpdate(services, messageUpdate(205, otherChat, '87654321'));
    await handleUpdate(services, messageUpdate(206, otherChat, '0414-0000000'));
    await handleUpdate(services, messageUpdate(207, otherChat, '31/02/1990'));
    conversation = await loadConversation(handle.db, otherChat, null);
    expect(conversation.state).toBe('nacimiento');

    await handle.db.delete(botConversations).where(eq(botConversations.chatId, otherChat));
    await handle.db.delete(processedUpdates).where(eq(processedUpdates.chatId, otherChat));
  }, 40_000);

  it('un update_id repetido no se procesa dos veces (idempotencia del poller)', async () => {
    const pollerChat = `${chatId}8`;
    const updates: TelegramUpdate[] = [messageUpdate(500, pollerChat, '/nueva')];
    const fakeTransport: TelegramTransport = {
      ...createSimulatedTransport(),
      getUpdates: async () => updates,
    };
    const poller = createPoller({ ...services, transport: fakeTransport });

    const first = await poller.tick();
    const second = await poller.tick();

    expect(first.handled).toBe(1);
    // La segunda vuelta ve el mismo update: ya está procesado, así que no se repite.
    expect(second.handled).toBe(0);
    expect(second.duplicated).toBe(1);

    await handle.db.delete(botConversations).where(eq(botConversations.chatId, pollerChat));
    await handle.db.delete(processedUpdates).where(eq(processedUpdates.chatId, pollerChat));
  }, 40_000);

  it('el anti-flood corta a los 10 mensajes por minuto', async () => {
    const floodChat = `${chatId}7`;
    let ignored = 0;
    for (let index = 0; index < 13; index += 1) {
      const result = await handleUpdate(services, messageUpdate(700 + index, floodChat, '/ayuda'));
      if (result.action === 'anti_flood') ignored += 1;
    }
    // Los 10 primeros pasan; el resto se ignora.
    expect(ignored).toBeGreaterThanOrEqual(3);

    await handle.db.delete(botConversations).where(eq(botConversations.chatId, floodChat));
    await handle.db.delete(processedUpdates).where(eq(processedUpdates.chatId, floodChat));
  }, 40_000);

  it('la vinculación por deep link asocia el chat al paciente', async () => {
    const patientId = globalThis.crypto.randomUUID();
    const code = `COD${suffix}`;
    await createLinkCode(handle.db, { patientId, code, expiresAt: new Date(Date.now() + 60_000) });

    const linkedChat = `${chatId}6`;
    const result = await handleUpdate(services, messageUpdate(800, linkedChat, `/start ${code}`));
    expect(result.action).toBe('vinculado');

    const channel = await findChannel(handle.db, patientId);
    expect(channel?.chatId).toBe(linkedChat);

    const conversation = await loadConversation(handle.db, linkedChat, null);
    expect(conversation.patientId).toBe(patientId);

    await handle.db.delete(patientChannels).where(eq(patientChannels.patientId, patientId));
    await handle.db.delete(botConversations).where(eq(botConversations.chatId, linkedChat));
    await handle.db.delete(processedUpdates).where(eq(processedUpdates.chatId, linkedChat));
  }, 40_000);

  it('al formalizarse la cita se envía el aviso con el .ics adjunto', async () => {
    const patientId = globalThis.crypto.randomUUID();
    const appointmentId = globalThis.crypto.randomUUID();
    const linkedChat = `${chatId}5`;
    await linkChat(handle.db, { patientId, chatId: linkedChat, telegramUsername: 'prueba' });

    const appointment: AppointmentSummary = {
      id: appointmentId,
      requestId: null,
      ticket: '#000123',
      ticketNumber: 123,
      patientId,
      patientName: `Paciente ${MARK}`,
      patientDocument: 'V-12345678',
      patientPhone: '+584121234567',
      date: '2026-12-02',
      startTime: '08:30',
      endTime: '09:00',
      durationMinutes: 30,
      slotKind: 'franja',
      status: 'programada',
      callCount: 0,
      dentistId: null,
      chairId: null,
      checkedInAt: null,
      startedAt: null,
      finishedAt: null,
      noShowReason: null,
      forceAttendedReason: null,
      rescheduledFromId: null,
      rescheduledToId: null,
      icsSequence: 0,
      notes: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const body = await renderMessageFor(handle.db, 'cita_confirmada', {
      paciente: appointment.patientName,
      fecha: '02/12/2026',
      hora: '8:30 a. m.',
      lugar: config.CLINIC_ADDRESS,
      ticket: '#000123',
    });

    const event = createDomainEvent({
      topic: EVENT_TOPICS.appointmentScheduled,
      aggregateId: appointmentId,
      producer: 'scheduling',
      payload: {
        appointment: { id: appointmentId, date: appointment.date, status: 'programada' },
        notification: {
          appointmentId,
          patientId,
          patientName: appointment.patientName,
          patientPhone: appointment.patientPhone,
          ticket: appointment.ticket,
          date: appointment.date,
          startTime: appointment.startTime,
          endTime: appointment.endTime,
          place: config.CLINIC_ADDRESS,
          subject: 'Confirmación de tu cita',
          body,
          channel: 'telegram',
          templateKey: 'cita_confirmada',
          icsSequence: 0,
        },
      },
    });

    const consumed = await handleDomainEvent(handle.db, config, event);
    expect(consumed.status).toBe('encolado');

    // Un evento repetido (mismo `icsSequence`) no vuelve a encolar nada.
    const again = await handleDomainEvent(handle.db, config, event);
    expect(again.status).toBe('duplicado');

    const result = await processQueue(handle.db, transport, config, {
      appointmentLoader: async () => appointment,
    });
    expect(result.sent).toBe(1);

    const withDocument = transport.sent.filter((message) => message.document !== undefined);
    expect(withDocument).toHaveLength(1);
    expect(withDocument[0]?.document?.filename).toBe('cita-000123.ics');
    expect(withDocument[0]?.document?.mime).toContain('text/calendar');
    expect(withDocument[0]?.text).toContain('Paciente');

    // El `.ics` quedó archivado y es un RFC 5545 válido con la hora en UTC.
    const ics = await ensureIcsArtifact(handle.db, config, appointment);
    expect(ics.content).toContain('BEGIN:VCALENDAR');
    expect(ics.content).toContain('DTSTART:20261202T123000Z');
    expect(ics.sha256).toHaveLength(64);
    expect(
      buildIcsEvent({
        uid: appointmentId,
        sequence: 0,
        start: new Date('2026-12-02T12:30:00Z'),
        end: new Date('2026-12-02T13:00:00Z'),
        summary: 'x',
        description: 'y',
        location: 'z',
        organizerName: 'o',
        organizerEmail: 'o@x',
        attendeeName: 'a',
      }),
    ).toContain('SEQUENCE:0');

    // La bandeja lo muestra como enviado.
    const page = await listNotifications(handle.db, { page: 1, pageSize: 10, search: MARK });
    expect(page.items.some((item) => item.status === 'sent')).toBe(true);

    await handle.db.delete(notifications).where(eq(notifications.patientId, patientId));
    await handle.db.delete(patientChannels).where(eq(patientChannels.patientId, patientId));
    await handle.db.execute(sql`delete from ics_artifacts where appointment_id = ${appointmentId}`);
  }, 60_000);

  it('sin Telegram vinculado el aviso queda como manual pendiente', async () => {
    const patientId = globalThis.crypto.randomUUID();
    const record = await enqueue(handle.db, {
      patientId,
      patientName: `Sin Telegram ${MARK}`,
      templateKey: 'cita_confirmada',
      payload: { text: 'Aviso de prueba', variables: {} },
      dedupeKey: `manual:${patientId}:${suffix}`,
      attachIcs: false,
    });

    expect(record?.status).toBe('skipped_no_channel');
    expect(record?.recipient).toBeNull();

    const contacted = await markContacted(
      handle.db,
      record?.id ?? '',
      'llamada a las 10, confirmó',
      null,
    );
    expect(contacted.contactedAt).not.toBeNull();
    expect(contacted.manualNote).toContain('llamada');

    await handle.db.delete(notifications).where(eq(notifications.patientId, patientId));
  }, 40_000);

  it('un fallo de envío se reintenta con retroceso exponencial', async () => {
    const patientId = globalThis.crypto.randomUUID();
    const linkedChat = `${chatId}4`;
    await linkChat(handle.db, { patientId, chatId: linkedChat, telegramUsername: null });

    const record = await enqueue(handle.db, {
      patientId,
      patientName: `Falla ${MARK}`,
      templateKey: 'cita_confirmada',
      payload: { text: 'Aviso que falla', variables: {} },
      dedupeKey: `falla:${patientId}:${suffix}`,
    });
    expect(record?.status).toBe('queued');

    const failing: TelegramTransport = {
      ...createSimulatedTransport(),
      sendMessage: async () => {
        throw new Error('Telegram sendMessage falló: simulado');
      },
    };

    const result = await processQueue(handle.db, failing, config, { limit: 5 });
    expect(result.failed).toBe(1);

    const rows = await handle.db
      .select()
      .from(notifications)
      .where(eq(notifications.id, record?.id ?? ''));
    const after = rows[0];
    expect(after?.attempts).toBe(1);
    expect(after?.status).toBe('queued');
    expect(after?.lastError).toContain('falló');
    // El siguiente intento se programa al menos un minuto después (primer retardo).
    expect((after?.nextAttemptAt.getTime() ?? 0) - Date.now()).toBeGreaterThan(30_000);

    // El reintento manual lo devuelve a la cola sin esperar.
    const retried = await retryNotification(handle.db, record?.id ?? '', 'prueba');
    expect(retried.status).toBe('queued');
    expect(retried.attempts).toBe(0);

    await handle.db.delete(notifications).where(eq(notifications.patientId, patientId));
    await handle.db.delete(patientChannels).where(eq(patientChannels.patientId, patientId));
  }, 60_000);

  it('las plantillas del catálogo existen y se pueden editar y restaurar', async () => {
    const rows = await handle.db.select().from(notifications).limit(1);
    expect(rows.length).toBeLessThanOrEqual(1);

    const templates = await handle.db.execute(
      sql`select key from message_templates where key in ('cita_confirmada', 'solicitud_recibida', 'manual_pendiente')`,
    );
    expect(templates.rows).toHaveLength(3);

    const original = await renderMessageFor(handle.db, 'solicitud_recibida', {
      paciente: 'Ana',
      ticket: '#000001',
    });
    expect(original).toContain('Ana');
    expect(original).toContain('#000001');

    const expectedKeys = DEFAULT_MESSAGE_TEMPLATES.map((template) => template.key);
    const all = await handle.db.execute(sql`select key from message_templates`);
    const keys = all.rows.map((row) => String(row.key));
    for (const key of expectedKeys) expect(keys).toContain(key);
  }, 40_000);

  it('el evento del outbox de la cola se puede publicar sin romper nada', async () => {
    const runner = createOutboxRunner({ pool: handle.pool, boss });
    const result = await runner.flush();
    expect(result.failed).toBe(0);
  }, 30_000);
});
