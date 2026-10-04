import {
  formatTicket,
  type AppointmentStatus,
  type RequestSummary,
  type SlotKind,
  type AppointmentSummary,
  type StatusHistoryEntry,
  type Channel,
  type RequestChannel,
} from '@odontocrm/contracts';

import type { AppointmentRequestRow, AppointmentRow, StatusHistoryRow } from './db/schema.js';

/** PostgreSQL devuelve `HH:MM:SS`; el resto del sistema trabaja con `HH:MM`. */
export const toHm = (time: string): string => time.slice(0, 5);

export const dayCount = (from: Date, to: Date): number =>
  Math.floor((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000));

export const toRequestSummary = (
  row: AppointmentRequestRow,
  options: { appointment?: AppointmentRow | null; now?: Date } = {},
): RequestSummary => {
  const now = options.now ?? new Date();
  const appointment = options.appointment ?? null;
  const ticket = formatTicket(row.ticketNumber);

  return {
    id: row.id,
    ticket: ticket.value,
    ticketNumber: row.ticketNumber,
    channel: row.channel as RequestChannel,
    patientId: row.patientId,
    patientName: row.patientName,
    patientDocument: row.patientDocument,
    patientPhone: row.patientPhone,
    reason: row.reason,
    status: row.status as AppointmentStatus,
    priority: row.priority,
    requestedAt: row.requestedAt.toISOString(),
    notes: row.notes,
    waitingDays: Math.max(0, dayCount(row.requestedAt, now)),
    appointmentId: appointment?.id ?? null,
    appointmentDate: appointment?.appointmentDate ?? null,
    appointmentTime: appointment === null ? null : toHm(appointment.startTime),
    createdAt: row.createdAt.toISOString(),
  };
};

export const toAppointmentSummary = (
  row: AppointmentRow,
  options: {
    request?: AppointmentRequestRow | null;
    rescheduledToId?: string | null;
  } = {},
): AppointmentSummary => {
  const request = options.request ?? null;
  const ticket = request === null ? null : formatTicket(request.ticketNumber);
  const startTime = toHm(row.startTime);
  const endTime = toHm(row.endTime);

  return {
    id: row.id,
    requestId: row.requestId,
    ticket: ticket?.value ?? null,
    ticketNumber: ticket?.number ?? null,
    patientId: row.patientId,
    patientName: row.patientName,
    patientDocument: row.patientDocument,
    patientPhone: row.patientPhone,
    date: row.appointmentDate,
    startTime,
    endTime,
    durationMinutes: row.durationMinutes,
    slotKind: row.slotKind as SlotKind,
    status: row.status as AppointmentStatus,
    callCount: row.callCount,
    dentistId: row.dentistId,
    chairId: row.chairId,
    checkedInAt: row.checkedInAt?.toISOString() ?? null,
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    noShowReason: row.noShowReason,
    forceAttendedReason: row.forceAttendedReason,
    clinicalSessionId: row.clinicalSessionId,
    rescheduledFromId: row.rescheduledFromId,
    rescheduledToId: options.rescheduledToId ?? null,
    icsSequence: row.icsSequence,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
};

export const toStatusHistoryEntry = (row: StatusHistoryRow): StatusHistoryEntry => ({
  id: row.id,
  entityType: row.entityType as 'request' | 'appointment',
  entityId: row.entityId,
  fromStatus: (row.fromStatus as AppointmentStatus | null) ?? null,
  toStatus: row.toStatus as AppointmentStatus,
  reason: row.reason,
  actorId: row.actorId,
  actorUsername: row.actorUsername,
  occurredAt: row.occurredAt.toISOString(),
});

/**
 * Estados que **ocupan** el día: cuentan para el cupo y bloquean su franja. Los
 * que liberan el hueco son `cancelada` y `reprogramada` (la cita se fue a otra
 * fecha, así que ese espacio vuelve a estar disponible).
 */
export const OCCUPYING_STATUSES: readonly AppointmentStatus[] = [
  'programada',
  'notificada',
  'en_sala_espera',
  'llamado',
  'en_consulta',
  'atendido',
  'no_asistio',
];

/** Canales por los que se puede avisar; el Telegram real llega en la Fase 4. */
export const NOTIFY_CHANNEL: Channel = 'telegram';
