import { z } from 'zod';

import { CHANNEL_IDS } from './channel.js';
import { queryBoolean } from '../common/optional.js';
import {
  APPOINTMENT_STATUSES,
  CHANNELS,
  DOC_TYPES,
  NOTIFICATION_STATUSES,
  SEXES,
  type DocType,
} from './enums.js';
import { APPOINTMENT_CONFIRMATION_TEMPLATE, renderTemplate } from './scheduling.js';

/**
 * Notificaciones y asistente multicanal (Fases 4 y 4.1).
 *
 * El asistente sigue el guion del plan §7: siete pasos con validación y
 * normalización, idempotencia por evento del canal (`update_id` o `wamid`),
 * anti-flood y conversaciones reanudables por `(canal, dirección)`. Los textos
 * viven en plantillas editables (tabla `message_templates`), sembradas desde aquí
 * para que el sistema funcione desde el primer arranque y se puedan cambiar sin
 * recompilar.
 */

/* ── Asistente paso a paso ─────────────────────────────────────────────────── */

export const BOT_STEPS = [
  'nombre',
  'documento',
  'telefono',
  'nacimiento',
  'sexo',
  'motivo',
  'confirmacion',
] as const;
export type BotStep = (typeof BOT_STEPS)[number];

/** Estados de la conversación: los pasos del asistente más sus alrededores. */
export const BOT_CONVERSATION_STATES = [
  'inicio',
  ...BOT_STEPS,
  /** Sub-paso de `nacimiento` cuando el paciente es menor de edad. */
  'representante',
  'esperando_confirmacion',
  'listo',
] as const;
export type BotConversationState = (typeof BOT_CONVERSATION_STATES)[number];

export const BOT_STEP_LABELS: Readonly<Record<BotStep, string>> = {
  nombre: 'Nombre completo',
  documento: 'Cédula o documento',
  telefono: 'Teléfono',
  nacimiento: 'Fecha de nacimiento',
  sexo: 'Sexo',
  motivo: 'Motivo de la consulta',
  confirmacion: 'Confirmación',
};

export const botDraftSchema = z.object({
  fullName: z.string().max(120).nullable().default(null),
  docType: z
    .enum(DOC_TYPES as unknown as [DocType, ...DocType[]])
    .nullable()
    .default(null),
  docNumber: z.string().max(20).nullable().default(null),
  phone: z.string().max(20).nullable().default(null),
  birthDate: z.string().max(10).nullable().default(null),
  sex: z
    .enum(SEXES as unknown as [string, ...string[]])
    .nullable()
    .default(null),
  reason: z.string().max(500).nullable().default(null),
  /** Solo para menores de edad: representante. */
  guardianName: z.string().max(120).nullable().default(null),
  guardianDocType: z
    .enum(DOC_TYPES as unknown as [DocType, ...DocType[]])
    .nullable()
    .default(null),
  guardianDocNumber: z.string().max(20).nullable().default(null),
});

export type BotDraft = z.infer<typeof botDraftSchema>;

export const botConversationSchema = z.object({
  /** Canal por el que habla el paciente (`telegram` o `whatsapp`). */
  canal: z.enum(CHANNEL_IDS),
  /** Dirección enmascarada: nunca se expone completa en la interfaz. */
  direccionMasked: z.string(),
  state: z.enum(BOT_CONVERSATION_STATES),
  draft: botDraftSchema,
  /** Paciente ya vinculado a esta conversación, si lo hay. */
  patientId: z.uuid().nullable(),
  usuario: z.string().nullable(),
  /** Mensajes recibidos en la ventana de anti-flood. */
  messageCount: z.number().int().min(0),
  windowStartedAt: z.string(),
  updatedAt: z.string(),
});

export type BotConversation = z.infer<typeof botConversationSchema>;

/** Nombre para el asistente: colapsa espacios, quita números y emojis, pone título. */
export const normalizeBotName = (
  value: string,
): { ok: boolean; value: string; message?: string } => {
  const cleaned = value
    .normalize('NFKC')
    // eslint-disable-next-line no-control-regex -- se buscan los caracteres de control para limpiarlos
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/[^\p{L}\p{M}\s'.-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (cleaned.length < 3) {
    return {
      ok: false,
      value: cleaned,
      message: 'Escribe tu nombre y apellido (mínimo 3 letras).',
    };
  }
  if (cleaned.length > 120) {
    return { ok: false, value: cleaned, message: 'El nombre es demasiado largo.' };
  }

  const titled = cleaned
    .toLocaleLowerCase('es-VE')
    .replace(
      /(^|[\s'.-])(\p{L})/gu,
      (_match, separator: string, letter: string) => separator + letter.toLocaleUpperCase('es-VE'),
    );

  return { ok: true, value: titled };
};

/** Fecha `dd/mm/aaaa` o `dd-mm-aaaa` (también `d/m/aa`), como `AAAA-MM-DD`. */
export const parseBotDate = (
  value: string,
  now: Date = new Date(),
): { ok: boolean; value?: string; message?: string } => {
  const match = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/.exec(value.trim());
  if (match === null) {
    return { ok: false, message: 'Escribe la fecha como 15/05/1990.' };
  }
  const day = Number(match[1]);
  const month = Number(match[2]);
  const rawYear = Number(match[3]);
  const year = rawYear < 100 ? 1900 + rawYear : rawYear;

  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return { ok: false, message: 'Esa fecha no existe. Revísala y escríbela otra vez.' };
  }
  if (date.getTime() > now.getTime()) {
    return { ok: false, message: 'La fecha no puede ser futura.' };
  }
  const age = now.getUTCFullYear() - year;
  if (age > 120) {
    return { ok: false, message: 'Revisa el año: la edad no puede pasar de 120 años.' };
  }
  return { ok: true, value: date.toISOString().slice(0, 10) };
};

/** Resumen del borrador para el paso de confirmación (con datos enmascarados). */
export const maskDocument = (docType: string, docNumber: string): string => {
  const visible = docNumber.slice(-3);
  return `${docType}-${'•'.repeat(Math.max(0, docNumber.length - 3))}${visible}`;
};

export const maskPhone = (phone: string): string =>
  phone.length <= 6 ? phone : `${phone.slice(0, 6)}${'•'.repeat(phone.length - 6)}`;

/* ── Plantillas editables ──────────────────────────────────────────────────── */

export const NOTIFICATION_TEMPLATE_KEYS = [
  'bienvenida',
  'ayuda',
  'pedir_nombre',
  'pedir_documento',
  'pedir_telefono',
  'pedir_nacimiento',
  'pedir_sexo',
  'pedir_motivo',
  'confirmar',
  'solicitud_recibida',
  'pedir_representante',
  'solicitud_en_curso',
  'sin_solicitud',
  'cita_confirmada',
  'cita_reprogramada',
  'cita_cancelada',
  'estado_solicitud',
  'documento_duplicado',
  'manual_pendiente',
  'servicio_no_disponible',
  /** Respuesta al paciente que acaba de confirmar su cita (ADR 0052). */
  'cita_confirmada_paciente',
  /** Respuesta al paciente que acaba de cancelar su cita (ADR 0053). */
  'cita_cancelada_paciente',
  /** Cuando intenta cancelar una cita que ya no se puede cancelar por el bot. */
  'cita_no_cancelable',
  /**
   * Cuando intenta cancelar una cita **confirmada** dentro del corte de días que fija
   * la clínica (ADR 0057): por chat ya no se puede, tiene que llamar al consultorio.
   */
  'cita_cancelacion_fuera_de_plazo',
  /** Cuando escribe «confirmar» y no tiene ninguna cita próxima que confirmar. */
  'sin_citas',
] as const;
export type NotificationTemplateKey = (typeof NOTIFICATION_TEMPLATE_KEYS)[number];

export interface DefaultTemplate {
  key: NotificationTemplateKey;
  channel: 'telegram';
  subject: string | null;
  body: string;
  /** Marcadores que admite, para mostrarlos en la pantalla de plantillas. */
  placeholders: readonly string[];
}

export const DEFAULT_MESSAGE_TEMPLATES: readonly DefaultTemplate[] = [
  {
    key: 'bienvenida',
    channel: 'telegram',
    subject: null,
    body:
      '¡Hola! Soy el asistente de {clinica}. Puedo tomar tu solicitud de cita y darte tu ticket.\n' +
      'Escríbeme «cita» para pedir una cita, «estado» para saber cómo va la tuya o «ayuda» para ver todo lo que puedo hacer.',
    placeholders: ['clinica'],
  },
  {
    key: 'ayuda',
    channel: 'telegram',
    subject: null,
    body:
      'Esto es lo que puedo hacer:\n' +
      '«cita» — pedir una cita\n' +
      '«estado» — consultar tu solicitud\n' +
      '«cancelar» — anular tu solicitud\n' +
      '«mi ticket» — recordarte tu ticket\n\n' +
      'Escríbeme cualquiera de esas palabras y te guío paso a paso.',
    placeholders: [],
  },
  {
    key: 'pedir_nombre',
    channel: 'telegram',
    subject: null,
    body: 'Paso 1 de 7 · ¿Cómo te llamas? Escribe tu nombre y apellido.',
    placeholders: [],
  },
  {
    key: 'pedir_documento',
    channel: 'telegram',
    subject: null,
    body:
      'Paso 2 de 7 · ¿Cuál es tu documento?\n' +
      'Elige el tipo (V, E, P o SC) y escríbeme el número, por ejemplo V-12345678.',
    placeholders: [],
  },
  {
    key: 'pedir_telefono',
    channel: 'telegram',
    subject: null,
    body: 'Paso 3 de 7 · ¿A qué teléfono te llamamos? (por ejemplo 0412-1234567)',
    placeholders: [],
  },
  {
    key: 'pedir_nacimiento',
    channel: 'telegram',
    subject: null,
    body: 'Paso 4 de 7 · ¿Cuál es tu fecha de nacimiento? (dd/mm/aaaa)',
    placeholders: [],
  },
  {
    key: 'pedir_sexo',
    channel: 'telegram',
    subject: null,
    body: 'Paso 5 de 7 · ¿Sexo? Elige una opción.',
    placeholders: [],
  },
  {
    key: 'pedir_motivo',
    channel: 'telegram',
    subject: null,
    body: 'Paso 6 de 7 · Cuéntame brevemente el motivo de la consulta.',
    placeholders: [],
  },
  {
    key: 'confirmar',
    channel: 'telegram',
    subject: null,
    body: 'Paso 7 de 7 · Revisa tus datos:\n\n{resumen}\n\n¿Está todo bien?',
    placeholders: ['resumen'],
  },
  {
    key: 'documento_duplicado',
    channel: 'telegram',
    subject: null,
    body:
      'Ya te tenemos registrado, {paciente} ({documento}).\n' +
      '¿Confirmas que estos datos son tuyos y quieres pedir una cita?',
    placeholders: ['paciente', 'documento'],
  },
  {
    key: 'solicitud_recibida',
    channel: 'telegram',
    subject: null,
    body:
      '¡Listo, {paciente}! Tu solicitud quedó registrada con el ticket {ticket} y está EN ESPERA DE CITA.\n' +
      'Te escribiremos por aquí cuando te asignemos fecha y hora.',
    placeholders: ['paciente', 'ticket'],
  },
  {
    key: 'pedir_representante',
    channel: 'telegram',
    subject: null,
    body:
      'Como {paciente} es menor de edad, necesito los datos de su representante.\n' +
      'Escribe el nombre y apellido de quien lo acompaña.',
    placeholders: ['paciente'],
  },
  {
    key: 'solicitud_en_curso',
    channel: 'telegram',
    subject: null,
    body:
      'Ya tienes una solicitud en curso con el ticket {ticket}.\n' +
      'Escríbeme «estado» para ver cómo va. Si quieres anularla, escribe «cancelar».',
    placeholders: ['ticket'],
  },
  {
    key: 'sin_solicitud',
    channel: 'telegram',
    subject: null,
    body:
      'No encuentro ninguna solicitud tuya con ese ticket.\n' +
      'Revisa el número o escríbeme «cita» para pedir una cita.',
    placeholders: [],
  },
  {
    key: 'cita_confirmada',
    channel: 'telegram',
    subject: 'Confirmación de tu cita',
    // Misma redacción que la vista previa del lote de la agenda: lo que se ve antes
    // de enviar es exactamente lo que recibe el paciente.
    body: APPOINTMENT_CONFIRMATION_TEMPLATE.body,
    placeholders: ['paciente', 'fecha', 'hora', 'lugar', 'ticket'],
  },
  {
    key: 'cita_reprogramada',
    channel: 'telegram',
    subject: 'Tu cita cambió de fecha',
    body:
      'Hola {paciente}: tu cita cambió.\n' +
      'Nueva fecha: {fecha} a las {hora}\n' +
      'Lugar: {lugar}\n' +
      'Te adjunto el calendario actualizado. Tu ticket es {ticket}.',
    placeholders: ['paciente', 'fecha', 'hora', 'lugar', 'ticket'],
  },
  {
    key: 'cita_cancelada',
    channel: 'telegram',
    subject: 'Cita cancelada',
    body:
      'Hola {paciente}: tu cita del {fecha} a las {hora} quedó cancelada.\n' +
      'Si quieres otra fecha, escríbeme «cita» y te ayudo.',
    placeholders: ['paciente', 'fecha', 'hora'],
  },
  {
    key: 'estado_solicitud',
    channel: 'telegram',
    subject: null,
    body: 'Tu solicitud {ticket} está en estado: {estado}.\n{cita}',
    placeholders: ['ticket', 'estado', 'cita'],
  },
  {
    key: 'manual_pendiente',
    channel: 'telegram',
    subject: 'Aviso manual pendiente',
    body:
      'Llamar a {paciente} ({telefono}) para avisar de su cita del {fecha} a las {hora} en {lugar}.\n' +
      'Guion: «Buenos días, le habla el consultorio para confirmar su cita…».',
    placeholders: ['paciente', 'telefono', 'fecha', 'hora', 'lugar'],
  },
  {
    key: 'servicio_no_disponible',
    channel: 'telegram',
    subject: null,
    body:
      'Perdona: ahora mismo no puedo consultar el sistema del consultorio. ' +
      'Espera unos segundos y vuelve a escribirme lo mismo, por favor. ' +
      'Tu solicitud no se ha perdido: seguimos en el mismo paso.',
    placeholders: [],
  },
  {
    key: 'cita_confirmada_paciente',
    channel: 'telegram',
    subject: null,
    body:
      '¡Listo, {paciente}! Quedaste confirmado para el {fecha} a las {hora}.\n' +
      'Lugar: {lugar}\n' +
      'Te esperamos. Si al final no puedes venir, avísanos por aquí.',
    placeholders: ['paciente', 'fecha', 'hora', 'lugar'],
  },
  {
    key: 'cita_cancelada_paciente',
    channel: 'telegram',
    subject: null,
    body:
      'Entendido, {paciente}: tu cita del {fecha} a las {hora} quedó cancelada y vuelves a la lista de espera.\n' +
      'Te avisaremos por aquí cuando te asignemos una fecha nueva.',
    placeholders: ['paciente', 'fecha', 'hora'],
  },
  {
    key: 'cita_no_cancelable',
    channel: 'telegram',
    subject: null,
    body:
      'No puedo cancelar esa cita por aquí: {estado}.\n' +
      'Si necesitas cambiarla, habla con el consultorio.',
    placeholders: ['estado'],
  },
  {
    key: 'cita_cancelacion_fuera_de_plazo',
    channel: 'telegram',
    subject: null,
    body:
      '{paciente}: como ya nos confirmaste que vendrías, tu cita del {fecha} ya no se puede cancelar por aquí ' +
      '(no es posible cancelar citas por aquí con un lapso menor a {dias} día (s)).\n' +
      'Llama al consultorio, por favor, y lo vemos juntos.',
    placeholders: ['paciente', 'fecha', 'dias'],
  },
  {
    key: 'sin_citas',
    channel: 'telegram',
    subject: null,
    body:
      'No veo ninguna cita tuya próxima, así que no hay nada que confirmar.\n' +
      'Si crees que es un error, escríbenos por aquí o llama al consultorio y lo miramos.',
    placeholders: [],
  },
];

export const messageTemplateSchema = z.object({
  key: z.string().min(1).max(60),
  channel: z.enum(CHANNELS),
  subject: z.string().max(160).nullable(),
  body: z.string().min(1).max(2000),
  isActive: z.boolean(),
  updatedAt: z.string(),
});

export type MessageTemplate = z.infer<typeof messageTemplateSchema>;

export const messageTemplateInputSchema = z.object({
  subject: z.string().trim().max(160).nullable().optional(),
  body: z.string().trim().min(1, 'El texto no puede quedar vacío').max(2000),
  isActive: z.boolean().optional(),
});

export type MessageTemplateInput = z.infer<typeof messageTemplateInputSchema>;

/** Renderiza una plantilla con sus valores (deja el marcador si falta el dato). */
export const renderMessage = (
  body: string,
  values: Readonly<Record<string, string | null>>,
): string => {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value !== null && value !== undefined) clean[key] = value;
  }
  return renderTemplate(body, clean);
};

/* ── Envíos (bandeja de notificaciones) ────────────────────────────────────── */

export const notificationSchema = z.object({
  id: z.uuid(),
  patientId: z.uuid(),
  patientName: z.string().nullable(),
  appointmentId: z.uuid().nullable(),
  templateKey: z.string(),
  channel: z.enum(CHANNELS),
  recipient: z.string().nullable(),
  status: z.enum(NOTIFICATION_STATUSES),
  attempts: z.number().int().min(0),
  maxAttempts: z.number().int().min(1),
  lastError: z.string().nullable(),
  providerMessageId: z.string().nullable(),
  sentAt: z.string().nullable(),
  nextAttemptAt: z.string().nullable(),
  /** Nota y marca de cuando la secretaría avisó por teléfono. */
  manualNote: z.string().nullable(),
  contactedAt: z.string().nullable(),
  contactedBy: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});

export type NotificationRecord = z.infer<typeof notificationSchema>;

export const notificationFiltersSchema = z.object({
  status: z.enum(NOTIFICATION_STATUSES).optional(),
  channel: z.enum(CHANNELS).optional(),
  search: z.string().trim().max(120).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});

export type NotificationFilters = z.infer<typeof notificationFiltersSchema>;

export const retryNotificationSchema = z.object({
  reason: z.string().trim().max(200).optional(),
});

export type RetryNotificationInput = z.infer<typeof retryNotificationSchema>;

export const markContactedSchema = z.object({
  note: z.string().trim().min(3, 'Escribe cómo fue el contacto').max(300),
});

export type MarkContactedInput = z.infer<typeof markContactedSchema>;

/* ── Canales y vinculación ─────────────────────────────────────────────────── */

export const patientChannelSchema = z.object({
  patientId: z.uuid(),
  patientName: z.string().nullable(),
  channel: z.enum(CHANNELS),
  /** Dirección enmascarada (chat o número): nunca se expone completa en la interfaz. */
  direccionMasked: z.string(),
  usuario: z.string().nullable(),
  linkedAt: z.string().nullable(),
  isBlocked: z.boolean(),
});

export type PatientChannel = z.infer<typeof patientChannelSchema>;

export const linkCodeSchema = z.object({
  patientId: z.uuid(),
  code: z.string().min(4).max(32),
  expiresAt: z.string(),
  /** `https://t.me/<bot>?start=<code>`; vacío si el bot no está configurado. */
  deepLink: z.string(),
  botUsername: z.string().nullable(),
  /** Imagen del QR lista para mostrar (data:image/png;base64,...). */
  qrDataUrl: z.string().nullable().optional(),
});

export type LinkCode = z.infer<typeof linkCodeSchema>;

/* ── Estado de los canales (para la bandeja) ───────────────────────────────── */

/** Estado de un canal registrado: identidad visible y lo que sabe hacer. */
export const channelStatusSchema = z.object({
  canal: z.enum(CHANNEL_IDS),
  nombre: z.string().nullable(),
  usuario: z.string().nullable(),
  conectado: z.boolean(),
  capacidades: z.object({
    botones: z.boolean(),
    documentos: z.boolean(),
    comandos: z.boolean(),
    plantillasAprobadas: z.boolean(),
  }),
});

export type ChannelStatus = z.infer<typeof channelStatusSchema>;

export const botStatusSchema = z.object({
  /** `real` con token configurado; `simulado` sin token (modo de pruebas). */
  mode: z.enum(['real', 'simulado']),
  /**
   * Modo test activo (ADR 0020): los envíos están **bloqueados** y se registran
   * como simulados. La bandeja lo dice para que nadie espere que el paciente
   * reciba el aviso.
   */
  testMode: z.boolean(),
  botUsername: z.string().nullable(),
  botName: z.string().nullable(),
  connected: z.boolean(),
  lastUpdateAt: z.string().nullable(),
  lastError: z.string().nullable(),
  pendingUpdates: z.number().int().min(0),
  conversations: z.array(botConversationSchema),
  /** Todos los canales activos (Telegram, WhatsApp…) con su identidad. */
  canales: z.array(channelStatusSchema),
  counts: z.object({
    queued: z.number().int().min(0),
    sent: z.number().int().min(0),
    failed: z.number().int().min(0),
    manualPending: z.number().int().min(0),
  }),
});

export type BotStatus = z.infer<typeof botStatusSchema>;

/* ── Política de cancelación del paciente (ADR 0057) ───────────────────────── */

/**
 * Configuración editable de la clínica sobre la cancelación por el **paciente**
 * (ADR 0057). Vive en una sola fila de `notification_settings` y la ven y editan
 * **solo el `admin` y el odontólogo** (`scheduling:cancel_policy`).
 *
 * `patientCancelCutoffDays` es el corte: una cita **ya confirmada** no se puede
 * cancelar por el bot cuando le faltan **esos días o menos**. En `0` la regla queda
 * **apagada** y el paciente cancela como siempre; es el valor por defecto a
 * propósito, para que activar la guardia sea una decisión explícita del consultorio.
 */
export const MAX_PATIENT_CANCEL_CUTOFF_DAYS = 30;

export const notificationSettingsSchema = z.object({
  /** Corte en días (0 = sin corte). */
  patientCancelCutoffDays: z.number().int().min(0).max(MAX_PATIENT_CANCEL_CUTOFF_DAYS),
  updatedAt: z.string().nullable(),
  updatedByUserId: z.uuid().nullable(),
});

export type NotificationSettings = z.infer<typeof notificationSettingsSchema>;

export const notificationSettingsInputSchema = z.object({
  patientCancelCutoffDays: z
    .number()
    .int()
    .min(0, 'No puede ser negativo')
    .max(
      MAX_PATIENT_CANCEL_CUTOFF_DAYS,
      `Como mucho ${String(MAX_PATIENT_CANCEL_CUTOFF_DAYS)} días`,
    ),
});

export type NotificationSettingsInput = z.infer<typeof notificationSettingsInputSchema>;

/* ── Sección de citas de la bandeja (ADR 0052) ─────────────────────────────── */

/**
 * Una **cita futura** tal como la pinta la sección de citas de `/notificaciones`:
 * la cita, por dónde se le puede escribir al paciente y cómo está su aviso.
 *
 * El servicio de notificaciones lo compone —pregunta la agenda por su cliente
 * interno, mira el canal vinculado y el último envío de esa cita— porque cruzar eso
 * en la interfaz serían tres consultas y una paginación que no cuadra. La fecha y la
 * hora son las de la cita local del consultorio; la interfaz las formatea.
 */
export const appointmentNotificationItemSchema = z.object({
  appointmentId: z.uuid(),
  patientId: z.uuid(),
  patientName: z.string(),
  patientDocument: z.string().nullable(),
  patientPhone: z.string().nullable(),
  ticket: z.string().nullable(),
  date: z.string(),
  startTime: z.string(),
  endTime: z.string(),
  status: z.enum(APPOINTMENT_STATUSES),
  /** Cuándo confirmó y por dónde; `null` mientras no lo haya hecho. */
  confirmedAt: z.string().nullable(),
  confirmedChannel: z.enum(CHANNELS).nullable(),
  /**
   * Canal vinculado del paciente **enmascarado** (el de verdad no circula): es el
   * «tlg/wa» que dice si hay por dónde avisarle. `null` cuando no tiene ninguno, que
   * es el caso en el que el aviso queda como llamada manual.
   */
  channel: z.enum(CHANNEL_IDS).nullable(),
  direccionMasked: z.string().nullable(),
  /** Último aviso de esta cita, si lo hay: dice si salió, falló o quedó pendiente. */
  lastNotification: z
    .object({
      id: z.uuid(),
      templateKey: z.string(),
      channel: z.enum(CHANNELS),
      status: z.enum(NOTIFICATION_STATUSES),
      sentAt: z.string().nullable(),
      manualNote: z.string().nullable(),
      contactedAt: z.string().nullable(),
    })
    .nullable(),
});

export type AppointmentNotificationItem = z.infer<typeof appointmentNotificationItemSchema>;

export const appointmentNotificationFiltersSchema = z.object({
  /** Rango de fechas de la cita (no del aviso): lo natural para «las próximas». */
  from: z.string().optional(),
  to: z.string().optional(),
  status: z.enum(APPOINTMENT_STATUSES).optional(),
  /** `true` solo las confirmadas; `false` solo las que no lo están. */
  confirmed: queryBoolean,
  search: z.string().trim().max(120).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});

export type AppointmentNotificationFilters = z.infer<typeof appointmentNotificationFiltersSchema>;

/** Máximo de mensajes por chat en la ventana de anti-flood. */
export const ANTI_FLOOD_MAX_MESSAGES = 10;
export const ANTI_FLOOD_WINDOW_SECONDS = 60;
/** Un chat no puede tener dos solicitudes en curso a la vez. */
export const MAX_ACTIVE_REQUESTS_PER_CHAT = 1;
/**
 * Cuántos días hacia adelante mira el asistente cuando el paciente escribe
 * «confirmar» (ADR 0052): son las citas que le ofrece para confirmar. Con un tope,
 * un paciente con muchas citas no recibe una lista interminable de opciones; y como
 * las citas se confirman cerca de su fecha, 60 días cubre el caso real con holgura.
 */
export const BOT_CONFIRM_WINDOW_DAYS = 60;
/** Intentos y espera entre reintentos (segundos): 1 m, 5 m, 15 m, 1 h, 6 h. */
export const NOTIFICATION_RETRY_DELAYS_SECONDS = [60, 300, 900, 3600, 21600] as const;
export const NOTIFICATION_MAX_ATTEMPTS = NOTIFICATION_RETRY_DELAYS_SECONDS.length + 1;
