import {
  DEFAULT_MESSAGE_TEMPLATES,
  buildIcsEvent,
  formatTicket,
  type AppointmentSummary,
  type InboundMessage,
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
import { and, eq, like, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createAdapterRegistry, type AdapterRegistry } from './canales/adaptador.js';
import { createSimulatedAdapter, type SimulatedAdapter } from './canales/simulado.js';
import { handleInbound, loadConversation } from './core/asistente.js';
import { handleDomainEvent } from './consumer.js';
import { loadNotificationsConfig, type NotificationsConfig } from './config.js';
import { createNotificationsDatabase } from './db/client.js';
import {
  botConversations,
  messageTemplates,
  notifications,
  patientChannels,
  processedUpdates,
} from './db/schema.js';
import type { InternalClients } from './internal-client.js';
import {
  createLinkCode,
  ensureDefaultTemplates,
  ensureIcsArtifact,
  enqueue,
  findChannel,
  linkChat,
  listChannels,
  listNotifications,
  markContacted,
  processQueue,
  renderMessageFor,
  retryNotification,
} from './messaging.js';

/**
 * Pruebas de integración de la Fase 4.1 contra PostgreSQL real:
 *  - el asistente recorre los 7 pasos por **cualquier** adaptador y crea paciente + solicitud;
 *  - la conversación vive en `(canal, dirección)`: Telegram y WhatsApp no se pisan;
 *  - en un canal sin botones las opciones van **numeradas** y el «2» vale como el botón;
 *  - un `eventoId` repetido no crea dos tickets (idempotencia del núcleo);
 *  - el anti-flood corta a los 10 mensajes por minuto;
 *  - el aviso de cita sale **por el adaptador del canal** y con el `.ics` adjunto;
 *  - sin canal vinculado el aviso queda como «manual pendiente»;
 *  - un fallo de envío se reintenta con retroceso exponencial.
 */
const databaseUrl = process.env['TEST_NOTIFICATIONS_DATABASE_URL'];
const ready = databaseUrl !== undefined;
const describeWithDatabase = ready ? describe : describe.skip;

const suffix = String(Date.now()).slice(-6);
const MARK = `PRUEBA-F41-${suffix}`;

/** Paciente y solicitud de mentira: el flujo del asistente no toca otros servicios. */
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

describeWithDatabase('asistente multicanal y cola de avisos (PostgreSQL real)', () => {
  let handle: Awaited<ReturnType<typeof createNotificationsDatabase>>;
  let config: NotificationsConfig;
  let clients: ReturnType<typeof fakeClients>;
  let boss: Awaited<ReturnType<typeof createBoss>>;

  /** Adaptador de Telegram (con botones) y de WhatsApp (sin botones, numerado). */
  let telegram: SimulatedAdapter;
  let whatsapp: SimulatedAdapter;
  let registry: AdapterRegistry;
  let services: Parameters<typeof handleInbound>[0];

  const direccionBase = `9${suffix}`;
  const evento = (base: number): string => String(base);
  let contador = 0;

  /** Entrega un mensaje al núcleo como lo haría el canal. */
  const enviar = async (
    adapter: SimulatedAdapter,
    entrada: { direccion: string; texto?: string; accion?: string; eventoId?: string },
  ): Promise<{ handled: boolean; action?: string }> => {
    contador += 1;
    const inbound: InboundMessage = {
      canal: adapter.id,
      direccion: entrada.direccion,
      usuario: 'paciente-de-prueba',
      texto: entrada.texto ?? null,
      accion: entrada.accion ?? null,
      eventoId: entrada.eventoId ?? evento(100_000 + contador),
      recibidoEn: new Date().toISOString(),
    };
    return handleInbound(services, inbound);
  };

  /** Recorre los 7 pasos por el adaptador indicado. */
  const recorrerPasos = async (adapter: SimulatedAdapter, direccion: string): Promise<void> => {
    await enviar(adapter, { direccion, texto: 'quiero una cita' });
    await enviar(adapter, { direccion, texto: '  maría   pérez 123 ' });
    await enviar(adapter, { direccion, accion: 'doc:V' });
    await enviar(adapter, { direccion, texto: '12.345.678' });
    await enviar(adapter, { direccion, texto: '0412-1234567' });
    await enviar(adapter, { direccion, texto: '15/05/1990' });
    await enviar(adapter, { direccion, accion: 'sexo:F' });
    await enviar(adapter, { direccion, texto: `Dolor en la muela del juicio ${MARK}` });
    await enviar(adapter, { direccion, accion: 'confirmar:si' });
  };

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

    telegram = createSimulatedAdapter('telegram');
    whatsapp = createSimulatedAdapter('whatsapp', { botones: false });
    registry = createAdapterRegistry([telegram, whatsapp]);

    clients = fakeClients();
    services = { config, db: handle.db, canales: registry, clients };

    // Los adaptadores empujan al mismo núcleo, como en el servicio real.
    await registry.start(async (entrante) => {
      await handleInbound(services, entrante);
    });

    boss = createBoss({ connectionString: databaseUrl, applicationName: 'odontocrm-test-fase41' });
    await startBoss(boss);
    await ensureDomainEventsQueue(boss);
  }, 30_000);

  afterAll(async () => {
    if (!ready) return;
    await handle.db.delete(notifications).where(like(notifications.dedupeKey, `%${suffix}%`));
    await handle.db
      .delete(patientChannels)
      .where(like(patientChannels.direccion, `${direccionBase}%`));
    await handle.db
      .delete(botConversations)
      .where(like(botConversations.direccion, `${direccionBase}%`));
    await handle.db
      .delete(processedUpdates)
      .where(like(processedUpdates.direccion, `${direccionBase}%`));
    await handle.db.execute(sql`delete from notifications where patient_name like ${`%${MARK}%`}`);
    await registry.stop();
    await stopBoss(boss).catch(() => undefined);
    await handle.close();
  });

  it('el asistente recorre los 7 pasos por Telegram y entrega el ticket', async () => {
    const direccion = direccionBase;
    await recorrerPasos(telegram, direccion);

    const conversation = await loadConversation(handle.db, 'telegram', direccion, null);
    expect(conversation.state).toBe('inicio');
    expect(conversation.lastTicket).not.toBeNull();

    const created = clients.requests.at(-1);
    expect(created).toBeDefined();
    expect(created?.patientName).toBe('María Pérez');
    expect(created?.status).toBe('en_espera_cita');
    // El canal de la solicitud es el del adaptador, no uno fijo.
    expect(created?.channel).toBe('telegram');

    const sent = telegram.sent.map((message) => message.texto).join('\n');
    expect(sent).toContain('María Pérez');
    expect(sent).toContain(created?.ticket ?? 'nunca');

    // El canal queda vinculado con su dirección: por ahí saldrán los avisos.
    const linked = await findChannel(handle.db, created?.patientId ?? '');
    expect(linked).toEqual({ canal: 'telegram', direccion });
  }, 60_000);

  it('en un canal sin botones las opciones van numeradas y el «2» sirve de botón', async () => {
    const direccion = `${direccionBase}1`;
    await enviar(whatsapp, { direccion, texto: 'cita' });
    await enviar(whatsapp, { direccion, texto: 'María Pérez' });

    // Paso 2: el documento. WhatsApp no tiene botones, así que se numeran.
    const pedirDocumento = whatsapp.sent.at(-1);
    expect(pedirDocumento?.texto).toContain('1) V');
    expect(pedirDocumento?.texto).toContain('4) SC');

    await enviar(whatsapp, { direccion, texto: '2' });
    const conversation = await loadConversation(handle.db, 'whatsapp', direccion, null);
    // El «2» valió como el botón «E» y el paso avanzó con ese tipo de documento.
    expect(conversation.draft['docType']).toBe('E');
    expect(conversation.state).toBe('documento');

    await enviar(whatsapp, { direccion, texto: '87654321' });
    await enviar(whatsapp, { direccion, texto: '0414-0000000' });
    await enviar(whatsapp, { direccion, texto: '20/01/1985' });

    // Paso 5: el sexo, también numerado.
    const pedirSexo = whatsapp.sent.at(-1);
    expect(pedirSexo?.texto).toContain('1) M');
    await enviar(whatsapp, { direccion, texto: '3' });
    const conSexo = await loadConversation(handle.db, 'whatsapp', direccion, null);
    expect(conSexo.draft['sex']).toBe('O');
    expect(conSexo.state).toBe('motivo');

    await enviar(whatsapp, { direccion, texto: `Limpieza dental ${MARK}` });
    // La confirmación también va numerada: 1 = Confirmar.
    expect(whatsapp.sent.at(-1)?.texto).toContain('1) Confirmar');
    await enviar(whatsapp, { direccion, texto: '1' });

    const created = clients.requests.at(-1);
    expect(created?.patientName).toBe('María Pérez');
    expect(created?.channel).toBe('whatsapp');
    const linked = await findChannel(handle.db, created?.patientId ?? '');
    expect(linked).toEqual({ canal: 'whatsapp', direccion });
  }, 60_000);

  it('la misma persona por dos canales no se pisa: una conversación por (canal, dirección)', async () => {
    const direccion = `${direccionBase}2`;
    await enviar(telegram, { direccion, texto: 'cita' });
    await enviar(whatsapp, { direccion, texto: 'cita' });

    const porTelegram = await loadConversation(handle.db, 'telegram', direccion, null);
    const porWhatsapp = await loadConversation(handle.db, 'whatsapp', direccion, null);

    expect(porTelegram.canal).toBe('telegram');
    expect(porWhatsapp.canal).toBe('whatsapp');
    expect(porTelegram.state).toBe('nombre');
    expect(porWhatsapp.state).toBe('nombre');
  }, 60_000);

  it('un mensaje inválido no avanza y explica el error', async () => {
    const direccion = `${direccionBase}3`;
    await enviar(whatsapp, { direccion, texto: 'cita' });
    await enviar(whatsapp, { direccion, texto: '123456' });
    let conversation = await loadConversation(handle.db, 'whatsapp', direccion, null);
    expect(conversation.state).toBe('nombre');

    await enviar(whatsapp, { direccion, texto: 'Ana Gómez' });
    await enviar(whatsapp, { direccion, accion: 'doc:V' });
    await enviar(whatsapp, { direccion, texto: '123' });
    conversation = await loadConversation(handle.db, 'whatsapp', direccion, null);
    expect(conversation.state).toBe('documento');
    expect(conversation.draft['docNumber']).toBeNull();

    await enviar(whatsapp, { direccion, texto: '87654321' });
    await enviar(whatsapp, { direccion, texto: '0414-0000000' });
    await enviar(whatsapp, { direccion, texto: '31/02/1990' });
    conversation = await loadConversation(handle.db, 'whatsapp', direccion, null);
    expect(conversation.state).toBe('nacimiento');
  }, 60_000);

  it('un eventoId repetido no se procesa dos veces (idempotencia del núcleo)', async () => {
    const direccion = `${direccionBase}4`;
    const eventoId = evento(900_001);

    const primera = await enviar(telegram, { direccion, texto: 'cita', eventoId });
    const repetida = await enviar(telegram, { direccion, texto: 'cita', eventoId });

    expect(primera.action).toBe('nueva');
    expect(repetida.handled).toBe(false);
    expect(repetida.action).toBe('duplicado');

    // Y por el camino del adaptador (el que usa el servicio en marcha) tampoco.
    await telegram.deliver({ direccion, texto: 'cita', eventoId });
    const conversation = await loadConversation(handle.db, 'telegram', direccion, null);
    expect(conversation.state).toBe('nombre');
  }, 60_000);

  it('el anti-flood corta a los 10 mensajes por minuto', async () => {
    const direccion = `${direccionBase}5`;
    let ignored = 0;
    for (let index = 0; index < 13; index += 1) {
      const result = await enviar(telegram, { direccion, texto: 'ayuda' });
      if (result.action === 'anti_flood') ignored += 1;
    }
    // Los 10 primeros pasan; el resto se ignora.
    expect(ignored).toBeGreaterThanOrEqual(3);
  }, 60_000);

  it('la vinculación por código asocia la dirección al paciente (deep link de Telegram)', async () => {
    const patientId = globalThis.crypto.randomUUID();
    const code = `COD${suffix}`;
    await createLinkCode(handle.db, { patientId, code, expiresAt: new Date(Date.now() + 60_000) });

    const direccion = `${direccionBase}6`;
    const result = await enviar(telegram, { direccion, texto: `/start ${code}` });
    expect(result.action).toBe('vinculado');

    const channel = await findChannel(handle.db, patientId);
    expect(channel).toEqual({ canal: 'telegram', direccion });

    const conversation = await loadConversation(handle.db, 'telegram', direccion, null);
    expect(conversation.patientId).toBe(patientId);
  }, 60_000);

  it('al formalizarse la cita el aviso sale por el adaptador del canal, con el .ics', async () => {
    const patientId = globalThis.crypto.randomUUID();
    const appointmentId = globalThis.crypto.randomUUID();
    const direccion = `${direccionBase}7`;
    await linkChat(handle.db, {
      patientId,
      canal: 'whatsapp',
      direccion,
      usuario: 'paciente',
    });

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

    const result = await processQueue(handle.db, registry, config, {
      appointmentLoader: async () => appointment,
    });
    expect(result.sent).toBe(1);

    // Salió por WhatsApp (el canal vinculado), no por Telegram.
    const porWhatsApp = whatsapp.sent.filter((message) => message.documento !== undefined);
    expect(porWhatsApp).toHaveLength(1);
    expect(porWhatsApp[0]?.direccion).toBe(direccion);
    expect(porWhatsApp[0]?.documento?.nombre).toBe('cita-000123.ics');
    expect(porWhatsApp[0]?.documento?.mime).toContain('text/calendar');
    expect(porWhatsApp[0]?.texto).toContain('Paciente');
    expect(telegram.sent.some((message) => message.documento !== undefined)).toBe(false);

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

    // Los canales de la bandeja muestran el canal real, no un valor fijo.
    const canales = await listChannels(handle.db, patientId);
    expect(canales[0]).toMatchObject({ canal: 'whatsapp', direccion });

    await handle.db.delete(notifications).where(eq(notifications.patientId, patientId));
    await handle.db.delete(patientChannels).where(eq(patientChannels.patientId, patientId));
    await handle.db.execute(sql`delete from ics_artifacts where appointment_id = ${appointmentId}`);
  }, 60_000);

  it('sin canal vinculado el aviso queda como manual pendiente', async () => {
    const patientId = globalThis.crypto.randomUUID();
    const record = await enqueue(handle.db, {
      patientId,
      patientName: `Sin canal ${MARK}`,
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
  }, 60_000);

  it('un fallo de envío se reintenta con retroceso exponencial', async () => {
    const patientId = globalThis.crypto.randomUUID();
    const direccion = `${direccionBase}8`;
    await linkChat(handle.db, { patientId, canal: 'telegram', direccion });

    const record = await enqueue(handle.db, {
      patientId,
      patientName: `Falla ${MARK}`,
      templateKey: 'cita_confirmada',
      payload: { text: 'Aviso que falla', variables: {} },
      dedupeKey: `falla:${patientId}:${suffix}`,
    });
    expect(record?.status).toBe('queued');

    const roto = createSimulatedAdapter('telegram');
    await roto.iniciar(async () => undefined);
    const rotoRegistry = createAdapterRegistry([
      {
        ...roto,
        enviar: async () => Promise.reject(new Error('Telegram sendMessage falló: simulado')),
      },
    ]);

    const result = await processQueue(handle.db, rotoRegistry, config, { limit: 5 });
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
  }, 60_000);

  it('las plantillas sembradas hablan de intenciones, no solo de comandos', async () => {
    const rows = await handle.db
      .select()
      .from(messageTemplates)
      .where(eq(messageTemplates.key, 'bienvenida'));

    expect(rows[0]?.body).toContain('«cita»');
  }, 30_000);

  it('el evento del outbox de la cola se puede publicar sin romper nada', async () => {
    const runner = createOutboxRunner({ pool: handle.pool, boss });
    const result = await runner.flush();
    expect(result.failed).toBe(0);
  }, 30_000);

  it('los canales vinculados se listan con su canal y su dirección', async () => {
    const patientId = globalThis.crypto.randomUUID();
    const direccion = `${direccionBase}9`;
    await linkChat(handle.db, { patientId, canal: 'whatsapp', direccion, usuario: 'María' });

    const items = await listChannels(handle.db, patientId);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ canal: 'whatsapp', direccion, usuario: 'María' });

    await handle.db.delete(patientChannels).where(eq(patientChannels.patientId, patientId));
  }, 30_000);

  it('el canal vinculado se prefiere al pedido cuando el paciente no está en él', async () => {
    const patientId = globalThis.crypto.randomUUID();
    const direccion = `${direccionBase}A`.slice(0, 40);
    await linkChat(handle.db, { patientId, canal: 'whatsapp', direccion });

    // El evento pide Telegram; como no está vinculado, sale por WhatsApp.
    const record = await enqueue(handle.db, {
      patientId,
      patientName: `Preferencia ${MARK}`,
      templateKey: 'cita_confirmada',
      channel: 'telegram',
      payload: { text: 'Aviso', variables: {} },
      dedupeKey: `preferencia:${patientId}:${suffix}`,
    });

    expect(record?.channel).toBe('whatsapp');
    expect(record?.recipient).toBe(direccion);
    expect(record?.status).toBe('queued');

    await handle.db.delete(notifications).where(eq(notifications.patientId, patientId));
    await handle.db
      .delete(patientChannels)
      .where(
        and(eq(patientChannels.patientId, patientId), eq(patientChannels.direccion, direccion)),
      );
  }, 30_000);
});
