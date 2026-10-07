/**
 * Catálogo de eventos de dominio (docs/PLAN_MAESTRO_FASES.md §7).
 * Convención: `<dominio>.<entidad>.<acción>` en pasado.
 * Los eventos se publican por el patrón *outbox* en la misma transacción que el
 * cambio de datos y `pg-boss` los entrega a los consumidores.
 */
export const EVENT_TOPICS = {
  userCreated: 'identity.user.created',
  userUpdated: 'identity.user.updated',
  userDeactivated: 'identity.user.deactivated',
  sessionLogin: 'identity.session.login',
  sessionLoginFailed: 'identity.session.login_failed',
  sessionLogout: 'identity.session.logout',

  patientCreated: 'patients.patient.created',
  patientUpdated: 'patients.patient.updated',
  patientDeleted: 'patients.patient.deleted',
  patientFileUploaded: 'patients.file.uploaded',

  requestCreated: 'scheduling.request.created',
  requestCancelled: 'scheduling.request.cancelled',
  capacityChanged: 'scheduling.capacity.changed',
  appointmentScheduled: 'scheduling.appointment.scheduled',
  appointmentRescheduled: 'scheduling.appointment.rescheduled',
  appointmentCancelled: 'scheduling.appointment.cancelled',
  appointmentNotified: 'scheduling.appointment.notified',
  appointmentCheckedIn: 'scheduling.appointment.checked_in',
  appointmentCalled: 'scheduling.appointment.called',
  appointmentInConsultation: 'scheduling.appointment.in_consultation',
  appointmentAttended: 'scheduling.appointment.attended',
  appointmentNoShow: 'scheduling.appointment.no_show',
  overbookAuthorized: 'scheduling.overbook.authorized',

  messageSent: 'notifications.message.sent',
  messageFailed: 'notifications.message.failed',
  patientChannelLinked: 'notifications.patient_channel.linked',

  recordCreated: 'clinical.record.created',
  recordUpdated: 'clinical.record.updated',
  recordSigned: 'clinical.record.signed',
  recordAmended: 'clinical.record.amended',
  sessionCreated: 'clinical.session.created',
  sessionClosed: 'clinical.session.closed',
  sessionAmended: 'clinical.session.amended',
  sessionFileUploaded: 'clinical.session.file_uploaded',
  sessionFileRemoved: 'clinical.session.file_removed',
  prescriptionIssued: 'clinical.prescription.issued',
  prescriptionReprinted: 'clinical.prescription.reprinted',
  prescriptionAnnulled: 'clinical.prescription.annulled',

  toothFindingRecorded: 'odontogram.finding.recorded',
  toothFindingRemoved: 'odontogram.finding.removed',

  /**
   * Facturación y pagos (Fase 11, ADR 0044–0048). El **borrador no publica evento**: es un acto
   * interno que se puede descartar, así que el acto de dinero nace al emitir.
   */
  invoiceIssued: 'billing.invoice.issued',
  invoiceVoided: 'billing.invoice.voided',
  /** Reimprimir o descargar el papel archivado: se cuenta y queda en la auditoría (ADR 0048). */
  invoicePrinted: 'billing.invoice.printed',
  invoicePaid: 'billing.invoice.paid',
  paymentReceived: 'billing.payment.received',
  paymentPrinted: 'billing.payment.printed',
  paymentVoided: 'billing.payment.voided',
  creditNoteIssued: 'billing.credit_note.issued',
  rateSet: 'billing.rate.set',
  /**
   * Alta de un lote de formas libres autorizado. No está en la tabla del §3.5 del plan —que resume los
   * actos de dinero—, pero es un acto **fiscal** con rango y providencia: tiene que quedar auditado.
   */
  formsRegistered: 'billing.forms.registered',
  catalogItemChanged: 'billing.catalog.item_changed',
} as const;

export type EventTopic = (typeof EVENT_TOPICS)[keyof typeof EVENT_TOPICS];

export const EVENT_TOPIC_VALUES: readonly EventTopic[] = Object.values(EVENT_TOPICS);

/** Cola de `pg-boss` donde se entregan todos los eventos de dominio. */
export const DOMAIN_EVENTS_QUEUE = 'domain-events';

/** Servicios que pueden publicar o consumir eventos. */
export const SERVICE_NAMES = [
  'gateway',
  'identity',
  'patients',
  'scheduling',
  'notifications',
  'clinical',
  'odontogram',
  'screens',
  'reporting',
  'billing',
] as const;

export type ServiceName = (typeof SERVICE_NAMES)[number];
