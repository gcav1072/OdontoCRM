import {
  formatTime12h,
  type AppointmentSummary,
  type NotificationSettings,
  type Paginated,
} from '@odontocrm/contracts';
import { eq, inArray, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadNotificationsConfig, type NotificationsConfig } from './config.js';
import { createNotificationsDatabase } from './db/client.js';
import { botConversations, notifications, patientChannels } from './db/schema.js';
import type { AppointmentInternalFilters, InternalClients } from './internal-client.js';
import { linkChat, notificationByDedupe, renderMessageFor, todayInClinic } from './messaging.js';
import { addCalendarDays, reminderDedupeKey, runAppointmentReminders } from './reminders.js';
import { updateNotificationSettings } from './settings.js';

/**
 * Recordatorios automáticos contra PostgreSQL real (Req 2, v1.2).
 *
 * La configuración se inyecta en el barrido para que las pruebas sean deterministas
 * (la fila `notification_settings` es única y la comparten otras suites). Se cubre:
 * apagado, ventana horaria de Caracas, idempotencia por `dedupeKey`, recordatorio
 * nuevo tras reprogramar y el trato de las citas confirmadas.
 */
const databaseUrl = process.env['TEST_NOTIFICATIONS_DATABASE_URL'];
const ready = databaseUrl !== undefined;
const describeWithDatabase = ready ? describe : describe.skip;

const MARK = `PRUEBA-RECORDATORIOS-${String(Date.now()).slice(-6)}`;

const unaCita = (overrides: Partial<AppointmentSummary> = {}): AppointmentSummary => ({
  id: globalThis.crypto.randomUUID(),
  requestId: null,
  ticket: null,
  ticketNumber: 0,
  patientId: globalThis.crypto.randomUUID(),
  patientName: `Paciente ${MARK}`,
  patientDocument: 'V-12345678',
  patientPhone: '+584121234567',
  date: '2026-11-14',
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
  createdAt: '2026-11-01T10:00:00.000Z',
  updatedAt: '2026-11-01T10:00:00.000Z',
  ...overrides,
});

/** Agenda de mentira con los mismos filtros que usa la ruta interna real. */
const fakeClients = (citas: AppointmentSummary[]): InternalClients =>
  ({
    listAppointments: async (
      filters: AppointmentInternalFilters,
    ): Promise<Paginated<AppointmentSummary>> => {
      const items = citas
        .filter((cita) => filters.from === undefined || cita.date >= filters.from)
        .filter((cita) => filters.to === undefined || cita.date <= filters.to)
        .filter((cita) => filters.status === undefined || cita.status === filters.status)
        .filter((cita) => filters.patientId === undefined || cita.patientId === filters.patientId);
      const page = filters.page ?? 1;
      const pageSize = filters.pageSize ?? 25;
      const inicio = (page - 1) * pageSize;
      return {
        items: items.slice(inicio, inicio + pageSize),
        total: items.length,
        page,
        pageSize,
        totalPages: Math.max(1, Math.ceil(items.length / pageSize)),
      };
    },
  }) as unknown as InternalClients;

const ajustes = (overrides: Partial<NotificationSettings> = {}): NotificationSettings => ({
  patientCancelCutoffDays: 0,
  reminderDaysBefore: 1,
  reminderSendHour: 9,
  reminderIncludeConfirmed: false,
  autoSendDocuments: false,
  updatedAt: null,
  updatedByUserId: null,
  ...overrides,
});

describeWithDatabase('recordatorios automáticos (PostgreSQL real)', () => {
  let handle: ReturnType<typeof createNotificationsDatabase>;
  let config: NotificationsConfig;
  const citas: AppointmentSummary[] = [];
  const pacienteIds: string[] = [];
  const canales: string[] = [];

  const conCanal = async (cita: AppointmentSummary): Promise<void> => {
    const direccion = `${MARK}-${String(canales.length)}`;
    await linkChat(handle.db, { patientId: cita.patientId, canal: 'telegram', direccion });
    pacienteIds.push(cita.patientId);
    canales.push(direccion);
  };

  const enVentana = new Date('2026-11-13T14:00:00Z'); // 10:00 en Caracas
  // Día objetivo de un recordatorio de 1 día: mañana en el consultorio.
  const objetivo1 = addCalendarDays(todayInClinic(enVentana), 1);

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
  }, 30_000);

  afterAll(async () => {
    if (!ready) return;
    const ids = [...new Set(pacienteIds)];
    if (ids.length > 0) {
      await handle.db.delete(notifications).where(inArray(notifications.patientId, ids));
    }
    await handle.db.delete(notifications).where(like(notifications.patientName, `%${MARK}%`));
    for (const direccion of canales) {
      await handle.db.delete(botConversations).where(eq(botConversations.direccion, direccion));
      await handle.db.delete(patientChannels).where(eq(patientChannels.direccion, direccion));
    }
    await handle.close();
  });

  it('con reminderDaysBefore = 0 no consulta la agenda ni encola nada', async () => {
    await updateNotificationSettings(handle.db, { reminderDaysBefore: 0 }, null);
    const resultado = await runAppointmentReminders(handle.db, fakeClients(citas), {
      now: enVentana,
      settings: ajustes({ reminderDaysBefore: 0 }),
    });
    expect(resultado.status).toBe('apagado');
    expect(resultado.encoladas).toBe(0);
  });

  it('antes de reminderSendHour no envía, y de madrugada tampoco', async () => {
    const temprano = new Date('2026-11-13T12:00:00Z'); // 08:00 en Caracas
    const antes = await runAppointmentReminders(handle.db, fakeClients(citas), {
      now: temprano,
      settings: ajustes({ reminderSendHour: 9 }),
    });
    expect(antes.status).toBe('fuera_de_ventana');

    const madrugada = new Date('2026-11-13T06:00:00Z'); // 02:00 en Caracas
    const noche = await runAppointmentReminders(handle.db, fakeClients(citas), {
      now: madrugada,
      settings: ajustes({ reminderSendHour: 7 }),
    });
    expect(noche.status).toBe('fuera_de_ventana');
  });

  it('dentro de la ventana encola el recordatorio del día objetivo una sola vez', async () => {
    const cita = unaCita({ date: objetivo1 });
    await conCanal(cita);
    citas.push(cita);

    const primera = await runAppointmentReminders(handle.db, fakeClients(citas), {
      now: enVentana,
      settings: ajustes(),
    });
    expect(primera.status).toBe('ok');
    expect(primera.targetDate).toBe(objetivo1);
    expect(primera.encoladas).toBe(1);

    const aviso = await notificationByDedupe(handle.db, reminderDedupeKey(cita, 1));
    expect(aviso).not.toBeNull();
    expect(aviso?.templateKey).toBe('cita_recordatorio');
    expect(aviso?.status).toBe('queued');
    const variables = aviso?.payload['variables'] as Record<string, string>;
    expect(variables['dias']).toBe('mañana');
    expect(variables['hora']).toBe(formatTime12h(cita.startTime));
    expect(aviso?.payload['offerActions']).toBe(true);

    // v1.2.2: el texto del recordatorio ofrece las **tres** acciones del paciente
    // (confirmar, posponer o cancelar definitivamente), que es lo que los botones y
    // las opciones numeradas ejecutan (ADR 0077).
    const cuerpo = await renderMessageFor(handle.db, 'cita_recordatorio', {
      paciente: cita.patientName,
      clinica: config.CLINIC_NAME ?? '',
      fecha: cita.date.split('-').reverse().join('/'),
      hora: formatTime12h(cita.startTime),
      dias: 'mañana',
      lugar: config.CLINIC_ADDRESS ?? '',
      ticket: cita.ticket ?? '—',
    });
    expect(cuerpo).toContain('confirmar tu asistencia');
    expect(cuerpo).toContain('posponer la cita para otro día');
    expect(cuerpo).toContain('cancelarla definitivamente');

    // Un segundo barrido (reinicio, ciclo siguiente) no duplica.
    const segunda = await runAppointmentReminders(handle.db, fakeClients(citas), {
      now: enVentana,
      settings: ajustes(),
    });
    expect(segunda.encoladas).toBe(0);
    expect(segunda.duplicadas).toBe(1);
  });

  it('una cita reprogramada recibe un recordatorio nuevo (cambia fecha y secuencia)', async () => {
    const cita = citas[0];
    if (cita === undefined) throw new Error('falta la cita del caso anterior');
    const objetivo2 = addCalendarDays(todayInClinic(enVentana), 2);
    const reprogramada = unaCita({
      id: cita.id,
      patientId: cita.patientId,
      date: objetivo2,
      icsSequence: 2,
    });
    const resultado = await runAppointmentReminders(handle.db, fakeClients([reprogramada]), {
      now: enVentana,
      settings: ajustes({ reminderDaysBefore: 2 }),
    });
    expect(resultado.targetDate).toBe(objetivo2);
    expect(resultado.encoladas).toBe(1);
    expect(
      await notificationByDedupe(handle.db, reminderDedupeKey(reprogramada, 2)),
    ).not.toBeNull();
  });

  it('las citas confirmadas se omiten salvo con reminderIncludeConfirmed', async () => {
    const confirmada = unaCita({
      date: objetivo1,
      status: 'confirmada',
      confirmedAt: '2026-11-10T12:00:00.000Z',
      confirmedChannel: 'telegram',
    });
    await conCanal(confirmada);
    citas.push(confirmada);

    const sinIncluir = await runAppointmentReminders(handle.db, fakeClients([confirmada]), {
      now: enVentana,
      settings: ajustes({ reminderIncludeConfirmed: false }),
    });
    expect(sinIncluir.encoladas).toBe(0);
    expect(await notificationByDedupe(handle.db, reminderDedupeKey(confirmada, 1))).toBeNull();

    const conIncluir = await runAppointmentReminders(handle.db, fakeClients([confirmada]), {
      now: enVentana,
      settings: ajustes({ reminderIncludeConfirmed: true }),
    });
    expect(conIncluir.encoladas).toBe(1);
    const aviso = await notificationByDedupe(handle.db, reminderDedupeKey(confirmada, 1));
    expect(aviso?.templateKey).toBe('cita_recordatorio_confirmada');
    // El recordatorio informativo no vuelve a pedir confirmación.
    expect(aviso?.payload['offerActions']).toBeUndefined();
  });

  it('las citas en sala o ya atendidas no reciben recordatorio', async () => {
    const enSala = unaCita({ date: objetivo1, status: 'en_sala_espera' });
    await conCanal(enSala);
    const resultado = await runAppointmentReminders(handle.db, fakeClients([enSala]), {
      now: enVentana,
      settings: ajustes({ reminderIncludeConfirmed: true }),
    });
    expect(resultado.evaluadas).toBe(0);
    expect(await notificationByDedupe(handle.db, reminderDedupeKey(enSala, 1))).toBeNull();
  });
});
