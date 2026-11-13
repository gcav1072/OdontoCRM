import {
  DOCUMENT_SEND_DEDUPE_WINDOW_SECONDS,
  type DocumentNotificationKind,
  type OutboundDocument,
  type SendDocumentNotificationInput,
  type SendDocumentNotificationResult,
} from '@odontocrm/contracts';
import { ConflictError, NotFoundError } from '@odontocrm/kernel';

import type { NotificationsDb } from './db/client.js';
import type { InternalClients } from './internal-client.js';
import {
  DocumentoNoDisponibleError,
  enqueue,
  findChannel,
  findChannelById,
  maskDireccion,
  notificationByDedupe,
  type DocumentPayload,
} from './messaging.js';

/**
 * **Envío de récipes, facturas y recibos en PDF por chat** (Req 5, v1.2).
 *
 * Principios de los ADR 0004/0015/0048: cada servicio es dueño de sus documentos.
 * `notifications` no lee el almacén ni la base de `clinical`/`billing`: pide los
 * metadatos y el PDF por rutas internas, y los manda como adjunto en el procesador
 * de la cola. En `odonto_notifications` solo queda **qué** documento es.
 */

/** Plantilla de cada tipo de documento y cómo se llama en la interfaz. */
const PLANTILLA_POR_TIPO: Readonly<Record<DocumentNotificationKind, string>> = {
  prescription: 'documento_recipe',
  invoice: 'documento_factura',
  receipt: 'documento_recibo',
};

/** Cómo se lee el documento en la bandeja («Récipe», «Factura», «Recibo»). */
export const DOCUMENTO_LABEL: Readonly<Record<DocumentNotificationKind, string>> = {
  prescription: 'Récipe',
  invoice: 'Factura',
  receipt: 'Recibo',
};

/** ¿El documento se puede enviar por chat en su estado actual? (solo emitidos y vigentes) */
const estadoEnviable = (
  kind: DocumentNotificationKind,
  status: string,
  voided: boolean,
): boolean => {
  if (kind === 'prescription') return status === 'emitida';
  if (kind === 'invoice') return status !== 'borrador' && status !== 'anulada' && !voided;
  return status !== 'anulado' && !voided;
};

/**
 * Resuelve y valida el documento **antes** de encolarlo: si está borrador o anulado,
 * el disparador manual recibe un 409 con el motivo en vez de un aviso que fallará
 * después en la cola. Devuelve el nombre con el que se anuncia y el nombre de archivo.
 */
const resolverDocumento = async (
  clients: InternalClients,
  kind: DocumentNotificationKind,
  entityId: string,
): Promise<{ numero: string; filename: string; label: string }> => {
  if (kind === 'prescription') {
    const meta = await clients.getPrescriptionMeta(entityId);
    if (meta === null) throw new NotFoundError('Ese récipe no existe');
    if (!estadoEnviable(kind, meta.status, false)) {
      throw new ConflictError(
        `Solo se envían récipes emitidos; este está en estado «${meta.status}».`,
      );
    }
    return {
      numero: meta.number ?? '—',
      filename: meta.filename,
      label: `${DOCUMENTO_LABEL[kind]} ${meta.number ?? ''}`.trim(),
    };
  }

  if (kind === 'invoice') {
    const meta = await clients.getInvoiceMeta(entityId);
    if (meta === null) throw new NotFoundError('Esa factura no existe');
    if (!estadoEnviable(kind, meta.status, false)) {
      throw new ConflictError(
        `Solo se envían facturas emitidas y vigentes; esta está en estado «${meta.status}».`,
      );
    }
    return {
      numero: meta.number ?? '—',
      filename: meta.filename,
      label: `${DOCUMENTO_LABEL[kind]} ${meta.number ?? ''}`.trim(),
    };
  }

  const meta = await clients.getPaymentMeta(entityId);
  if (meta === null) throw new NotFoundError('Ese cobro no existe');
  return {
    numero: meta.receiptNumber,
    filename: meta.filename,
    label: `${DOCUMENTO_LABEL[kind]} ${meta.receiptNumber}`,
  };
};

/** Pie corto del documento (siempre por debajo del límite de caption de Baileys). */
const TEXTO_POR_TIPO: Readonly<Record<DocumentNotificationKind, string>> = {
  prescription: 'Te compartimos tu récipe digital. El PDF va adjunto.',
  invoice: 'Te compartimos tu factura digital. El PDF va adjunto.',
  receipt: 'Te compartimos el recibo de pago. El PDF va adjunto.',
};

/**
 * Encola el envío de un documento. Devuelve `queued` o, si el mismo clic llega dos
 * veces, `duplicado` (el aviso ya estaba en la cola). Completa el `text` y la carga
 * del PDF. Responde 409 cuando el paciente no tiene ningún chat vinculado.
 */
export const sendDocumentNotification = async (
  db: NotificationsDb,
  clients: InternalClients,
  input: SendDocumentNotificationInput,
): Promise<SendDocumentNotificationResult> => {
  const documento = await resolverDocumento(clients, input.kind, input.entityId);

  const vinculado =
    input.channelId !== undefined
      ? await findChannelById(db, input.channelId)
      : await findChannel(db, input.patientId, input.channel);

  if (vinculado === null) {
    throw new ConflictError(
      'El paciente no tiene WhatsApp ni Telegram vinculado. Genera un enlace de vinculación en Notificaciones y pídele al paciente que lo abra.',
    );
  }
  if (vinculado.patientId !== input.patientId) {
    throw new ConflictError('El chat elegido no pertenece a ese paciente');
  }

  // El disparador manual usa `clientRequestId` para que dos clics del mismo diálogo
  // no manden dos veces el mismo documento; sin id, una ventana de 10 s hace de
  // candado. Un reenvío intencional genera otro id y vuelve a salir.
  const bucket =
    input.clientRequestId ??
    `ventana-${String(Math.floor(Date.now() / (DOCUMENT_SEND_DEDUPE_WINDOW_SECONDS * 1000)))}`;
  const dedupeKey = `documento:${input.kind}:${input.entityId}:${input.patientId}:${bucket}`;

  const record = await enqueue(db, {
    patientId: input.patientId,
    patientName: null,
    templateKey: PLANTILLA_POR_TIPO[input.kind],
    channel: vinculado.canal,
    // El texto se re-renderiza al enviar con el nombre del consultorio actual.
    payload: {
      variables: { numero: documento.numero },
      needsClinic: true,
      documento: {
        kind: input.kind,
        entityId: input.entityId,
        label: documento.label,
        filename: documento.filename,
      },
    },
    text: TEXTO_POR_TIPO[input.kind],
    dedupeKey,
    document: {
      kind: input.kind,
      entityId: input.entityId,
      label: documento.label,
      filename: documento.filename,
    },
  });

  const result: SendDocumentNotificationResult = {
    notificationId: record?.id ?? '',
    status: record === null ? 'duplicado' : 'queued',
    channel: vinculado.canal,
    direccionMasked: maskDireccion(vinculado.direccion),
  };

  if (record === null) {
    const existente = await notificationByDedupe(db, dedupeKey);
    result.notificationId = existente?.id ?? '';
  }
  return result;
};

/** Carga el PDF encolado y lo entrega con el tipo correcto al adaptador del canal. */
export type DocumentLoader = (document: DocumentPayload) => Promise<OutboundDocument>;

export const createDocumentLoader = (clients: InternalClients): DocumentLoader => {
  return async (document: DocumentPayload): Promise<OutboundDocument> => {
    let descargado: { buffer: Buffer; filename: string };
    if (document.kind === 'prescription') {
      descargado = await clients.downloadPrescriptionPdf(document.entityId);
    } else if (document.kind === 'invoice') {
      descargado = await clients.downloadInvoicePdf(document.entityId);
    } else {
      descargado = await clients.downloadReceiptPdf(document.entityId);
    }

    if (descargado.buffer.length === 0) {
      throw new DocumentoNoDisponibleError('El documento archivado está vacío');
    }

    return {
      nombre: descargado.filename === '' ? document.filename : descargado.filename,
      contenido: descargado.buffer,
      mime: 'application/pdf',
    };
  };
};
