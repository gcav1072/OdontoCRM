import type {
  AppointmentStatus,
  AppointmentSummary,
  Channel,
  Paginated,
  PatientSummary,
  RequestSummary,
} from '@odontocrm/contracts';

import type { NotificationsConfig } from './config.js';
import { DocumentoNoDisponibleError } from './messaging.js';

/** Documento descargado de otro servicio para enviarlo por chat (Req 5). */
export interface DownloadedDocument {
  buffer: Buffer;
  filename: string;
}

/** Metadatos del récipe archivado (servicio clinical). */
export interface PrescriptionDocumentMeta {
  id: string;
  patientId: string;
  status: 'borrador' | 'emitida' | 'anulada';
  /** Número formateado del récipe (p. ej. `REC-000123`), si ya se emitió. */
  number: string | null;
  filename: string;
  issuedAt: string | null;
}

/** Metadatos de la factura archivada (servicio billing). */
export interface InvoiceDocumentMeta {
  id: string;
  patientId: string;
  patientName: string;
  status: 'borrador' | 'emitida' | 'parcial' | 'pagada' | 'anulada';
  number: string | null;
  filename: string;
  issuedAt: string | null;
}

/** Metadatos del recibo de pago archivado (servicio billing). */
export interface PaymentDocumentMeta {
  id: string;
  invoiceId: string;
  patientId: string;
  receiptNumber: string;
  filename: string;
  paidAt: string;
}

/**
 * Llamadas internas a otros servicios (pacientes y agenda). No pasan por el
 * gateway: van directas por `127.0.0.1` con el secreto compartido, y solo las usa
 * el bot para dar de alta al paciente y crear su solicitud.
 */
export interface InternalClients {
  upsertPatient: (input: {
    docType: string;
    docNumber: string;
    fullName: string;
    birthDate: string;
    sex: string;
    phone: string;
    guardian?: { fullName: string; relationship: string; phone?: string | null } | undefined;
    channel: Channel;
    reason: string;
  }) => Promise<{ created: boolean; patient: { id: string; fullName: string; document: string } }>;

  /** Busca un paciente por documento: el asistente confirma antes de dar de alta. */
  findPatientByDocument: (
    docType: string,
    docNumber: string,
  ) => Promise<{
    id: string;
    fullName: string;
    docType: string;
    docNumber: string;
    document: string;
    phone: string;
    birthDate: string;
    sex: string;
  } | null>;

  /**
   * Resúmenes de pacientes **por id en lote**. Lo usa la bandeja para poner el
   * nombre del paciente en la tabla de canales vinculados: el nombre vive en el
   * servicio de pacientes, no en el de notificaciones.
   */
  listPatientSummaries: (ids: readonly string[]) => Promise<PatientSummary[]>;

  createRequest: (input: {
    patientId: string;
    patientName: string;
    patientDocument?: string | null;
    patientPhone?: string | null;
    channel: Channel;
    reason: string;
    notes?: string | null;
  }) => Promise<RequestSummary>;

  findRequestByTicket: (ticket: string) => Promise<RequestSummary | null>;
  /** Cambia el motivo de una solicitud en cola (reutiliza su ticket, sin duplicarlo). */
  updateRequestReason: (id: string, reason: string) => Promise<RequestSummary>;
  cancelRequest: (id: string, reason: string, channel?: Channel) => Promise<RequestSummary>;
  getAppointment: (id: string) => Promise<AppointmentSummary | null>;

  /**
   * **Solicitudes activas de un paciente** (v1.2): deduplicar el ticket entre varios
   * chats vinculados. Si el paciente creó la solicitud desde Telegram y luego escribe
   * desde WhatsApp, el segundo chat reutiliza la misma solicitud en vez de crear otra.
   */
  listRequestsByPatient: (patientId: string) => Promise<RequestSummary[]>;

  // ── Documentos digitales (Req 5, v1.2) ─────────────────────────────────────
  // `notifications` no toca el STORAGE_DIR ni las bases de clinical/billing: pide
  // metadatos y PDF por las rutas internas y los envía como adjunto.

  getPrescriptionMeta: (id: string) => Promise<PrescriptionDocumentMeta | null>;
  downloadPrescriptionPdf: (id: string) => Promise<DownloadedDocument>;
  getInvoiceMeta: (id: string) => Promise<InvoiceDocumentMeta | null>;
  downloadInvoicePdf: (id: string) => Promise<DownloadedDocument>;
  getPaymentMeta: (id: string) => Promise<PaymentDocumentMeta | null>;
  downloadReceiptPdf: (id: string) => Promise<DownloadedDocument>;

  /**
   * Citas que cumplen los filtros (ADR 0052). La usa la sección de la bandeja
   * —para listar las próximas— y el asistente, para saber qué citas puede
   * confirmar el paciente que acaba de escribir «confirmar».
   */
  listAppointments: (filters: AppointmentInternalFilters) => Promise<Paginated<AppointmentSummary>>;

  /**
   * El **paciente** confirma su cita desde el bot (ADR 0052). Va por la ruta
   * interna porque la agenda no puede pedirle un JWT a un paciente de Telegram.
   */
  confirmAppointment: (
    id: string,
    input: { channel: Channel; note?: string | null },
  ) => Promise<AppointmentSummary>;

  /**
   * El **paciente cancela** su cita desde el bot (ADR 0053). Va por la ruta interna,
   * como la confirmación. El canal dice por dónde canceló y se guarda: es lo que
   * distingue una cancelación del paciente de una de la secretaría.
   */
  cancelAppointment: (
    id: string,
    input: { channel: Channel; reason?: string | null },
  ) => Promise<AppointmentSummary>;
}

/**
 * Filtros que la agenda entiende por su ruta interna. Son un subconjunto de los
 * públicos: los mismos nombres y tipos, para que el servicio no traduzca nada.
 */
export interface AppointmentInternalFilters {
  patientId?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  status?: AppointmentStatus | undefined;
  confirmed?: boolean | undefined;
  search?: string | undefined;
  page?: number | undefined;
  pageSize?: number | undefined;
}

export class InternalRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * ¿La petición **no llegó a salir** del proceso? `ECONNREFUSED` es lo que devuelve
 * `fetch` cuando el servicio está reiniciándose (o arrancando): nadie escuchaba en
 * el puerto, así que la operación no se ejecutó y repetirla es seguro **incluso si
 * es una escritura**.
 *
 * `ECONNRESET` y los tiempos de espera quedan fuera a propósito: ahí la petición
 * pudo llegar y no se sabe si el servidor la aplicó, así que una escritura no se
 * repite (crearía dos tickets).
 */
const noLlegoAlServicio = (error: unknown): boolean => {
  const causa = (error as { cause?: { code?: string } } | null | undefined)?.cause;
  return causa?.code === 'ECONNREFUSED';
};

/** Fallo pasajero del otro lado (5xx o límite de peticiones): vale reintentar. */
const falloPasajero = (error: unknown): boolean =>
  error instanceof InternalRequestError && (error.status >= 500 || error.status === 429);

const esperar = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

interface RetryOptions {
  intentos: number;
  esperaMs: number;
  /** Solo se reintenta si la petición no llegó a salir (escrituras). */
  soloSiNoLlego?: boolean;
}

/**
 * Repite una operación interna con una espera creciente.
 *
 * Existe por un caso real: el bot de Telegram falló a mitad del asistente con
 * `ECONNREFUSED 127.0.0.1:4002` porque el servicio de pacientes se estaba
 * reiniciando; el paciente se quedó sin respuesta. Un reintento de menos de un
 * segundo habría bastado.
 */
const conReintentos = async <T>(operacion: () => Promise<T>, options: RetryOptions): Promise<T> => {
  let ultimo: unknown;

  for (let intento = 1; intento <= options.intentos; intento += 1) {
    try {
      return await operacion();
    } catch (error) {
      ultimo = error;
      const valeReintentar =
        options.soloSiNoLlego === true
          ? noLlegoAlServicio(error)
          : noLlegoAlServicio(error) || falloPasajero(error);
      if (!valeReintentar || intento === options.intentos) break;
      await esperar(options.esperaMs * intento);
    }
  }

  throw ultimo;
};

/** Lecturas internas: se pueden repetir sin cuidado (son idempotentes). */
const LECTURA: RetryOptions = { intentos: 3, esperaMs: 250 };
/**
 * Escrituras internas: solo se repiten si el servicio ni siquiera contestó. Si
 * respondió con un error o se cortó a medias, la respuesta se devuelve tal cual
 * (el asistente ya avisa al paciente y conserva la conversación).
 */
const ESCRITURA: RetryOptions = { intentos: 3, esperaMs: 250, soloSiNoLlego: true };

/**
 * Filtros como `?clave=valor`. Los `undefined` se omiten; `false` **no**, porque
 * `confirmed=false` («las que no están confirmadas») es un filtro de verdad.
 */
const queryString = (params: object): string => {
  const search = new URLSearchParams();
  for (const [clave, valor] of Object.entries(params)) {
    if (valor === undefined || valor === null) continue;
    search.set(clave, String(valor));
  }
  const texto = search.toString();
  return texto === '' ? '' : `?${texto}`;
};

const request = async <T>(
  config: NotificationsConfig,
  base: string,
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown },
): Promise<T> => {
  const response = await fetch(`${base}${path}`, {
    method: init.method,
    headers: {
      // El secreto compartido sustituye al JWT de servicio (que llega en la Fase 10).
      'x-internal-token': config.INTERNAL_SERVICE_SECRET ?? '',
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    signal: AbortSignal.timeout(15_000),
  });

  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text.slice(0, 200);
  }

  if (!response.ok) {
    const detail =
      typeof parsed === 'object' && parsed !== null && 'detail' in parsed
        ? String((parsed as { detail: unknown }).detail)
        : String(response.status);
    throw new InternalRequestError(detail, response.status);
  }
  return parsed as T;
};

/** GET de metadatos que devuelve `null` cuando el documento no existe (404). */
const requestMeta = async <T>(
  config: NotificationsConfig,
  base: string,
  path: string,
): Promise<T | null> => {
  try {
    return await request<T>(config, base, path, { method: 'GET' });
  } catch (error) {
    if (error instanceof InternalRequestError && error.status === 404) return null;
    throw error;
  }
};

/** Nombre del archivo tal como lo anuncia el servicio dueño del PDF. */
const filenameFrom = (disposition: string | null): string => {
  if (disposition === null) return 'documento.pdf';
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
  if (match?.[1] === undefined) return 'documento.pdf';
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
};

/**
 * Descarga binaria (el PDF archivado de un récipe, factura o recibo). Un **404** o un
 * **409** significan que el documento ya no se puede enviar (anulado, borrado o sin
 * archivo): se traducen a `DocumentoNoDisponibleError` para que la cola no lo
 * reintente durante una hora. Un 5xx sí es transitorio y se reintenta.
 */
const requestBinary = async (
  config: NotificationsConfig,
  base: string,
  path: string,
): Promise<DownloadedDocument> => {
  const response = await fetch(`${base}${path}`, {
    method: 'GET',
    headers: { 'x-internal-token': config.INTERNAL_SERVICE_SECRET ?? '' },
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    let detail = String(response.status);
    try {
      const parsed: unknown = JSON.parse(text);
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        'detail' in parsed &&
        typeof (parsed as { detail: unknown }).detail === 'string'
      ) {
        detail = (parsed as { detail: string }).detail;
      }
    } catch {
      // Cuerpo no JSON: se queda el código de estado como detalle.
    }
    if (response.status === 404 || response.status === 409) {
      throw new DocumentoNoDisponibleError(detail.slice(0, 300));
    }
    throw new InternalRequestError(detail, response.status);
  }

  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    filename: filenameFrom(response.headers.get('content-disposition')),
  };
};

export const createInternalClients = (config: NotificationsConfig): InternalClients => ({
  upsertPatient: async (input) =>
    conReintentos(async () => {
      const result = await request<{
        created: boolean;
        patient: { id: string; fullName: string; document: string };
      }>(config, config.PATIENTS_URL, '/internal/v1/patients/upsert-by-cedula', {
        method: 'POST',
        body: {
          docType: input.docType,
          docNumber: input.docNumber,
          fullName: input.fullName,
          birthDate: input.birthDate,
          sex: input.sex,
          phone: input.phone,
          ...(input.guardian === undefined ? {} : { guardian: input.guardian }),
          channel: input.channel,
          reason: input.reason,
        },
      });
      return { created: result.created, patient: result.patient };
    }, ESCRITURA),

  createRequest: async (input) =>
    conReintentos(
      () =>
        request<RequestSummary>(config, config.SCHEDULING_URL, '/internal/v1/requests', {
          method: 'POST',
          // El origen es el canal real: en WhatsApp la auditoría no debe decir
          // «servicio:telegram» (antes estaba fijo y confundía el rastro).
          body: { ...input, source: input.channel },
        }),
      ESCRITURA,
    ),

  findPatientByDocument: async (docType, docNumber) =>
    conReintentos(async () => {
      try {
        return await request<{
          id: string;
          fullName: string;
          docType: string;
          docNumber: string;
          document: string;
          phone: string;
          birthDate: string;
          sex: string;
        }>(
          config,
          config.PATIENTS_URL,
          `/internal/v1/patients/by-document/${encodeURIComponent(docType)}/${encodeURIComponent(docNumber)}`,
          { method: 'GET' },
        );
      } catch (error) {
        if (error instanceof InternalRequestError && error.status === 404) return null;
        throw error;
      }
    }, LECTURA),

  listPatientSummaries: async (ids) =>
    conReintentos(async () => {
      if (ids.length === 0) return [];
      const result = await request<{ items: PatientSummary[] }>(
        config,
        config.PATIENTS_URL,
        `/internal/v1/patients/summaries${queryString({ ids: ids.join(',') })}`,
        { method: 'GET' },
      );
      return result.items;
    }, LECTURA),

  findRequestByTicket: async (ticket) =>
    conReintentos(async () => {
      try {
        return await request<RequestSummary>(
          config,
          config.SCHEDULING_URL,
          `/internal/v1/requests/by-ticket/${encodeURIComponent(ticket)}`,
          { method: 'GET' },
        );
      } catch (error) {
        if (error instanceof InternalRequestError && error.status === 404) return null;
        throw error;
      }
    }, LECTURA),

  updateRequestReason: async (id, reason) =>
    conReintentos(
      () =>
        request<RequestSummary>(
          config,
          config.SCHEDULING_URL,
          `/internal/v1/requests/${id}/reason`,
          { method: 'POST', body: { reason } },
        ),
      ESCRITURA,
    ),

  cancelRequest: async (id, reason, channel) =>
    conReintentos(
      () =>
        request<RequestSummary>(
          config,
          config.SCHEDULING_URL,
          `/internal/v1/requests/${id}/cancel`,
          { method: 'POST', body: { reason, ...(channel === undefined ? {} : { channel }) } },
        ),
      ESCRITURA,
    ),

  getAppointment: async (id) =>
    conReintentos(async () => {
      try {
        return await request<AppointmentSummary>(
          config,
          config.SCHEDULING_URL,
          `/internal/v1/appointments/${id}`,
          { method: 'GET' },
        );
      } catch (error) {
        if (error instanceof InternalRequestError && error.status === 404) return null;
        throw error;
      }
    }, LECTURA),

  listAppointments: async (filters) =>
    conReintentos(
      () =>
        request<Paginated<AppointmentSummary>>(
          config,
          config.SCHEDULING_URL,
          `/internal/v1/appointments${queryString(filters)}`,
          { method: 'GET' },
        ),
      LECTURA,
    ),

  confirmAppointment: async (id, input) =>
    conReintentos(
      () =>
        request<AppointmentSummary>(
          config,
          config.SCHEDULING_URL,
          `/internal/v1/appointments/${id}/confirm`,
          { method: 'POST', body: { channel: input.channel, note: input.note ?? null } },
        ),
      // Confirmar es **idempotente** en la agenda, así que repetirlo por un corte de
      // red es seguro: el paciente vería el mismo «listo» y no habría dos historiales.
      ESCRITURA,
    ),

  cancelAppointment: async (id, input) =>
    conReintentos(
      () =>
        request<AppointmentSummary>(
          config,
          config.SCHEDULING_URL,
          `/internal/v1/appointments/${id}/cancel`,
          { method: 'POST', body: { channel: input.channel, reason: input.reason ?? null } },
        ),
      // Cancelar también es **idempotente** en la agenda: repetir por un corte de red
      // es seguro (el paciente vería el mismo «entendido» y no habría doble historial).
      ESCRITURA,
    ),

  /**
   * Solicitudes del paciente, de la más reciente a la más antigua (v1.2). El
   * asistente las consulta antes de crear un ticket desde un segundo chat: el
   * `lastTicket` de la conversación solo conoce el chat donde se creó.
   */
  listRequestsByPatient: async (patientId) =>
    conReintentos(async () => {
      const result = await request<Paginated<RequestSummary>>(
        config,
        config.SCHEDULING_URL,
        `/internal/v1/requests${queryString({ patientId, pageSize: 50 })}`,
        { method: 'GET' },
      );
      return result.items;
    }, LECTURA),

  // ── Documentos digitales (Req 5) ──────────────────────────────────────────
  getPrescriptionMeta: async (id) =>
    conReintentos(
      () =>
        requestMeta<PrescriptionDocumentMeta>(
          config,
          config.CLINICAL_URL,
          `/internal/v1/clinical/prescriptions/${id}/meta`,
        ),
      LECTURA,
    ),

  downloadPrescriptionPdf: async (id) =>
    conReintentos(
      () =>
        requestBinary(config, config.CLINICAL_URL, `/internal/v1/clinical/prescriptions/${id}/pdf`),
      LECTURA,
    ),

  getInvoiceMeta: async (id) =>
    conReintentos(
      () =>
        requestMeta<InvoiceDocumentMeta>(
          config,
          config.BILLING_URL,
          `/internal/v1/billing/invoices/${id}/meta`,
        ),
      LECTURA,
    ),

  downloadInvoicePdf: async (id) =>
    conReintentos(
      () => requestBinary(config, config.BILLING_URL, `/internal/v1/billing/invoices/${id}/pdf`),
      LECTURA,
    ),

  getPaymentMeta: async (id) =>
    conReintentos(
      () =>
        requestMeta<PaymentDocumentMeta>(
          config,
          config.BILLING_URL,
          `/internal/v1/billing/payments/${id}/meta`,
        ),
      LECTURA,
    ),

  downloadReceiptPdf: async (id) =>
    conReintentos(
      () =>
        requestBinary(config, config.BILLING_URL, `/internal/v1/billing/payments/${id}/receipt`),
      LECTURA,
    ),
});
