import {
  formatTime12h,
  type AppointmentSummary,
  type NotificationSettings,
  type Paginated,
} from '@odontocrm/contracts';

import type { NotificationsDb } from './db/client.js';
import type { InternalClients } from './internal-client.js';
import { enqueue } from './messaging.js';
import { getNotificationSettings } from './settings.js';

/**
 * **Recordatorios automáticos `N` días antes de la cita** (Req 2, v1.2).
 *
 * El plan descarta un cron exacto a las 09:00 porque los consultorios apagan el
 * servidor de noche: un barrido periódico dentro de una **ventana diurna** recupera
 * el recordatorio en cuanto el servicio vuelve a estar en pie el mismo día. La
 * idempotencia la da el `dedupeKey`: `cita + fecha + secuencia del .ics + días`; si
 * la cita se reprograma cambian `date`/`icsSequence` y el recordatorio vuelve a salir.
 */

/** Tope de la ventana diurna: nunca se envía de madrugada (plan §6.3). */
export const REMINDER_WINDOW_END_HOUR = 21;

/** Estados de cita que reciben recordatorio (las confirmadas, solo si se pide). */
export const REMINDER_STATUSES = ['programada', 'notificada'] as const;

/** Suma días de calendario a una fecha `AAAA-MM-DD` (sin líos de zona horaria). */
export const addCalendarDays = (date: string, days: number): string => {
  const base = Date.parse(`${date}T00:00:00Z`);
  return new Date(base + days * 86_400_000).toISOString().slice(0, 10);
};

/** Hora local del consultorio (America/Caracas) en formato 0–23. */
export const hourInClinic = (now: Date = new Date()): number =>
  Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'America/Caracas',
      hour: '2-digit',
      hourCycle: 'h23',
    }).format(now),
  );

/** `"mañana"` para 1 día y `"en N días"` para el resto (marcador `{dias}`). */
export const diasDeAviso = (days: number): string =>
  days === 1 ? 'mañana' : `en ${String(days)} días`;

/**
 * Clave de idempotencia del recordatorio. Incluye la **secuencia del `.ics`**: si la
 * cita se reprograma, la secuencia (y/o la fecha) cambia y el paciente recibe el
 * recordatorio de su cita nueva, pero un reintento del mismo día no lo duplica.
 */
export const reminderDedupeKey = (cita: AppointmentSummary, days: number): string =>
  `recordatorio:${cita.id}:${cita.date}:${String(cita.icsSequence)}:d${String(days)}`;

export interface ReminderRunResult {
  /** `ok`: se revisó la agenda · `apagado`/`fuera_de_ventana`: no había nada que hacer. */
  status: 'ok' | 'apagado' | 'fuera_de_ventana';
  /** Fecha objetivo (`AAAA-MM-DD`): el día de las citas recordadas. */
  targetDate: string | null;
  /** Hora local del consultorio en el momento del barrido. */
  hour: number;
  evaluadas: number;
  encoladas: number;
  duplicadas: number;
}

const VACIO: Omit<ReminderRunResult, 'status' | 'hour' | 'targetDate'> = {
  evaluadas: 0,
  encoladas: 0,
  duplicadas: 0,
};

/**
 * Un barrido: mira las citas del día objetivo y encola su recordatorio si toca.
 *
 * Se ejecuta desde el temporizador de `index.ts` con guarda de reentrada. No lanza por
 * que la agenda esté reiniciándose: el siguiente ciclo lo reintenta.
 */
export const runAppointmentReminders = async (
  db: NotificationsDb,
  clients: InternalClients,
  options: { now?: Date; settings?: NotificationSettings } = {},
): Promise<ReminderRunResult> => {
  const now = options.now ?? new Date();
  const hour = hourInClinic(now);
  // La configuración se puede inyectar (pruebas deterministas sin tocar la fila
  // global); en producción siempre sale de `notification_settings`.
  const settings = options.settings ?? (await getNotificationSettings(db));

  if (settings.reminderDaysBefore <= 0) {
    return { status: 'apagado', targetDate: null, hour, ...VACIO };
  }
  if (hour < settings.reminderSendHour || hour >= REMINDER_WINDOW_END_HOUR) {
    return { status: 'fuera_de_ventana', targetDate: null, hour, ...VACIO };
  }

  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Caracas' }).format(now);
  const targetDate = addCalendarDays(today, settings.reminderDaysBefore);
  const estados: readonly string[] = settings.reminderIncludeConfirmed
    ? [...REMINDER_STATUSES, 'confirmada']
    : REMINDER_STATUSES;

  let page = 1;
  let hayMas = true;
  let evaluadas = 0;
  let encoladas = 0;
  let duplicadas = 0;

  while (hayMas) {
    const pagina: Paginated<AppointmentSummary> = await clients.listAppointments({
      from: targetDate,
      to: targetDate,
      page,
      pageSize: 100,
    });

    for (const cita of pagina.items) {
      if (!estados.includes(cita.status)) continue;
      evaluadas += 1;

      const confirmada = cita.status === 'confirmada';
      const record = await enqueue(db, {
        patientId: cita.patientId,
        patientName: cita.patientName,
        appointmentId: cita.id,
        templateKey: confirmada ? 'cita_recordatorio_confirmada' : 'cita_recordatorio',
        payload: {
          variables: {
            paciente: cita.patientName,
            fecha: cita.date.split('-').reverse().join('/'),
            hora: formatTime12h(cita.startTime),
            dias: diasDeAviso(settings.reminderDaysBefore),
            ticket: cita.ticket ?? '—',
          },
          // El nombre y la dirección del consultorio se re-renderizan al enviar.
          needsClinic: true,
        },
        dedupeKey: reminderDedupeKey(cita, settings.reminderDaysBefore),
        // Las confirmadas solo reciben un recordatorio informativo: no se les pide
        // que vuelvan a confirmar. En los canales sin botones, el resto recibe las
        // opciones numeradas de confirmar/cancelar.
        offerAppointmentActions: !confirmada,
      });

      if (record === null) {
        duplicadas += 1;
      } else {
        encoladas += 1;
      }
    }

    hayMas = page < pagina.totalPages;
    page += 1;
  }

  return { status: 'ok', targetDate, hour, evaluadas, encoladas, duplicadas };
};
