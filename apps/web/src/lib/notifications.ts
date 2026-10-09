import { renderMessage, type NotificationRecord } from '@odontocrm/contracts';

import type { AppointmentsNotificationParams, NotificationsListParams } from './endpoints';

/**
 * Piezas puras de la bandeja de notificaciones (Fase 4): claves de consulta,
 * lectura defensiva del `payload` de un envío y valores de ejemplo para la vista
 * previa de las plantillas.
 *
 * El `payload` es un `Record<string, unknown>`: lo escribe el servicio de
 * notificaciones y aquí solo se muestra, así que nada se da por hecho (ni las
 * claves ni el tipo de cada valor).
 */

/* ── Claves de consulta ────────────────────────────────────────────────────── */

export const notificationKeys = {
  /** Bandeja de envíos con sus filtros y su página. */
  list: (filters: NotificationsListParams) => ['notificaciones', 'bandeja', filters] as const,
  listRoot: ['notificaciones', 'bandeja'] as const,
  /** Estado del bot: modo, contadores y conversaciones activas. */
  status: ['notificaciones', 'bot'] as const,
  /** Citas próximas de la sección de citas (ADR 0052), con sus filtros y su página. */
  appointments: (filters: AppointmentsNotificationParams) =>
    ['notificaciones', 'citas', filters] as const,
  appointmentsRoot: ['notificaciones', 'citas'] as const,
  /** Plantillas de mensaje editables. */
  templates: ['notificaciones', 'plantillas'] as const,
  /** Canales vinculados (todos, o los de un paciente). */
  channels: (patientId: string | null) => ['notificaciones', 'canales', patientId] as const,
  channelsRoot: ['notificaciones', 'canales'] as const,
  /** Enlace de vinculación generado a partir de un paciente. */
  linkCode: (patientId: string) => ['notificaciones', 'enlace', patientId] as const,
  /** Política de cancelación del paciente (ADR 0057). */
  settings: ['notificaciones', 'politica'] as const,
};

/** Refresco de la cabecera de estado: el bot recibe mensajes a cada rato. */
export const BOT_STATUS_REFRESH_MS = 15_000;

/* ── Lectura defensiva del payload ─────────────────────────────────────────── */

const esRegistro = (valor: unknown): valor is Record<string, unknown> =>
  typeof valor === 'object' && valor !== null && !Array.isArray(valor);

const leerTexto = (fuente: Record<string, unknown>, clave: string): string | null => {
  const valor = fuente[clave];
  return typeof valor === 'string' && valor.trim().length > 0 ? valor : null;
};

/** Primer texto no vacío de la lista de claves candidatas. */
const primero = (fuente: Record<string, unknown>, claves: readonly string[]): string | null => {
  for (const clave of claves) {
    const valor = leerTexto(fuente, clave);
    if (valor !== null) return valor;
  }
  return null;
};

/** Datos útiles del mensaje, ya extraídos del `payload` y de sus valores. */
export interface NotificationPayloadFields {
  templateKey: string | null;
  channel: string | null;
  recipient: string | null;
  ticket: string | null;
  date: string | null;
  time: string | null;
  place: string | null;
  patient: string | null;
  username: string | null;
  /** Texto del mensaje tal como lo escribió la plantilla (con marcadores). */
  body: string | null;
  /** Valores con los que se renderiza el texto, como textos. */
  values: Record<string, string>;
}

const CLAVES_TEXTO = ['body', 'message', 'text', 'cuerpo', 'mensaje'] as const;

/** Extrae del `payload` lo que la interfaz sabe mostrar; lo que no, se ignora. */
export const notificationPayloadFields = (
  payload: Record<string, unknown>,
): NotificationPayloadFields => {
  const valores = esRegistro(payload['values']) ? payload['values'] : payload;

  const texts: Record<string, string> = {};
  for (const [clave, valor] of Object.entries(valores)) {
    if (typeof valor === 'string' && valor.length > 0) texts[clave] = valor;
    else if (typeof valor === 'number') texts[clave] = String(valor);
  }

  return {
    templateKey: primero(payload, ['templateKey', 'template']),
    channel: primero(payload, ['channel', 'canal']),
    recipient: primero(payload, ['recipient', 'to', 'chatIdMasked']),
    ticket: primero(valores, ['ticket']),
    date: primero(valores, ['date', 'fecha']),
    time: primero(valores, ['time', 'hora']),
    place: primero(valores, ['place', 'lugar', 'location']),
    patient: primero(valores, ['paciente', 'patient', 'patientName', 'nombre']),
    username: primero(valores, ['telegramUsername', 'username']),
    body: primero(payload, CLAVES_TEXTO),
    values: texts,
  };
};

/** Texto del mensaje ya renderizado (o el crudo si no se puede renderizar). */
export const notificationMessage = (record: NotificationRecord): string | null => {
  const campos = notificationPayloadFields(record.payload);
  if (campos.body === null) return null;
  const renderizado = renderMessage(campos.body, campos.values);
  return renderizado.trim().length > 0 ? renderizado : campos.body;
};

/** Entradas simples del `payload`, para la tabla de datos del detalle. */
export const notificationPayloadEntries = (
  payload: Record<string, unknown>,
): readonly (readonly [string, string])[] =>
  Object.entries(payload)
    .map(([clave, valor]): readonly [string, string] | null => {
      if (typeof valor === 'string' || typeof valor === 'number' || typeof valor === 'boolean') {
        return [clave, String(valor)] as const;
      }
      if (esRegistro(valor) || Array.isArray(valor)) {
        return [clave, JSON.stringify(valor)] as const;
      }
      return null;
    })
    .filter((entrada): entrada is readonly [string, string] => entrada !== null);

/* ── Códigos QR ────────────────────────────────────────────────────────────── */

const PREFIJO_DATA_URL = 'data:image/';

/**
 * `src` listo para el `<img>` del QR. El contrato promete un `data URL` en
 * base64; si el servicio devolviera solo el base64, se le añade el prefijo.
 */
export const notificationQrImage = (qrDataUrl: string | null | undefined): string | null => {
  if (typeof qrDataUrl !== 'string') return null;
  const limpio = qrDataUrl.trim();
  if (limpio.length === 0) return null;
  if (limpio.startsWith(PREFIJO_DATA_URL) || limpio.startsWith('http')) return limpio;
  if (/^[A-Za-z0-9+/=\s]+$/.test(limpio)) {
    return `data:image/png;base64,${limpio.replace(/\s+/g, '')}`;
  }
  return null;
};

/** ¿El enlace de vinculación ya caducó? */
export const linkCodeExpired = (expiresAt: string, now: Date = new Date()): boolean => {
  const fecha = new Date(expiresAt);
  return Number.isNaN(fecha.getTime()) ? false : fecha.getTime() <= now.getTime();
};

/* ── Datos de ejemplo de la vista previa ───────────────────────────────────── */

/**
 * Valores de ejemplo por marcador. Son los mismos nombres que usan las
 * plantillas de los contratos, para que la vista previa diga algo útil aunque el
 * marcador aún no tenga dato real.
 */
export const TEMPLATE_SAMPLE_VALUES: Readonly<Record<string, string>> = {
  clinica: 'Consultorio de prueba',
  paciente: 'María Pérez',
  documento: 'V-12345678',
  telefono: '0412-1234567',
  fecha: '15/05/2026',
  hora: '9:30 a. m.',
  lugar: 'Consultorio de prueba, Calle de prueba 123',
  ticket: 'A-000123',
  estado: 'En espera de cita',
  resumen:
    'María Pérez · V-12345678 · 0412-1234567\nNacida el 03/04/1990 · Femenino\nMotivo: dolor en la muela del juicio',
  cita: 'Tu cita es el 15/05/2026 a las 9:30 a. m.',
  motivo: 'Dolor en la muela del juicio',
};

/** Vista previa de un texto de plantilla ya renderizado con los ejemplos. */
export const templatePreview = (body: string): string =>
  renderMessage(body, TEMPLATE_SAMPLE_VALUES);

/** Marcadores presentes en un texto, en el orden en que aparecen. */
export const templatePlaceholders = (body: string): readonly string[] => {
  const encontrados: string[] = [];
  for (const coincidencia of body.matchAll(/\{(\w+)\}/g)) {
    const nombre = coincidencia[1];
    if (nombre !== undefined && !encontrados.includes(nombre)) encontrados.push(nombre);
  }
  return encontrados;
};
