import type { AppointmentStatus } from '@odontocrm/contracts';
import { EVENT_TOPICS, type DomainEvent } from '@odontocrm/events';
import { outboxEvents, toOutboxInsert } from '@odontocrm/db';
import { createDomainEvent } from '@odontocrm/events';
import { ConflictError, NotFoundError } from '@odontocrm/kernel';

import type { NotificationsConfig } from './config.js';
import type { NotificationsDb } from './db/client.js';
import { sendDocumentNotification } from './documents.js';
import type { InternalClients } from './internal-client.js';
import {
  enqueue,
  findChannel,
  notificationByDedupe,
  renderMessageFor,
  retryNotification,
  type EnqueueInput,
} from './messaging.js';
import { getNotificationSettings } from './settings.js';

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
  /** `true` cuando la secretaría pidió reenviar a los ya notificados. */
  reenvio?: boolean;
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
  /**
   * `encolado`: aviso nuevo en la cola · `reintentado`: ya existía y no había
   * salido, así que vuelve a la cola · `duplicado`: ya se envió, no se repite ·
   * `ignorado`: el evento no es de los que producen avisos.
   */
  status: 'encolado' | 'reintentado' | 'duplicado' | 'ignorado';
  templateKey?: string;
}

/** Documento digital que anuncia un evento de emisión (Req 5, v1.2). */
interface DocumentoDeEvento {
  kind: 'prescription' | 'invoice' | 'receipt';
  entityId: string;
  /** `null` en `paymentReceived` viejo: se resuelve con los metadatos del cobro. */
  patientId: string | null;
}

const registro = (valor: unknown): valor is Record<string, unknown> =>
  typeof valor === 'object' && valor !== null && !Array.isArray(valor);

/**
 * ¿Este evento anuncia un documento que se puede mandar por chat? (Req 5)
 *
 * Es **aditivo**: los temas ya publicados por clinical/billing no cambian de forma.
 * Si el paciente no tiene chat o el consultorio no activó el envío automático, el
 * evento se ignora y no se crea una fila `skipped_no_channel` en la bandeja: el
 * envío automático es un extra silencioso, no una tarea de secretaría.
 */
const documentoDeEvento = (event: DomainEvent): DocumentoDeEvento | null => {
  if (event.eventType === EVENT_TOPICS.prescriptionIssued) {
    const prescription = event.payload['prescription'];
    if (!registro(prescription)) return null;
    const id = prescription['id'];
    const patientId = prescription['patientId'];
    if (typeof id !== 'string' || typeof patientId !== 'string') return null;
    return { kind: 'prescription', entityId: id, patientId };
  }
  if (event.eventType === EVENT_TOPICS.invoiceIssued) {
    const invoice = event.payload['invoice'];
    if (!registro(invoice)) return null;
    const id = invoice['invoiceId'];
    const patientId = invoice['patientId'];
    if (typeof id !== 'string' || typeof patientId !== 'string') return null;
    return { kind: 'invoice', entityId: id, patientId };
  }
  if (event.eventType === EVENT_TOPICS.paymentReceived) {
    const payment = event.payload['payment'];
    if (!registro(payment)) return null;
    const id = payment['paymentId'];
    if (typeof id !== 'string') return null;
    const patientId =
      typeof payment['patientId'] === 'string' ? (payment['patientId'] as string) : null;
    return { kind: 'receipt', entityId: id, patientId };
  }
  return null;
};

/**
 * Traduce los eventos de agenda en avisos para el paciente.
 *
 * Es aquí donde se cumple la decisión del 2026-10-03: **al formalizarse la cita**
 * (`scheduling.appointment.scheduled`) sale el mensaje con fecha, hora, lugar y el
 * `.ics` adjunto, sin esperar a ningún recordatorio. La clave de deduplicación
 * (`cita + plantilla + secuencia`) garantiza que un evento repetido no vuelva a
 * escribirle al paciente, y si no tiene canal vinculado el aviso queda como
 * **manual pendiente** para que la secretaría lo llame.
 *
 * El **aviso a mano** del botón «Notificar» de `/programacion`
 * (`scheduling.appointment.notified`) también llega aquí: se deduplica por **su
 * evento**, así un reintento de la cola no repite el mensaje y un reenvío pedido a
 * propósito (otro evento) sí sale.
 */
export const handleDomainEvent = async (
  db: NotificationsDb,
  config: NotificationsConfig,
  event: DomainEvent,
  deps: { clients?: InternalClients } = {},
): Promise<ConsumeResult> => {
  // ── v1.2 · Envío automático opcional de documentos (Req 5) ────────────────
  const documento = documentoDeEvento(event);
  if (documento !== null) {
    const settings = await getNotificationSettings(db);
    if (!settings.autoSendDocuments) return { status: 'ignorado' };
    const clients = deps.clients;
    if (clients === undefined) return { status: 'ignorado' };

    let patientId = documento.patientId;
    if (patientId === null) {
      // `paymentReceived` puede venir de un emisor anterior a v1.2: se resuelve el
      // paciente por los metadatos del cobro (factura padre).
      const meta = await clients.getPaymentMeta(documento.entityId);
      patientId = meta?.patientId ?? null;
    }
    if (patientId === null) return { status: 'ignorado' };
    // **Regla anti-ruido estricta**: sin chat vinculado no se encola ni se deja una
    // fila de llamada manual; el envío automático solo actúa cuando puede cumplirse.
    if ((await findChannel(db, patientId)) === null) return { status: 'ignorado' };

    const resultado = await (async () => {
      try {
        return await sendDocumentNotification(db, clients, {
          kind: documento.kind,
          entityId: documento.entityId,
          patientId,
          // Idempotencia por evento: un reintento de la cola de eventos no vuelve a
          // encolar el mismo documento.
          clientRequestId: event.eventId,
        });
      } catch (error) {
        // El documento pudo anularse entre la emisión y el consumo: no es un fallo
        // del consumidor ni debe reintentarse; simplemente no se envía.
        if (error instanceof NotFoundError || error instanceof ConflictError) return null;
        throw error;
      }
    })();
    if (resultado === null) return { status: 'ignorado' };
    return {
      status: resultado.status === 'queued' ? 'encolado' : 'duplicado',
      templateKey:
        documento.kind === 'prescription'
          ? 'documento_recipe'
          : documento.kind === 'invoice'
            ? 'documento_factura'
            : 'documento_recibo',
    };
  }

  const templatesByTopic: Partial<
    Record<string, { key: string; attachIcs: boolean; needsClinic: boolean; manual?: boolean }>
  > = {
    [EVENT_TOPICS.appointmentScheduled]: {
      key: 'cita_confirmada',
      attachIcs: true,
      needsClinic: true,
    },
    [EVENT_TOPICS.appointmentRescheduled]: {
      key: 'cita_reprogramada',
      attachIcs: true,
      needsClinic: true,
    },
    [EVENT_TOPICS.appointmentCancelled]: {
      key: 'cita_cancelada',
      attachIcs: false,
      needsClinic: false,
    },
    // El botón «Notificar» de /programacion: **asegura** que el aviso salga.
    [EVENT_TOPICS.appointmentNotified]: {
      key: 'cita_confirmada',
      attachIcs: true,
      needsClinic: true,
      manual: true,
    },
  };

  const template = templatesByTopic[event.eventType];
  if (template === undefined) return { status: 'ignorado' };

  const payload = readNotification(event);
  if (payload === null) return { status: 'ignorado' };

  // El bot ya respondió al paciente en el mismo turno (ADR 0053): la cancelación hecha
  // por el paciente llega marcada para que **no** se encole un `cita_cancelada`
  // duplicado. El bloque `notification` sigue completo para los demás consumidores
  // (pacientes, pantallas y reportes), que leen el evento entero.
  if (event.payload['skipNotice'] === true) return { status: 'ignorado' };

  // Cancelar sin fecha/hora no tiene sentido avisarlo como reprogramación.
  const status: AppointmentStatus | null =
    typeof event.payload['appointment'] === 'object' &&
    event.payload['appointment'] !== null &&
    typeof (event.payload['appointment'] as { status?: unknown }).status === 'string'
      ? (event.payload['appointment'] as { status: AppointmentStatus }).status
      : null;

  /**
   * Variables del aviso **sin el lugar**: el lugar (y el nombre del consultorio) se
   * re-renderizan al enviar, porque el aviso puede encolarse antes de que el titular
   * complete el registro —o el consultorio cambiar de dirección— y el texto no debe
   * quedar con un dato viejo o vacío.
   */
  const variables: Record<string, string> = {
    paciente: payload.patientName,
    fecha: payload.date.split('-').reverse().join('/'),
    hora: payload.startTime,
    ticket: payload.ticket ?? '—',
  };

  const text =
    typeof event.payload['notification'] === 'object' &&
    typeof (event.payload['notification'] as { body?: unknown }).body === 'string'
      ? (event.payload['notification'] as { body: string }).body
      : await renderMessageFor(db, template.key, {
          ...variables,
          lugar: config.CLINIC_ADDRESS ?? '',
        });

  /**
   * Un reenvío pedido a propósito («reenviar también los ya notificados») es un
   * aviso nuevo y se identifica por **su evento**, así que sale otra vez.
   */
  const reenvio = template.manual === true && payload.reenvio === true;

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
      variables,
      needsClinic: template.needsClinic,
    },
    // Salvo reenvío, la clave es la de siempre (cita + plantilla + secuencia del
    // `.ics`): así una reprogramación avisa, un reintento de la cola no repite y
    // el botón «Notificar» **no duplica** lo que ya salió.
    dedupeKey: reenvio
      ? `aviso:${payload.appointmentId}:${template.key}:${event.eventId}`
      : `cita:${payload.appointmentId}:${template.key}:${String(payload.icsSequence)}`,
    text,
    attachIcs: template.attachIcs,
    /**
     * En canales sin botones, el aviso de cita termina con las opciones numeradas de
     * confirmar/cancelar (v1.2, §2.3.4). No se ofrecen en una cancelación ni en el
     * reenvío de una cita que el paciente ya confirmó (no tiene sentido pedirle que
     * vuelva a confirmar).
     */
    offerAppointmentActions:
      template.attachIcs && (status === 'programada' || status === 'notificada' || status === null),
  };

  const record = await enqueue(db, input);
  if (record !== null) return { status: 'encolado', templateKey: template.key };

  // Ya existía. Si el botón «Notificar» lo pide y **no llegó a salir** (no había
  // canal, o falló), se vuelve a poner en cola: es la promesa de ese botón.
  if (template.manual === true && !reenvio) {
    const anterior = await notificationByDedupe(db, input.dedupeKey);
    if (anterior !== null && anterior.status !== 'sent' && anterior.status !== 'sending') {
      await retryNotification(db, anterior.id, 'pedido de nuevo desde la programación');
      return { status: 'reintentado', templateKey: template.key };
    }
  }

  return { status: 'duplicado', templateKey: template.key };
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
