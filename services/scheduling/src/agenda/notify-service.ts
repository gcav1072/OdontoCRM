import {
  NOTIFIABLE_STATUSES,
  type AppointmentStatus,
  type AppointmentSummary,
  type NotifyBatch,
  type NotifyBatchInput,
  type NotifyBatchResult,
  type NotifyPreviewInput,
  type NotifyPreviewItem,
} from '@odontocrm/contracts';
import { EVENT_TOPICS } from '@odontocrm/events';
import { and, asc, count, eq, inArray, type SQL } from 'drizzle-orm';

import type { SchedulingConfig } from '../config.js';
import type { SchedulingDb } from '../db/client.js';
import { appointmentRequests, appointments, statusHistory } from '../db/schema.js';
import { toHm } from '../mappers.js';
import { buildAppointmentMessage } from './message.js';
import { getAppointment } from '../appointments/appointment-service.js';
import { assertCanTransition, todayInClinic, type ActorContext } from '../shared/context.js';
import { auditPayload, publish } from '../shared/events.js';

const selectionConditions = (
  date: string,
  appointmentIds: readonly string[] | undefined,
): SQL[] => {
  const conditions: SQL[] = [];
  if (appointmentIds !== undefined && appointmentIds.length > 0) {
    conditions.push(inArray(appointments.id, [...appointmentIds]));
  } else {
    conditions.push(eq(appointments.appointmentDate, date));
  }
  // Las citas canceladas o ya atendidas no se avisan. `confirmada` **sí** entra: la
  // vista previa tiene que encontrarla para poder decir «esta ya la confirmó el
  // paciente» en vez de no listarla siquiera.
  conditions.push(
    inArray(appointments.status, [
      'programada',
      'notificada',
      'confirmada',
      'en_sala_espera',
      'llamado',
    ] as const),
  );
  return conditions;
};

/**
 * Vista previa del lote de avisos: **exactamente** los mensajes que se enviarán,
 * con los que no saldrán y por qué. El texto se arma con la plantilla canónica del
 * contrato, así que es el mismo que usará el servicio de notificaciones.
 */
export const notifyPreview = async (
  db: SchedulingDb,
  input: NotifyPreviewInput,
  config: SchedulingConfig,
  options: { force: boolean; now?: Date },
): Promise<NotifyBatch> => {
  const date = input.date ?? todayInClinic(options.now ?? new Date());
  const rows = await db
    .select()
    .from(appointments)
    .where(and(...selectionConditions(date, input.appointmentIds)))
    .orderBy(asc(appointments.appointmentDate), asc(appointments.startTime));

  const requestIds = [
    ...new Set(rows.map((row) => row.requestId).filter((id): id is string => id !== null)),
  ];
  const requests =
    requestIds.length === 0
      ? []
      : await db
          .select()
          .from(appointmentRequests)
          .where(inArray(appointmentRequests.id, requestIds));
  const requestById = new Map(requests.map((request) => [request.id, request]));

  const items: NotifyPreviewItem[] = rows.map((row) => {
    const request = row.requestId === null ? null : (requestById.get(row.requestId) ?? null);
    const message = buildAppointmentMessage(row, request, config);
    const status = row.status as AppointmentStatus;
    const notifiable = NOTIFIABLE_STATUSES.includes(status);
    const alreadyNotified = status !== 'programada';
    const willSend = notifiable && (options.force || !alreadyNotified);

    return {
      appointmentId: row.id,
      ticket: message.ticket,
      patientId: row.patientId,
      patientName: row.patientName,
      patientPhone: row.patientPhone,
      channel: message.channel,
      date: row.appointmentDate,
      startTime: message.startTime,
      endTime: message.endTime,
      place: message.place,
      subject: message.subject,
      body: message.body,
      willSend,
      skipReason: willSend
        ? null
        : notifiable
          ? 'ya se había notificado (marca «reenviar» si quieres repetirlo)'
          : `la cita está en «${status}»`,
    };
  });

  return {
    date,
    count: items.length,
    willSendCount: items.filter((item) => item.willSend).length,
    items,
  };
};

/**
 * Marca el lote como notificado y publica un evento por cita con el mensaje ya
 * redactado. El **envío lo hace el servicio de notificaciones** al consumir
 * `scheduling.appointment.notified` (con reintentos y el `.ics` adjunto); aquí
 * queda trazado en `status_history` y auditado.
 */
export const notifyBatch = async (
  db: SchedulingDb,
  input: NotifyBatchInput,
  actor: ActorContext,
  config: SchedulingConfig,
): Promise<NotifyBatchResult> => {
  const preview = await notifyPreview(db, input, config, { force: input.force });
  const pending = preview.items.filter((item) => item.willSend);

  for (const item of pending) {
    const rows = await db
      .select({ status: appointments.status })
      .from(appointments)
      .where(eq(appointments.id, item.appointmentId))
      .limit(1);
    const current = rows[0];
    if (current !== undefined) {
      assertCanTransition(current.status as AppointmentStatus, 'notificada', actor);
    }
  }

  const notified: AppointmentSummary[] = [];
  if (pending.length > 0) {
    await db.transaction(async (tx) => {
      for (const item of pending) {
        const rows = await tx
          .select()
          .from(appointments)
          .where(eq(appointments.id, item.appointmentId))
          .limit(1);
        const row = rows[0];
        if (row === undefined) continue;

        await tx
          .update(appointments)
          .set({ status: 'notificada', updatedAt: new Date() })
          .where(eq(appointments.id, row.id));

        await tx.insert(statusHistory).values({
          entityType: 'appointment',
          entityId: row.id,
          fromStatus: row.status,
          toStatus: 'notificada',
          reason: input.force ? 'aviso reenviado' : 'aviso encolado para el paciente',
          actorId: actor.actorId,
          actorUsername: actor.actorUsername,
        });

        const request =
          row.requestId === null
            ? null
            : ((
                await tx
                  .select()
                  .from(appointmentRequests)
                  .where(eq(appointmentRequests.id, row.requestId))
                  .limit(1)
              )[0] ?? null);

        await publish(tx, {
          topic: EVENT_TOPICS.appointmentNotified,
          aggregateId: row.id,
          actor,
          payload: {
            ...auditPayload({
              entityType: 'appointment',
              entityId: row.id,
              action: 'appointment_notified',
              summary: `Aviso preparado para ${row.patientName} (${item.date} ${item.startTime})`,
              changedFields: ['status'],
              before: { status: row.status },
              after: { status: 'notificada' },
              reason: input.force ? 'reenvío del aviso' : null,
              actor,
            }),
            appointment: {
              id: row.id,
              date: row.appointmentDate,
              startTime: toHm(row.startTime),
              endTime: toHm(row.endTime),
              status: 'notificada',
              requestId: row.requestId,
            },
            // Con esto el servicio de notificaciones envía el mensaje y el .ics.
            // `reenvio` distingue «asegura que salga» de «mándalo otra vez».
            notification: {
              ...buildAppointmentMessage(row, request, config),
              subject: item.subject,
              body: item.body,
              willSend: true,
              reenvio: input.force,
            },
          },
        });
      }
    });

    for (const item of pending) notified.push(await getAppointment(db, item.appointmentId));
  }

  return {
    date: preview.date,
    notified: notified.length,
    skipped: preview.count - notified.length,
    appointments: notified,
  };
};

/** Cuántas citas hay pendientes de aviso en una fecha (para el botón de la jornada). */
export const pendingNotificationCount = async (db: SchedulingDb, date: string): Promise<number> => {
  const rows = await db
    .select({ value: count() })
    .from(appointments)
    .where(
      and(
        eq(appointments.appointmentDate, date),
        inArray(appointments.status, ['programada'] as const),
      ),
    );
  return rows[0]?.value ?? 0;
};
