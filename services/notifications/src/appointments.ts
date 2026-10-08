import type {
  AppointmentNotificationFilters,
  AppointmentNotificationItem,
  AppointmentSummary,
  Channel,
  ChannelId,
  NotificationStatus,
  Paginated,
} from '@odontocrm/contracts';
import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm';

import type { NotificationsDb } from './db/client.js';
import { notifications, patientChannels } from './db/schema.js';
import type { InternalClients } from './internal-client.js';
import { maskDireccion, todayInClinic } from './messaging.js';

/**
 * La **sección de citas** de la bandeja (ADR 0052): las próximas citas del
 * consultorio con lo que hace falta para avisar al paciente —su canal de Telegram o
 * WhatsApp— y el estado del último aviso y de la confirmación.
 *
 * Se compone **aquí** y no en la interfaz a propósito: cruzar la agenda, los canales
 * vinculados y la cola de envíos en el navegador serían tres consultas con tres
 * paginaciones que no encajan entre sí. La agenda se pregunta por su ruta interna
 * (el servicio ya habla con ella para los avisos) y el resto sale de la base propia.
 */

/** Orden de preferencia para escribirle a un paciente: Telegram y luego WhatsApp. */
const rangoDeCanal = (canal: string): number => {
  if (canal === 'telegram') return 0;
  if (canal === 'whatsapp') return 1;
  return 2;
};

/**
 * ¿Es un canal por el que el asistente puede escribir? `patient_channels` admite
 * canales «de oficina» (`registro`, `presencial`) que no sirven para avisar y que
 * aquí solo confundirían la columna.
 */
const canalAtendido = (canal: string): canal is ChannelId =>
  canal === 'telegram' || canal === 'whatsapp';

const toItem = (
  cita: AppointmentSummary,
  canal: { canal: ChannelId; direccion: string } | null,
  aviso: {
    id: string;
    templateKey: string;
    channel: string;
    status: string;
    sentAt: Date | null;
    manualNote: string | null;
    contactedAt: Date | null;
  } | null,
): AppointmentNotificationItem => ({
  appointmentId: cita.id,
  patientId: cita.patientId,
  patientName: cita.patientName,
  patientDocument: cita.patientDocument,
  patientPhone: cita.patientPhone,
  ticket: cita.ticket,
  date: cita.date,
  startTime: cita.startTime,
  endTime: cita.endTime,
  status: cita.status,
  confirmedAt: cita.confirmedAt,
  confirmedChannel: cita.confirmedChannel,
  channel: canal?.canal ?? null,
  // Enmascarada: la dirección de verdad no circula por la interfaz, solo se usa
  // para enviar. Un «0412••••67» basta para saber que hay por dónde avisar.
  direccionMasked: canal === null ? null : maskDireccion(canal.direccion),
  lastNotification:
    aviso === null
      ? null
      : {
          id: aviso.id,
          templateKey: aviso.templateKey,
          channel: aviso.channel as Channel,
          status: aviso.status as NotificationStatus,
          sentAt: aviso.sentAt?.toISOString() ?? null,
          manualNote: aviso.manualNote,
          contactedAt: aviso.contactedAt?.toISOString() ?? null,
        },
});

export const appointmentsInInbox = async (
  db: NotificationsDb,
  clients: InternalClients,
  filters: AppointmentNotificationFilters,
): Promise<Paginated<AppointmentNotificationItem>> => {
  // Sin fecha de inicio se muestran las que quedan por delante: la sección nace para
  // «avisar de lo que viene», no para revisar el histórico (eso ya está en la bandeja
  // de envíos, con sus propios filtros).
  const pagina = await clients.listAppointments({
    ...filters,
    from: filters.from ?? todayInClinic(),
  });
  if (pagina.items.length === 0) return { ...pagina, items: [] };

  const patientIds = [...new Set(pagina.items.map((cita) => cita.patientId))];
  const appointmentIds = pagina.items.map((cita) => cita.id);

  const [canales, avisos] = await Promise.all([
    db
      .select()
      .from(patientChannels)
      .where(
        and(
          inArray(patientChannels.patientId, patientIds),
          isNotNull(patientChannels.direccion),
          eq(patientChannels.isBlocked, false),
        ),
      ),
    db
      .select()
      .from(notifications)
      .where(inArray(notifications.appointmentId, appointmentIds))
      .orderBy(desc(notifications.createdAt)),
  ]);

  // Un canal por paciente, con la misma preferencia que usa el envío real: si tiene
  // los dos vinculados se mira Telegram, que es donde el paciente ya conversa.
  const canalPorPaciente = new Map<string, { canal: ChannelId; direccion: string }>();
  for (const fila of canales) {
    if (fila.direccion === null || !canalAtendido(fila.channel)) continue;
    const actual = canalPorPaciente.get(fila.patientId);
    if (actual === undefined || rangoDeCanal(fila.channel) < rangoDeCanal(actual.canal)) {
      canalPorPaciente.set(fila.patientId, {
        canal: fila.channel,
        direccion: fila.direccion,
      });
    }
  }

  // El **último** aviso de cada cita: como la consulta viene de más nuevo a más
  // viejo, la primera fila que aparece es la buena.
  const avisoPorCita = new Map<string, (typeof avisos)[number]>();
  for (const fila of avisos) {
    if (fila.appointmentId !== null && !avisoPorCita.has(fila.appointmentId)) {
      avisoPorCita.set(fila.appointmentId, fila);
    }
  }

  return {
    ...pagina,
    items: pagina.items.map((cita) =>
      toItem(cita, canalPorPaciente.get(cita.patientId) ?? null, avisoPorCita.get(cita.id) ?? null),
    ),
  };
};
