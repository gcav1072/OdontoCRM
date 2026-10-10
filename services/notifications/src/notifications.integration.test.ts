import {
  DEFAULT_MESSAGE_TEMPLATES,
  buildIcsEvent,
  formatTicket,
  type AppointmentSummary,
  type InboundMessage,
  type PatientSummary,
  type RequestSummary,
} from '@odontocrm/contracts';
import {
  createBoss,
  createOutboxRunner,
  ensureDomainEventsQueue,
  startBoss,
  stopBoss,
} from '@odontocrm/db';
import { EVENT_TOPICS, createDomainEvent, type DomainEvent } from '@odontocrm/events';
import { and, eq, like, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createAdapterRegistry, type AdapterRegistry } from './canales/adaptador.js';
import { createSimulatedAdapter, type SimulatedAdapter } from './canales/simulado.js';
import { channelsInInbox } from './channels.js';
import { avisarFalloAlPaciente, handleInbound, loadConversation } from './core/asistente.js';
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
import { updateNotificationSettings } from './settings.js';

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
const fakeClients = (): InternalClients & {
  requests: RequestSummary[];
  citas: AppointmentSummary[];
  confirmadas: { id: string; channel: string }[];
  canceladas: { id: string; channel: string }[];
} => {
  const requests: RequestSummary[] = [];
  const citas: AppointmentSummary[] = [];
  const confirmadas: { id: string; channel: string }[] = [];
  const canceladas: { id: string; channel: string }[] = [];
  return {
    requests,
    citas,
    confirmadas,
    canceladas,
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

    // Nombres para la tabla de canales: por defecto ninguno; cada prueba lo ajusta.
    listPatientSummaries: async () => [],

    // Listado y confirmación de citas (ADR 0052): el asistente confirma contra la
    // agenda, así que el doble imita los filtros que de verdad se usan.
    listAppointments: async (filters) => {
      const items = citas
        .filter((cita) => filters.patientId === undefined || cita.patientId === filters.patientId)
        .filter((cita) => filters.from === undefined || cita.date >= filters.from)
        .filter((cita) => filters.to === undefined || cita.date <= filters.to)
        .filter((cita) => filters.status === undefined || cita.status === filters.status)
        .filter(
          (cita) =>
            filters.confirmed === undefined || (cita.confirmedAt !== null) === filters.confirmed,
        );
      return {
        items,
        total: items.length,
        page: 1,
        pageSize: filters.pageSize ?? 25,
        totalPages: 1,
      };
    },
    confirmAppointment: async (id, input) => {
      const encontrada = citas.find((cita) => cita.id === id);
      if (encontrada === undefined) throw new Error('la cita no existe');
      confirmadas.push({ id, channel: input.channel });
      encontrada.status = 'confirmada';
      encontrada.confirmedAt = new Date().toISOString();
      encontrada.confirmedChannel = input.channel;
      return encontrada;
    },
    // Cancelación del paciente (ADR 0053): imita la idempotencia de la agenda.
    cancelAppointment: async (id, input) => {
      const encontrada = citas.find((cita) => cita.id === id);
      if (encontrada === undefined) throw new Error('la cita no existe');
      if (encontrada.status !== 'cancelada') {
        canceladas.push({ id, channel: input.channel });
        encontrada.status = 'cancelada';
        encontrada.cancelledAt = new Date().toISOString();
        encontrada.cancelledChannel = input.channel;
      }
      return encontrada;
    },
  };
};

/** Cita de mentira para el asistente: lo justo para confirmarla. */
const unaCita = (overrides: Partial<AppointmentSummary> = {}): AppointmentSummary => ({
  id: globalThis.crypto.randomUUID(),
  requestId: null,
  ticket: '#000900',
  ticketNumber: 900,
  patientId: globalThis.crypto.randomUUID(),
  patientName: `Paciente ${MARK}`,
  patientDocument: 'V-12345678',
  patientPhone: '+584121234567',
  date: '2026-12-01',
  startTime: '09:00',
  endTime: '09:30',
  durationMinutes: 30,
  slotKind: 'franja',
  status: 'notificada',
  callCount: 0,
  confirmedAt: null,
  confirmedChannel: null,
  cancelledAt: null,
  cancelledChannel: null,
  dentistId: null,
  chairId: null,
  chairLabel: null,
  dentistName: null,
  checkedInAt: null,
  startedAt: null,
  finishedAt: null,
  noShowReason: null,
  forceAttendedReason: null,
  clinicalSessionId: null,
  rescheduledFromId: null,
  rescheduledToId: null,
  icsSequence: 0,
  notes: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...overrides,
});

/** Paciente de mentira: lo justo para que la bandeja resuelva su nombre. */
const unPaciente = (id: string, fullName: string): PatientSummary => ({
  id,
  docType: 'V',
  docNumber: '12345678',
  document: 'V-12345678',
  fullName,
  birthDate: '1990-05-15',
  age: 35,
  isMinor: false,
  sex: 'F',
  phone: '+584121234567',
  phoneAlt: null,
  status: 'activo',
  isFictitious: false,
  hasGuardian: false,
  createdAt: new Date().toISOString(),
});

/** Fecha `AAAA-MM-DD` a N días de hoy (calendario UTC, como el bot). */
const enDias = (dias: number): string =>
  new Date(Date.now() + dias * 86_400_000).toISOString().slice(0, 10);

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

  it('el paciente confirma su cita por el botón y escribiendo «confirmar» (ADR 0052)', async () => {
    const patientId = globalThis.crypto.randomUUID();
    const direccion = `${direccionBase}C`;
    await linkChat(handle.db, { patientId, canal: 'telegram', direccion });

    // Dentro de la ventana de confirmación (hoy + 3 días).
    const fecha = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    const cita = unaCita({ patientId, date: fecha });
    clients.citas.push(cita);

    // El botón del aviso llega como acción del canal.
    const porBoton = await enviar(telegram, { direccion, accion: `confirmar_cita:${cita.id}` });
    expect(porBoton.action).toBe('confirmar_confirmada');
    expect(clients.confirmadas.at(-1)).toEqual({ id: cita.id, channel: 'telegram' });
    expect(telegram.sent.at(-1)?.texto).toContain('Quedaste confirmado');

    // Volver a escribir «confirmar» no es un error: se le recuerda lo que ya dijo.
    const porTexto = await enviar(telegram, { direccion, texto: 'confirmar' });
    expect(porTexto.action).toBe('confirmar_ya_estaba');
    expect(clients.confirmadas).toHaveLength(1);

    // Sin citas próximas, se le dice que no hay nada que confirmar.
    const sinCitas = await enviar(telegram, { direccion: `${direccionBase}D`, texto: 'confirmar' });
    expect(sinCitas.action).toBe('confirmar_sin_citas');
    expect(telegram.sent.at(-1)?.texto).toContain('No veo ninguna cita');

    // Y una cita de **otro** paciente no se puede confirmar con su botón: el
    // identificador viaja por el chat, así que se comprueba que sea suya.
    const ajena = unaCita({ patientId: globalThis.crypto.randomUUID(), date: fecha });
    clients.citas.push(ajena);
    const noEsSuya = await enviar(telegram, { direccion, accion: `confirmar_cita:${ajena.id}` });
    expect(noEsSuya.action).toBe('confirmar_no_es_suya');
    expect(clients.confirmadas.some((item) => item.id === ajena.id)).toBe(false);

    await handle.db.delete(botConversations).where(eq(botConversations.direccion, direccion));
    await handle.db.delete(patientChannels).where(eq(patientChannels.patientId, patientId));
  }, 60_000);

  it('el paciente cancela su cita por el botón y escribiendo «cancelar» (ADR 0053)', async () => {
    const patientId = globalThis.crypto.randomUUID();
    const direccion = `${direccionBase}X`;
    await linkChat(handle.db, { patientId, canal: 'telegram', direccion });

    // Dentro de la ventana de citas (hoy + 4 días).
    const fecha = new Date(Date.now() + 4 * 86_400_000).toISOString().slice(0, 10);
    const cita = unaCita({ patientId, date: fecha });
    clients.citas.push(cita);

    // El botón «Cancelar» del aviso llega como acción del canal.
    const porBoton = await enviar(telegram, { direccion, accion: `cancelar_cita:${cita.id}` });
    expect(porBoton.action).toBe('cancelar_cita_cancelada');
    expect(clients.canceladas.at(-1)).toEqual({ id: cita.id, channel: 'telegram' });
    expect(telegram.sent.at(-1)?.texto).toContain('quedó cancelada');

    // Volver a escribir «cancelar» no es un error: se le recuerda lo que ya hizo.
    const otraVez = await enviar(telegram, { direccion, texto: 'cancelar' });
    expect(otraVez.action).toBe('cancelar_cita_ya_estaba');
    expect(clients.canceladas).toHaveLength(1);

    // Una cita de **otro** paciente no se cancela con su botón: el identificador
    // viaja por el chat, así que se comprueba que sea suya.
    const ajena = unaCita({ patientId: globalThis.crypto.randomUUID(), date: fecha });
    clients.citas.push(ajena);
    const noEsSuya = await enviar(telegram, {
      direccion,
      accion: `cancelar_cita:${ajena.id}`,
    });
    expect(noEsSuya.action).toBe('cancelar_cita_no_es_suya');
    expect(clients.canceladas.some((item) => item.id === ajena.id)).toBe(false);

    // En sala de espera el paciente ya está aquí: por el bot no se cancela.
    const enSala = unaCita({ patientId, date: fecha, status: 'en_sala_espera' });
    clients.citas.push(enSala);
    const noCancelable = await enviar(telegram, {
      direccion,
      accion: `cancelar_cita:${enSala.id}`,
    });
    expect(noCancelable.action).toBe('cancelar_cita_no_cancelable');
    expect(telegram.sent.at(-1)?.texto).toContain('No puedo cancelar');

    await handle.db.delete(botConversations).where(eq(botConversations.direccion, direccion));
    await handle.db.delete(patientChannels).where(eq(patientChannels.patientId, patientId));
  }, 60_000);

  it('el corte de cancelación frena al paciente que ya confirmó (ADR 0057)', async () => {
    const patientId = globalThis.crypto.randomUUID();
    const direccion = `${direccionBase}K`;
    await linkChat(handle.db, { patientId, canal: 'telegram', direccion });

    // La clínica fija un corte de 3 días (ADR 0057).
    await updateNotificationSettings(handle.db, { patientCancelCutoffDays: 3 }, null);

    // **Dentro** del corte y ya confirmada: por chat no se cancela, hay que llamar.
    const dentro = unaCita({
      patientId,
      date: enDias(2),
      status: 'confirmada',
      confirmedAt: new Date().toISOString(),
      confirmedChannel: 'telegram',
    });
    clients.citas.push(dentro);
    const bloqueada = await enviar(telegram, {
      direccion,
      accion: `cancelar_cita:${dentro.id}`,
    });
    expect(bloqueada.action).toBe('cancelar_cita_bloqueada');
    expect(clients.canceladas.some((item) => item.id === dentro.id)).toBe(false);
    expect(telegram.sent.at(-1)?.texto).toContain('no se puede cancelar por aquí');

    // **Fuera** del corte (a 10 días) y confirmada: se cancela con normalidad.
    const fuera = unaCita({
      patientId,
      date: enDias(10),
      status: 'confirmada',
      confirmedAt: new Date().toISOString(),
      confirmedChannel: 'telegram',
    });
    clients.citas.push(fuera);
    const permitida = await enviar(telegram, { direccion, accion: `cancelar_cita:${fuera.id}` });
    expect(permitida.action).toBe('cancelar_cita_cancelada');
    expect(clients.canceladas.some((item) => item.id === fuera.id)).toBe(true);

    // **Sin confirmar** y dentro del corte: el paciente no había prometido nada,
    // así que se cancela igual (la guardia es solo para lo confirmado).
    const sinConfirmar = unaCita({ patientId, date: enDias(1), status: 'programada' });
    clients.citas.push(sinConfirmar);
    const libre = await enviar(telegram, {
      direccion,
      accion: `cancelar_cita:${sinConfirmar.id}`,
    });
    expect(libre.action).toBe('cancelar_cita_cancelada');
    expect(clients.canceladas.some((item) => item.id === sinConfirmar.id)).toBe(true);

    // Con el corte en 0 la regla queda apagada: la próxima confirmada se cancela.
    await updateNotificationSettings(handle.db, { patientCancelCutoffDays: 0 }, null);

    await handle.db.delete(botConversations).where(eq(botConversations.direccion, direccion));
    await handle.db.delete(patientChannels).where(eq(patientChannels.patientId, patientId));
  }, 60_000);

  it('la tabla de canales muestra el nombre del paciente (no solo su identificador)', async () => {
    const patientId = globalThis.crypto.randomUUID();
    const direccion = `${direccionBase}N`;
    await linkChat(handle.db, {
      patientId,
      canal: 'telegram',
      direccion,
      usuario: 'maria_perez',
    });

    // El nombre lo resuelve el servicio de pacientes por id, en lote.
    const original = clients.listPatientSummaries;
    clients.listPatientSummaries = async (ids) =>
      ids.includes(patientId) ? [unPaciente(patientId, `María Pérez ${MARK}`)] : [];

    try {
      const pagina = await channelsInInbox(handle.db, clients);
      const fila = pagina.items.find((item) => item.patientId === patientId);
      expect(fila?.patientName).toBe(`María Pérez ${MARK}`);
      // La dirección sigue enmascarada: el nombre no la destapa.
      expect(fila?.direccionMasked).not.toContain(direccion);
    } finally {
      clients.listPatientSummaries = original;
      await handle.db.delete(patientChannels).where(eq(patientChannels.patientId, patientId));
    }
  }, 30_000);

  it('la cancelación del bot no encola un «cita_cancelada» duplicado (ADR 0053)', async () => {
    // El asistente ya respondió al paciente en el mismo turno; el evento llega marcado
    // con `skipNotice` para que el consumidor **no** encole un segundo mensaje. El
    // bloque `notification` viaja intacto (lo leen pacientes, pantallas y reportes).
    const appointmentId = globalThis.crypto.randomUUID();
    const event = createDomainEvent({
      topic: EVENT_TOPICS.appointmentCancelled,
      aggregateId: appointmentId,
      producer: 'scheduling',
      payload: {
        appointment: { id: appointmentId, date: '2026-12-01', status: 'cancelada' },
        notification: {
          appointmentId,
          patientId: globalThis.crypto.randomUUID(),
          patientName: `Paciente ${MARK}`,
          patientPhone: null,
          ticket: '#000900',
          date: '2026-12-01',
          startTime: '09:00',
          endTime: '09:30',
          place: 'Consultorio',
          subject: 'Cita cancelada',
          body: 'Hola: tu cita quedó cancelada.',
          channel: 'telegram',
          templateKey: 'cita_cancelada',
          icsSequence: 0,
        },
        skipNotice: true,
      },
    });

    expect((await handleDomainEvent(handle.db, config, event)).status).toBe('ignorado');

    const filas = await handle.db
      .select()
      .from(notifications)
      .where(eq(notifications.appointmentId, appointmentId));
    expect(filas).toHaveLength(0);
  }, 30_000);

  it('si un servicio interno se cae, el paciente recibe aviso y sigue en su paso', async () => {
    const direccion = `${direccionBase}9`;
    await enviar(telegram, { direccion, texto: 'quiero una cita' });
    await enviar(telegram, { direccion, texto: 'Gabriel Astudillo' });
    await enviar(telegram, { direccion, accion: 'doc:V' });

    // El servicio de pacientes se está reiniciando: nadie escucha en su puerto.
    const original = clients.findPatientByDocument;
    const rechazo = new TypeError('fetch failed');
    (rechazo as { cause?: unknown }).cause = { code: 'ECONNREFUSED' };
    clients.findPatientByDocument = async () => {
      throw rechazo;
    };

    const entrante: InboundMessage = {
      canal: 'telegram',
      direccion,
      usuario: 'paciente-de-prueba',
      texto: '28139170',
      accion: null,
      eventoId: evento(900_000 + contador),
      recibidoEn: new Date().toISOString(),
    };

    try {
      // El fallo sigue subiendo: el bucle del canal tiene que enterarse y registrarlo.
      await expect(enviar(telegram, { direccion, texto: '28139170' })).rejects.toBeInstanceOf(
        TypeError,
      );
    } finally {
      clients.findPatientByDocument = original;
    }

    // Y el paciente no se queda sin respuesta: se le avisa y se le repite el paso.
    await avisarFalloAlPaciente(services, entrante);

    const respuestas = telegram.sent
      .filter((mensaje) => mensaje.direccion === direccion)
      .map((mensaje) => mensaje.texto);
    expect(respuestas.join('\n')).toContain('no puedo consultar el sistema');
    expect(respuestas.at(-1)).toContain('documento');

    // La conversación no se movió: reenviar el número la retoma donde estaba.
    const conversation = await loadConversation(handle.db, 'telegram', direccion, null);
    expect(conversation.state).toBe('documento');
    expect(conversation.draft.docType).toBe('V');
  }, 60_000);

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
      confirmedAt: null,
      confirmedChannel: null,
      cancelledAt: null,
      cancelledChannel: null,
      dentistId: null,
      chairId: null,
      chairLabel: null,
      dentistName: null,
      checkedInAt: null,
      startedAt: null,
      finishedAt: null,
      noShowReason: null,
      forceAttendedReason: null,
      clinicalSessionId: null,
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
      lugar: config.CLINIC_ADDRESS ?? '',
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
    /**
     * El aviso sale en **dos mensajes** (ADR 0052): el texto —con el nombre del
     * paciente y la invitación a confirmar— y después el calendario, que lleva un pie
     * corto porque el texto ya fue. WhatsApp no tiene botones, así que la invitación
     * viaja escrita dentro del propio texto.
     */
    expect(porWhatsApp[0]?.texto).toBe('Tu calendario');
    const textoDelAviso = whatsapp.sent.filter((message) => message.documento === undefined);
    expect(textoDelAviso.some((message) => message.texto.includes(appointment.patientName))).toBe(
      true,
    );
    expect(textoDelAviso.some((message) => message.texto.includes('«confirmar»'))).toBe(true);
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

  it('sin consultorio configurado el aviso de cita espera y luego sale con el lugar correcto', async () => {
    const patientId = globalThis.crypto.randomUUID();
    const appointmentId = globalThis.crypto.randomUUID();
    const direccion = `${direccionBase}8`;
    await linkChat(handle.db, { patientId, canal: 'whatsapp', direccion, usuario: 'paciente' });

    const appointment: AppointmentSummary = {
      id: appointmentId,
      requestId: null,
      ticket: '#000124',
      ticketNumber: 124,
      patientId,
      patientName: `Paciente ${MARK}`,
      patientDocument: 'V-12345678',
      patientPhone: '+584121234567',
      date: '2026-12-03',
      startTime: '09:00',
      endTime: '09:30',
      durationMinutes: 30,
      slotKind: 'franja',
      status: 'programada',
      callCount: 0,
      confirmedAt: null,
      confirmedChannel: null,
      cancelledAt: null,
      cancelledChannel: null,
      dentistId: null,
      chairId: null,
      chairLabel: null,
      dentistName: null,
      checkedInAt: null,
      startedAt: null,
      finishedAt: null,
      noShowReason: null,
      forceAttendedReason: null,
      clinicalSessionId: null,
      rescheduledFromId: null,
      rescheduledToId: null,
      icsSequence: 0,
      notes: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const record = await enqueue(handle.db, {
      patientId,
      patientName: appointment.patientName,
      appointmentId,
      templateKey: 'cita_confirmada',
      payload: {
        attachIcs: true,
        needsClinic: true,
        // Variables sin `lugar`: el lugar lo pone el envío (ADR 0058).
        variables: {
          paciente: appointment.patientName,
          fecha: '03/12/2026',
          hora: '9:00 a. m.',
          ticket: '#000124',
        },
        text: 'Hola: tu cita quedó lista.',
      },
      dedupeKey: `consultorio-prueba:${appointmentId}`,
    });
    expect(record).not.toBeNull();
    if (record === null) return;

    // 1) Sin configurar el consultorio: se difiere, sin gastar intentos.
    const sinConsultorio = loadNotificationsConfig({
      DATABASE_URL: databaseUrl,
      LOG_LEVEL: 'silent',
      TELEGRAM_MODE: 'simulado',
    });
    const primera = await processQueue(handle.db, registry, sinConsultorio, {
      appointmentLoader: async () => appointment,
    });
    expect(primera.deferred).toBeGreaterThanOrEqual(1);

    const [enEspera] = await handle.db
      .select()
      .from(notifications)
      .where(eq(notifications.id, record.id));
    expect(enEspera?.status).toBe('queued');
    expect(enEspera?.attempts).toBe(0);
    expect(enEspera?.lastError).toBe('consultorio sin configurar');

    // 2) Con el consultorio configurado (y vencido el plazo): sale, con el lugar re-renderizado.
    const segunda = await processQueue(handle.db, registry, config, {
      appointmentLoader: async () => appointment,
      now: new Date(Date.now() + 6 * 60_000),
    });
    expect(segunda.sent).toBeGreaterThanOrEqual(1);

    const [enviada] = await handle.db
      .select()
      .from(notifications)
      .where(eq(notifications.id, record.id));
    expect(enviada?.status).toBe('sent');
    const texto = typeof enviada?.payload['text'] === 'string' ? enviada.payload['text'] : '';
    expect(texto).toContain('Calle de prueba 123');

    // El `.ics` archivado lleva el `LOCATION` del registro.
    const ics = await ensureIcsArtifact(handle.db, config, appointment);
    expect(ics.content).toContain('LOCATION:Calle de prueba 123');

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

  it('el aviso a mano del botón «Notificar» también sale al paciente', async () => {
    const patientId = globalThis.crypto.randomUUID();
    const appointmentId = globalThis.crypto.randomUUID();
    const direccion = `${direccionBase}B`;
    await linkChat(handle.db, { patientId, canal: 'telegram', direccion });

    const appointment: AppointmentSummary = {
      id: appointmentId,
      requestId: null,
      ticket: '#000321',
      ticketNumber: 321,
      patientId,
      patientName: `Aviso a mano ${MARK}`,
      patientDocument: 'V-11111111',
      patientPhone: '+584121111111',
      date: '2026-12-09',
      startTime: '10:00',
      endTime: '10:30',
      durationMinutes: 30,
      slotKind: 'franja',
      status: 'notificada',
      callCount: 0,
      confirmedAt: null,
      confirmedChannel: null,
      cancelledAt: null,
      cancelledChannel: null,
      dentistId: null,
      chairId: null,
      chairLabel: null,
      dentistName: null,
      checkedInAt: null,
      startedAt: null,
      finishedAt: null,
      noShowReason: null,
      forceAttendedReason: null,
      clinicalSessionId: null,
      rescheduledFromId: null,
      rescheduledToId: null,
      icsSequence: 0,
      notes: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // Es exactamente lo que publica `notifyBatch` de la agenda al pulsar «Notificar».
    const avisoAMano = (reenvio: boolean): DomainEvent =>
      createDomainEvent({
        topic: EVENT_TOPICS.appointmentNotified,
        aggregateId: appointmentId,
        producer: 'scheduling',
        payload: {
          appointment: { id: appointmentId, date: appointment.date, status: 'notificada' },
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
            body: `Hola ${appointment.patientName}: tu cita quedó confirmada.`,
            channel: 'telegram',
            templateKey: 'cita_confirmada',
            icsSequence: 0,
            reenvio,
          },
        },
      });

    // 1) El aviso automático de la cita ya salió (como al formalizarla).
    const automatico = createDomainEvent({
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
          body: `Hola ${appointment.patientName}: tu cita quedó confirmada.`,
          channel: 'telegram',
          templateKey: 'cita_confirmada',
          icsSequence: 0,
        },
      },
    });
    expect((await handleDomainEvent(handle.db, config, automatico)).status).toBe('encolado');
    await processQueue(handle.db, registry, config, { appointmentLoader: async () => appointment });

    // 2) «Notificar» **no duplica** lo que ya se envió: el paciente no recibe dos.
    expect((await handleDomainEvent(handle.db, config, avisoAMano(false))).status).toBe(
      'duplicado',
    );
    expect((await handleDomainEvent(handle.db, config, avisoAMano(false))).status).toBe(
      'duplicado',
    );

    const filas = await handle.db
      .select()
      .from(notifications)
      .where(eq(notifications.patientId, patientId));
    expect(filas).toHaveLength(1);
    expect(filas[0]?.status).toBe('sent');

    // 3) Un aviso que **no llegó a salir** (falló) sí se recupera con «Notificar».
    await handle.db
      .update(notifications)
      .set({ status: 'failed', lastError: 'Telegram sendMessage falló: simulado' })
      .where(eq(notifications.patientId, patientId));
    expect((await handleDomainEvent(handle.db, config, avisoAMano(false))).status).toBe(
      'reintentado',
    );
    const recuperado = await processQueue(handle.db, registry, config, {
      appointmentLoader: async () => appointment,
    });
    expect(recuperado.sent).toBe(1);

    // 4) El reenvío explícito («reenviar también los ya notificados») sí manda otro.
    expect((await handleDomainEvent(handle.db, config, avisoAMano(true))).status).toBe('encolado');
    const reenviado = await processQueue(handle.db, registry, config, {
      appointmentLoader: async () => appointment,
    });
    expect(reenviado.sent).toBe(1);

    const avisos = await handle.db
      .select()
      .from(notifications)
      .where(eq(notifications.patientId, patientId));
    expect(avisos).toHaveLength(2);
    expect(avisos.every((aviso) => aviso.status === 'sent')).toBe(true);

    // Los tres envíos llevan el `.ics` de la cita.
    const enviados = telegram.sent.filter(
      (message) => message.direccion === direccion && message.documento !== undefined,
    );
    expect(enviados.length).toBeGreaterThanOrEqual(3);
    expect(enviados.at(-1)?.documento?.nombre).toBe('cita-000321.ics');

    await handle.db.delete(notifications).where(eq(notifications.patientId, patientId));
    await handle.db.delete(patientChannels).where(eq(patientChannels.patientId, patientId));
    await handle.db.execute(sql`delete from ics_artifacts where appointment_id = ${appointmentId}`);
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
