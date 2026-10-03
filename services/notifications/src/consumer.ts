import type { AppointmentStatus } from '@odontocrm/contracts';
import { EVENT_TOPICS, type DomainEvent } from '@odontocrm/events';
import { outboxEvents, toOutboxInsert } from '@odontocrm/db';
import { createDomainEvent } from '@odontocrm/events';

import type { NotificationsConfig } from './config.js';
import type { NotificationsDb } from './db/client.js';
import { enqueue, renderMessageFor, type EnqueueInput } from './messaging.js';

/** Datos que viajan en el evento de agenda para poder avisar al paciente. */
interface NotificationPayload {
  appointmentId: string;
  patientId: string;
  patientName: string;
  patientPhone: string | null;
  ticket: string | null;
  date: string;
  startTime: string;
  endTime: string;
  place: string;
  subject: string;
  body: string;
  channel: 'telegram';
  templateKey: string;
  icsSequence: number;
}

const readNotification = (event: DomainEvent): NotificationPayload | null => {
  const raw = event.payload['notification'];
  if (typeof raw !== 'object' || raw === null) return null;
  const candidate = raw as Partial<NotificationPayload>;
  if (
    typeof candidate.patientId !== 'string' ||
    typeof candidate.appointmentId !== 'string' ||
    typeof candidate.date !== 'string' ||
    typeof candidate.startTime !== 'string'
  ) {
    return null;
  }
  return candidate as NotificationPayload;
};

export interface ConsumeResult {
  status: 'encolado' | 'duplicado' | 'ignorado';
  templateKey?: string;
}

/**
 * Traduce los eventos de agenda en avisos para el paciente.
 *
 * Es aquí donde se cumple la decisión del 2026-10-03: **al formalizarse la cita**
 * (`scheduling.appointment.scheduled`) sale el mensaje con fecha, hora, lugar y el
 * `.ics` adjunto, sin esperar a ningún recordatorio. La clave de deduplicación
 * (`cita + plantilla + secuencia`) garantiza que un evento repetido no vuelva a
 * escribirle al paciente, y si no tiene Telegram vinculado el aviso queda como
 * **manual pendiente** para que la secretaría lo llame.
 */
export const handleDomainEvent = async (
  db: NotificationsDb,
  config: NotificationsConfig,
  event: DomainEvent,
): Promise<ConsumeResult> => {
  const templatesByTopic: Partial<Record<string, { key: string; attachIcs: boolean }>> = {
    [EVENT_TOPICS.appointmentScheduled]: { key: 'cita_confirmada', attachIcs: true },
    [EVENT_TOPICS.appointmentRescheduled]: { key: 'cita_reprogramada', attachIcs: true },
    [EVENT_TOPICS.appointmentCancelled]: { key: 'cita_cancelada', attachIcs: false },
  };

  const template = templatesByTopic[event.eventType];
  if (template === undefined) return { status: 'ignorado' };

  const payload = readNotification(event);
  if (payload === null) return { status: 'ignorado' };

  // Cancelar sin fecha/hora no tiene sentido avisarlo como reprogramación.
  const status: AppointmentStatus | null =
    typeof event.payload['appointment'] === 'object' &&
    event.payload['appointment'] !== null &&
    typeof (event.payload['appointment'] as { status?: unknown }).status === 'string'
      ? (event.payload['appointment'] as { status: AppointmentStatus }).status
      : null;

  const text =
    typeof event.payload['notification'] === 'object' &&
    typeof (event.payload['notification'] as { body?: unknown }).body === 'string'
      ? (event.payload['notification'] as { body: string }).body
      : await renderMessageFor(db, template.key, {
          paciente: payload.patientName,
          fecha: payload.date.split('-').reverse().join('/'),
          hora: payload.startTime,
          lugar: config.CLINIC_ADDRESS,
          ticket: payload.ticket ?? '—',
        });

  const input: EnqueueInput = {
    patientId: payload.patientId,
    patientName: payload.patientName,
    appointmentId: payload.appointmentId,
    templateKey: template.key,
    payload: {
      text,
      appointment: {
        id: payload.appointmentId,
        date: payload.date,
        startTime: payload.startTime,
        endTime: payload.endTime,
        ticket: payload.ticket,
        status: status ?? 'programada',
      },
      variables: {
        paciente: payload.patientName,
        fecha: payload.date.split('-').reverse().join('/'),
        hora: payload.startTime,
        lugar: config.CLINIC_ADDRESS,
        ticket: payload.ticket ?? '—',
      },
    },
    dedupeKey: `cita:${payload.appointmentId}:${template.key}:${String(payload.icsSequence)}`,
    text,
    attachIcs: template.attachIcs,
  };

  const record = await enqueue(db, input);
  return record === null
    ? { status: 'duplicado', templateKey: template.key }
    : { status: 'encolado', templateKey: template.key };
};

/**
 * Publica un evento del outbox propio (queda en la auditoría de identity). Se usa
 * para dejar rastro de cada aviso enviado o fallido.
 */
export const publishMessageEvent = async (
  db: NotificationsDb,
  input: {
    topic: (typeof EVENT_TOPICS)[keyof typeof EVENT_TOPICS];
    notificationId: string;
    payload: Record<string, unknown>;
  },
): Promise<void> => {
  await db.insert(outboxEvents).values(
    toOutboxInsert(
      createDomainEvent({
        topic: input.topic,
        aggregateId: input.notificationId,
        producer: 'notifications',
        payload: input.payload,
      }),
    ),
  );
};
