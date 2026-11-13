import {
  CHANNEL_IDS,
  type ChannelId,
  type DocumentNotificationKind,
  type PatientChannel,
  type SendDocumentNotificationInput,
  type SendDocumentNotificationResult,
} from '@odontocrm/contracts';

import type { TranslationKey } from './i18n';

/**
 * Piezas puras del **envío de documentos por chat** (v1.2): qué chats se ofrecen,
 * cómo se agrupan por canal y cómo se construye el cuerpo que espera
 * `POST /notifications/documents/send`.
 *
 * Un paciente puede tener **varios vínculos**, incluso del mismo canal, así que la
 * unidad que se elige es el `id` de `patient_channels`, no el canal. El servidor ya
 * devuelve el chat principal primero; aquí solo se filtra lo que puede llevar
 * adjuntos y se agrupa para el selector.
 */

/** Un vínculo concreto que puede recibir un documento. */
export interface DocumentChannelOption {
  id: string;
  channel: ChannelId;
  /** Dirección enmascarada: nunca se muestra completa. */
  direccionMasked: string;
  /** Chat principal del paciente (destino por defecto). */
  isPrimary: boolean;
}

/** Los vínculos de un mismo canal, en el orden en que llegaron del servidor. */
export interface DocumentChannelGroup {
  channel: ChannelId;
  options: readonly DocumentChannelOption[];
}

const ORDEN_CANALES: readonly ChannelId[] = CHANNEL_IDS;

/** ¿Es un canal al que se le pueden mandar documentos? (Telegram o WhatsApp). */
const esCanalDocumental = (channel: string): channel is ChannelId =>
  (ORDEN_CANALES as readonly string[]).includes(channel);

/**
 * Los chats a los que se puede mandar un documento, conservando el orden del
 * servidor (principal primero, después el vínculo más reciente).
 */
export const documentChannelOptions = (
  channels: readonly PatientChannel[],
): DocumentChannelOption[] =>
  channels
    .filter((canal): canal is PatientChannel & { channel: ChannelId } =>
      esCanalDocumental(canal.channel),
    )
    .map((canal) => ({
      id: canal.id,
      channel: canal.channel,
      direccionMasked: canal.direccionMasked,
      isPrimary: canal.isPrimary,
    }));

/**
 * Los chats agrupados por canal para el selector: Telegram antes que WhatsApp y sin
 * grupos vacíos. Sirve tanto si el paciente tiene un solo vínculo como si tiene dos
 * WhatsApp y un Telegram.
 */
export const groupDocumentChannels = (
  channels: readonly PatientChannel[],
): DocumentChannelGroup[] => {
  const opciones = documentChannelOptions(channels);
  return ORDEN_CANALES.map((channel) => ({
    channel,
    options: opciones.filter((opcion) => opcion.channel === channel),
  })).filter((grupo) => grupo.options.length > 0);
};

/** Lo que la interfaz sabe de la acción de envío al abrirla. */
export interface DocumentSendTarget {
  kind: DocumentNotificationKind;
  /** Id del récipe, factura o cobro. */
  entityId: string;
  patientId: string;
  /** Vínculo elegido; sin él, el servidor usa el chat principal del paciente. */
  channelId?: string;
  /**
   * Idempotencia del clic: se genera **al abrir la acción** y viaja igual si la
   * petición se reintenta, para que dos clics no encolen el documento dos veces.
   */
  clientRequestId?: string;
}

/** Cuerpo exacto de `POST /notifications/documents/send` (sin campos vacíos). */
export const documentSendInput = (target: DocumentSendTarget): SendDocumentNotificationInput => ({
  kind: target.kind,
  entityId: target.entityId,
  patientId: target.patientId,
  ...(target.channelId === undefined ? {} : { channelId: target.channelId }),
  ...(target.clientRequestId === undefined ? {} : { clientRequestId: target.clientRequestId }),
});

/** Clave del aviso que corresponde al resultado: encolado o ya estaba en cola. */
export const documentSendMessageKey = (
  result: Pick<SendDocumentNotificationResult, 'status'>,
): TranslationKey =>
  result.status === 'duplicado'
    ? 'notificaciones.envio.duplicado'
    : 'notificaciones.envio.encolado';
