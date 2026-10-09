import {
  APPOINTMENT_CONFIRMATION_TEMPLATE,
  APPOINTMENT_CONFIRMATION_TEMPLATE_KEY,
  formatTicket,
  formatTime12h,
  renderTemplate,
} from '@odontocrm/contracts';

import type { SchedulingConfig } from '../config.js';
import type { AppointmentRequestRow, AppointmentRow } from '../db/schema.js';
import { toHm } from '../mappers.js';

/** Fecha `AAAA-MM-DD` como `dd/mm/aaaa`, que es como se lee y se dicta aquí. */
export const formatDateVe = (date: string): string => {
  const [year = '', month = '', day = ''] = date.split('-');
  return `${day}/${month}/${year}`;
};

/**
 * Todo lo que necesita el servicio de notificaciones para avisar al paciente: en
 * la Fase 4 se envía por Telegram con el `.ics` adjunto. El mensaje se arma aquí
 * con la plantilla canónica del contrato para que la vista previa del lote sea
 * **exactamente** el texto que se enviará.
 */
export interface AppointmentMessagePayload {
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
  /**
   * Motivo de la consulta tal como lo escribió el paciente. No se usa en el
   * mensaje, pero viaja con el evento para que la pantalla del consultorio (Fase
   * 5) lo muestre sin tener que leer la base de la agenda.
   */
  reason: string | null;
}

export const buildAppointmentMessage = (
  appointment: AppointmentRow,
  request: AppointmentRequestRow | null,
  config: Pick<SchedulingConfig, 'CLINIC_ADDRESS'>,
): AppointmentMessagePayload => {
  const startTime = toHm(appointment.startTime);
  const ticket = request === null ? null : formatTicket(request.ticketNumber).value;

  const body = renderTemplate(APPOINTMENT_CONFIRMATION_TEMPLATE.body, {
    paciente: appointment.patientName,
    fecha: formatDateVe(appointment.appointmentDate),
    hora: formatTime12h(startTime),
    lugar: config.CLINIC_ADDRESS ?? '',
    ticket: ticket ?? '—',
  });

  return {
    appointmentId: appointment.id,
    patientId: appointment.patientId,
    patientName: appointment.patientName,
    patientPhone: appointment.patientPhone,
    ticket,
    date: appointment.appointmentDate,
    startTime,
    endTime: toHm(appointment.endTime),
    place: config.CLINIC_ADDRESS ?? '',
    subject: APPOINTMENT_CONFIRMATION_TEMPLATE.subject,
    body,
    channel: 'telegram',
    templateKey: APPOINTMENT_CONFIRMATION_TEMPLATE_KEY,
    icsSequence: appointment.icsSequence,
    reason: request?.reason ?? null,
  };
};
