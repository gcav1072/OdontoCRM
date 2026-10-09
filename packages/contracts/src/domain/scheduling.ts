import { z } from 'zod';

import {
  APPOINTMENT_STATUSES,
  CHANNELS,
  REQUEST_STATUSES,
  type AppointmentStatus,
  type Channel,
} from './enums.js';
import { queryBoolean } from '../common/optional.js';

/**
 * Agenda: solicitudes (con ticket), citas, cupo diario y plantillas de franjas.
 *
 * Reglas del plan (§4.3, §5.1) que se reflejan aquí:
 * - El consecutivo del ticket lo entrega una secuencia de PostgreSQL: es atómico,
 *   así que dos solicitudes simultáneas nunca reciben el mismo número.
 * - El cupo del día es **editable en cualquier momento**, incluso después de
 *   asignar: bajarlo por debajo de lo ya asignado avisa pero **no borra** citas.
 * - Reprogramar no borra: crea una cita nueva enlazada (`rescheduled_from_id`) y
 *   conserva la original con su ticket trazado.
 * - `no_asistio` solo se puede marcar después de la hora de la cita más la
 *   tolerancia (15 minutos por defecto).
 * - Todo cambio de estado queda en `status_history` con actor, hora y motivo.
 */

export const REQUEST_CHANNELS = CHANNELS;
export type RequestChannel = Channel;

export const SLOT_KINDS = ['franja', 'manual'] as const;
export type SlotKind = (typeof SLOT_KINDS)[number];

/** Hora en formato de 24 h `HH:MM` (en la interfaz se muestra en 12 h). */
export const timeSchema = z
  .string()
  .trim()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'La hora debe ser HH:MM (por ejemplo 08:30)');

export const dateSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'La fecha debe ser AAAA-MM-DD')
  .refine(
    (value) => !Number.isNaN(new Date(`${value}T00:00:00Z`).getTime()),
    'La fecha no es válida',
  );

export const WEEKDAY_NAMES = [
  'domingo',
  'lunes',
  'martes',
  'miércoles',
  'jueves',
  'viernes',
  'sábado',
] as const;

/** Día de la semana (0 = domingo … 6 = sábado) de una fecha `AAAA-MM-DD`, en UTC. */
export const weekdayOf = (date: string): number => new Date(`${date}T00:00:00Z`).getUTCDay();

export const weekdayName = (weekday: number): string => WEEKDAY_NAMES[weekday] ?? '';

/** Suma minutos a una hora `HH:MM` (devuelve `HH:MM`, sin pasar de 23:59). */
export const addMinutes = (time: string, minutes: number): string => {
  const [hours = 0, mins = 0] = time.split(':').map(Number);
  const total = Math.max(0, Math.min(23 * 60 + 59, hours * 60 + mins + minutes));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
};

/** Minutos entre dos horas `HH:MM` (positivo si `end` es posterior). */
export const minutesBetween = (start: string, end: string): number => {
  const [sh = 0, sm = 0] = start.split(':').map(Number);
  const [eh = 0, em = 0] = end.split(':').map(Number);
  return eh * 60 + em - (sh * 60 + sm);
};

/** Hora en formato de 12 h con `a. m.` / `p. m.` (ADR 0025), para mensajes e interfaz. */
export const formatTime12h = (time: string): string => {
  const [hours = 0, mins = 0] = time.split(':').map(Number);
  const suffix = hours < 12 ? 'a. m.' : 'p. m.';
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  return `${hour12}:${String(mins).padStart(2, '0')} ${suffix}`;
};

export const DEFAULT_SLOT_MINUTES = 30;
/** Cupo por defecto cuando no hay plantilla ni cupo explícito para el día. */
export const DEFAULT_DAY_CAPACITY = 16;
/** Tolerancia para marcar una inasistencia (minutos después de la hora de la cita). */
export const DEFAULT_NO_SHOW_GRACE_MINUTES = 15;
export const MAX_DAY_CAPACITY = 100;

export interface TimeRange {
  startTime: string;
  endTime: string;
}

export const timeRangeSchema = z.object({
  startTime: timeSchema,
  endTime: timeSchema,
});

export type TimeRangeInput = z.infer<typeof timeRangeSchema>;

/** ¿Se solapan dos rangos `[inicio, fin)`? */
export const rangesOverlap = (left: TimeRange, right: TimeRange): boolean =>
  left.startTime < right.endTime && right.startTime < left.endTime;

/**
 * Franjas de una plantilla: divide `[inicio, fin]` en tramos de `slotMinutes` y
 * descarta los que caen dentro de una pausa (almuerzo). Es puro a propósito, para
 * que la interfaz pueda pintar la jornada sin pedirla y el servicio validar con la
 * misma función.
 */
export const expandTemplateSlots = (template: {
  startTime: string;
  endTime: string;
  slotMinutes: number;
  breaks: readonly TimeRange[];
}): TimeRange[] => {
  const slots: TimeRange[] = [];
  const step = template.slotMinutes > 0 ? template.slotMinutes : DEFAULT_SLOT_MINUTES;
  let cursor = template.startTime;

  while (minutesBetween(cursor, template.endTime) >= step) {
    const end = addMinutes(cursor, step);
    const slot: TimeRange = { startTime: cursor, endTime: end };
    const inBreak = template.breaks.some((pause) => rangesOverlap(slot, pause));
    if (!inBreak) slots.push(slot);
    cursor = end;
  }
  return slots;
};

/** Plantilla de franjas por día de la semana (una jornada; puede haber varias). */
export const slotTemplateSchema = z.object({
  id: z.uuid(),
  weekday: z.number().int().min(0).max(6),
  startTime: timeSchema,
  endTime: timeSchema,
  slotMinutes: z.number().int().min(5).max(240),
  breaks: z.array(timeRangeSchema),
  isActive: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type SlotTemplate = z.infer<typeof slotTemplateSchema>;

export const slotTemplateInputSchema = z
  .object({
    weekday: z.coerce.number().int().min(0).max(6),
    startTime: timeSchema,
    endTime: timeSchema,
    slotMinutes: z.coerce.number().int().min(5).max(240).default(DEFAULT_SLOT_MINUTES),
    breaks: z.array(timeRangeSchema).max(6).default([]),
    isActive: z.boolean().default(true),
  })
  .superRefine((value, ctx) => {
    if (minutesBetween(value.startTime, value.endTime) < value.slotMinutes) {
      ctx.addIssue({
        code: 'custom',
        path: ['endTime'],
        message: 'La jornada es más corta que la duración de la franja',
      });
    }
    for (const pause of value.breaks) {
      if (minutesBetween(pause.startTime, pause.endTime) <= 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['breaks'],
          message: 'Cada pausa debe terminar después de empezar',
        });
      }
    }
  });

export type SlotTemplateInput = z.infer<typeof slotTemplateInputSchema>;

/**
 * Jornada por defecto del consultorio (plan §16): lunes a viernes de 8:00 a 12:00
 * y de 13:00 a 17:00, franjas de 30 minutos. La migración del servicio la siembra
 * para que el sistema sirva desde el primer día.
 */
export const DEFAULT_SLOT_TEMPLATES: readonly SlotTemplateInput[] = [1, 2, 3, 4, 5].flatMap(
  (weekday) => [
    {
      weekday,
      startTime: '08:00',
      endTime: '12:00',
      slotMinutes: DEFAULT_SLOT_MINUTES,
      breaks: [],
      isActive: true,
    },
    {
      weekday,
      startTime: '13:00',
      endTime: '17:00',
      slotMinutes: DEFAULT_SLOT_MINUTES,
      breaks: [],
      isActive: true,
    },
  ],
);

/* ── Solicitudes (tickets) ─────────────────────────────────────────────────── */

export const createRequestSchema = z.object({
  patientId: z.uuid(),
  /** Copia del nombre para la cola: la ficha viva está en el servicio de pacientes. */
  patientName: z.string().trim().min(3, 'Escribe el nombre del paciente').max(120),
  patientDocument: z.string().trim().max(20).optional(),
  patientPhone: z.string().trim().max(20).optional(),
  channel: z.enum(REQUEST_CHANNELS).default('registro'),
  reason: z.string().trim().min(3, 'Escribe el motivo de la consulta').max(300),
  priority: z.coerce.number().int().min(0).max(9).default(0),
  notes: z.string().trim().max(500).optional(),
  /** Cuándo pidió la cita (el bot puede pasar la hora del mensaje). */
  requestedAt: z.string().datetime({ offset: true }).optional(),
});

export type CreateRequestInput = z.infer<typeof createRequestSchema>;

export const requestSummarySchema = z.object({
  id: z.uuid(),
  ticket: z.string(),
  ticketNumber: z.number().int(),
  channel: z.enum(REQUEST_CHANNELS),
  patientId: z.uuid(),
  patientName: z.string(),
  patientDocument: z.string().nullable(),
  patientPhone: z.string().nullable(),
  reason: z.string(),
  status: z.enum(REQUEST_STATUSES),
  priority: z.number().int(),
  requestedAt: z.string(),
  notes: z.string().nullable(),
  /** Días completos esperando cita (antigüedad para ordenar la cola). */
  waitingDays: z.number().int().min(0),
  appointmentId: z.uuid().nullable(),
  appointmentDate: z.string().nullable(),
  appointmentTime: z.string().nullable(),
  createdAt: z.string(),
});

export type RequestSummary = z.infer<typeof requestSummarySchema>;

export const requestFiltersSchema = z.object({
  status: z.enum(REQUEST_STATUSES).optional(),
  // Ojo: `z.coerce.boolean()` leería `?onlyWaiting=false` como `true` (el clásico
  // `Boolean('false')`), así que se usa el booleano de URL explícito.
  onlyWaiting: queryBoolean,
  channel: z.enum(REQUEST_CHANNELS).optional(),
  search: z.string().trim().max(120).optional(),
  order: z.enum(['ticket', 'antiguedad']).default('ticket'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});

export type RequestFilters = z.infer<typeof requestFiltersSchema>;

export const cancelRequestSchema = z.object({
  reason: z.string().trim().max(300).optional(),
});

export type CancelRequestInput = z.infer<typeof cancelRequestSchema>;

/* ── Citas ─────────────────────────────────────────────────────────────────── */

export const assignAppointmentSchema = z
  .object({
    /** Solicitud que se convierte en cita (si falta, la cita es directa). */
    requestId: z.uuid().optional(),
    patientId: z.uuid().optional(),
    patientName: z.string().trim().min(3).max(120).optional(),
    patientDocument: z.string().trim().max(20).optional(),
    patientPhone: z.string().trim().max(20).optional(),
    date: dateSchema,
    startTime: timeSchema,
    /** Duración en minutos; si falta se usa la de la franja o la del día. */
    durationMinutes: z.coerce.number().int().min(5).max(240).optional(),
    slotKind: z.enum(SLOT_KINDS).default('franja'),
    dentistId: z.uuid().optional(),
    chairId: z.uuid().optional(),
    notes: z.string().trim().max(500).optional(),
    /** Sobrecupo: exige permiso `scheduling:overbook` y motivo. */
    authorizeOverbook: z.boolean().default(false),
    overbookReason: z.string().trim().max(300).optional(),
  })
  .superRefine((value, ctx) => {
    if (
      value.requestId === undefined &&
      (value.patientId === undefined || value.patientName === undefined)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['patientId'],
        message: 'Indica la solicitud o, si la cita es directa, el paciente',
      });
    }
    if (value.authorizeOverbook && (value.overbookReason ?? '').length < 3) {
      ctx.addIssue({
        code: 'custom',
        path: ['overbookReason'],
        message: 'El sobrecupo necesita un motivo',
      });
    }
  });

export type AssignAppointmentInput = z.infer<typeof assignAppointmentSchema>;

export const rescheduleAppointmentSchema = z.object({
  date: dateSchema,
  startTime: timeSchema,
  durationMinutes: z.coerce.number().int().min(5).max(240).optional(),
  slotKind: z.enum(SLOT_KINDS).default('franja'),
  reason: z.string().trim().max(300).optional(),
  authorizeOverbook: z.boolean().default(false),
  overbookReason: z.string().trim().max(300).optional(),
});

export type RescheduleAppointmentInput = z.infer<typeof rescheduleAppointmentSchema>;

export const appointmentSummarySchema = z.object({
  id: z.uuid(),
  requestId: z.uuid().nullable(),
  ticket: z.string().nullable(),
  ticketNumber: z.number().int().nullable(),
  patientId: z.uuid(),
  patientName: z.string(),
  patientDocument: z.string().nullable(),
  patientPhone: z.string().nullable(),
  date: z.string(),
  startTime: z.string(),
  endTime: z.string(),
  durationMinutes: z.number().int(),
  slotKind: z.enum(SLOT_KINDS),
  status: z.enum(APPOINTMENT_STATUSES),
  callCount: z.number().int().min(0),
  /** Cuándo y por dónde confirmó el paciente su asistencia (ADR 0052). */
  confirmedAt: z.string().nullable(),
  confirmedChannel: z.enum(CHANNELS).nullable(),
  /**
   * Cuándo y por dónde se canceló la cita (ADR 0053). Un canal de paciente
   * (`telegram`/`whatsapp`) es lo que distingue «la canceló el paciente» de «la
   * canceló la secretaría», que es justo lo que mira el KPI de reportes.
   */
  cancelledAt: z.string().nullable(),
  cancelledChannel: z.enum(CHANNELS).nullable(),
  dentistId: z.uuid().nullable(),
  chairId: z.uuid().nullable(),
  checkedInAt: z.string().nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  noShowReason: z.string().nullable(),
  /** Motivo del «atendido» cuando aún no hay sesión clínica (Fase 6). */
  forceAttendedReason: z.string().nullable(),
  /**
   * Sesión clínica **cerrada** que respalda el «atendido» (Fase 7): si está
   * presente, la cita se atendió con su evolución hecha y no hizo falta motivo.
   */
  clinicalSessionId: z.uuid().nullable(),
  rescheduledFromId: z.uuid().nullable(),
  rescheduledToId: z.uuid().nullable(),
  icsSequence: z.number().int().min(0),
  notes: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type AppointmentSummary = z.infer<typeof appointmentSummarySchema>;

export const appointmentFiltersSchema = z.object({
  date: dateSchema.optional(),
  from: dateSchema.optional(),
  to: dateSchema.optional(),
  status: z.enum(APPOINTMENT_STATUSES).optional(),
  /** Filtra por asistencia confirmada: `true` confirmadas, `false` sin confirmar. */
  confirmed: queryBoolean,
  patientId: z.uuid().optional(),
  search: z.string().trim().max(120).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

export type AppointmentFilters = z.infer<typeof appointmentFiltersSchema>;

/** Motivo obligatorio del «atendido» forzado mientras no exista historia clínica. */
export const attendAppointmentSchema = z.object({
  forceReason: z.string().trim().min(3, 'Indica por qué se marca atendido').max(300).optional(),
  /** Fase 6: identificador de la sesión clínica cerrada que respalda el «atendido». */
  clinicalSessionId: z.uuid().optional(),
});

export type AttendAppointmentInput = z.infer<typeof attendAppointmentSchema>;

export const noShowAppointmentSchema = z.object({
  reason: z.string().trim().max(300).optional(),
});

export type NoShowAppointmentInput = z.infer<typeof noShowAppointmentSchema>;

export const cancelAppointmentSchema = z.object({
  reason: z.string().trim().max(300).optional(),
});

export type CancelAppointmentInput = z.infer<typeof cancelAppointmentSchema>;

/**
 * Cancelación por el **bot** ([ADR 0053](../../../../docs/adr/0053-cancelacion-de-citas-por-el-paciente.md)).
 *
 * Es un schema aparte del público a propósito: el interno exige el **canal** por el
 * que canceló el paciente —dato que se guarda y que distingue «cancelada por el
 * paciente» de «cancelada por la secretaría» en la tarjeta y en el KPI—. Al no estar
 * en el schema público, ese campo no se puede forjar por la ruta `/api/v1/appointments/:id/cancel`.
 */
export const cancelAppointmentBotSchema = z.object({
  channel: z.enum(CHANNELS),
  /**
   * El cliente interno del bot manda `null` cuando el paciente no escribe motivo
   * (igual que el de confirmación manda `note: null`). `.nullish()` acepta
   * `null | undefined`; con `.optional()` Zod 4 solo aceptaría `undefined` y
   * rechazaría el `null` con un 400 que dejaba al paciente sin poder cancelar.
   */
  reason: z.string().trim().max(300).nullish(),
});

export type CancelAppointmentBotInput = z.infer<typeof cancelAppointmentBotSchema>;

/**
 * Filtros de la lista de **cancelaciones hechas por el paciente** (ADR 0053): lo que
 * alimenta la tarjeta de `/programacion`. El rango va sobre `cancelled_at`.
 */
export const appointmentCancellationFiltersSchema = z.object({
  from: dateSchema.optional(),
  to: dateSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export type AppointmentCancellationFilters = z.infer<typeof appointmentCancellationFiltersSchema>;

/* ── Novedades de citas (feed de /inicio, ADR 0057) ────────────────────────── */

/**
 * Lo que hace el **paciente** con su cita, que es lo que se cuenta como novedad:
 *
 *  - `confirmada`: le dieron cita y confirmó (sigue en pie);
 *  - `cancelada`: le dieron cita y canceló **sin confirmar antes**;
 *  - `confirmada_y_cancelada`: confirmó primero y luego se arrepintió.
 *
 * El tercero se distingue del segundo por la **fecha de confirmación** de la cita:
 * es el caso «dio cita, aceptó, me arrepentí» del plan.
 */
export const APPOINTMENT_ACTIVITY_KINDS = [
  'confirmada',
  'cancelada',
  'confirmada_y_cancelada',
] as const;
export type AppointmentActivityKind = (typeof APPOINTMENT_ACTIVITY_KINDS)[number];

export const appointmentActivityItemSchema = z.object({
  id: z.uuid(),
  appointmentId: z.uuid(),
  kind: z.enum(APPOINTMENT_ACTIVITY_KINDS),
  patientId: z.uuid(),
  patientName: z.string(),
  patientDocument: z.string().nullable(),
  /** Fecha y hora de la cita (no del evento): es lo que le importa a quien mira). */
  date: z.string(),
  startTime: z.string(),
  endTime: z.string(),
  /** Canal por el que actuó el paciente (`telegram`/`whatsapp`). */
  channel: z.enum(CHANNELS),
  /** Cuándo ocurrió (confirmación o cancelación). */
  occurredAt: z.string(),
});

export type AppointmentActivityItem = z.infer<typeof appointmentActivityItemSchema>;

export const appointmentActivityFiltersSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export type AppointmentActivityFilters = z.infer<typeof appointmentActivityFiltersSchema>;

/**
 * Confirmación de la cita ([ADR 0052](../../../docs/adr/0052-confirmacion-de-citas-por-el-paciente.md)).
 *
 * `channel` dice **por dónde** confirmó el paciente: `telegram`/`whatsapp` si lo hizo
 * por el bot, `telefono` si lo apuntó la secretaría al llamarlo. Es un dato, no una
 * decoración: permite saber qué canal funciona y quién se enteró de qué.
 */
export const confirmAppointmentSchema = z.object({
  channel: z.enum(CHANNELS),
  /**
   * La secretaría puede llamar sin nota y el bot manda `note: null` siempre; en los
   * dos casos «sin dato» es `null`, que es lo que acepta `.nullish()` (con
   * `.optional()` Zod 4 rechazaba el `null` del bot con un 400).
   */
  note: z.string().trim().max(300).nullish(),
});

export type ConfirmAppointmentInput = z.infer<typeof confirmAppointmentSchema>;

/* ── Cupo del día ──────────────────────────────────────────────────────────── */

export const setCapacitySchema = z.object({
  date: dateSchema,
  capacity: z.coerce.number().int().min(0).max(MAX_DAY_CAPACITY),
  notes: z.string().trim().max(300).optional(),
  reason: z.string().trim().max(300).optional(),
});

export type SetCapacityInput = z.infer<typeof setCapacitySchema>;

export const capacitySourceSchema = z.enum(['explicito', 'plantilla', 'defecto']);
export type CapacitySource = z.infer<typeof capacitySourceSchema>;

export const dayCapacitySchema = z.object({
  date: z.string(),
  /** Cupo que se aplica (explícito si existe; si no, deducido de las franjas). */
  capacity: z.number().int().min(0),
  source: capacitySourceSchema,
  explicitCapacity: z.number().int().nullable(),
  notes: z.string().nullable(),
  assigned: z.number().int().min(0),
  available: z.number().int(),
  isFull: z.boolean(),
  /** Aviso cuando el cupo queda por debajo de lo ya asignado (no borra nada). */
  warning: z.string().nullable(),
  updatedBy: z.uuid().nullable(),
  updatedAt: z.string().nullable(),
});

export type DayCapacity = z.infer<typeof dayCapacitySchema>;

/* ── Vista de la jornada ───────────────────────────────────────────────────── */

export const slotStateSchema = z.enum(['libre', 'ocupada', 'fuera_de_jornada']);
export type SlotState = z.infer<typeof slotStateSchema>;

export const daySlotSchema = z.object({
  startTime: z.string(),
  endTime: z.string(),
  kind: z.enum(SLOT_KINDS),
  state: slotStateSchema,
  appointment: appointmentSummarySchema.nullable(),
});

export type DaySlot = z.infer<typeof daySlotSchema>;

export const dayViewSchema = z.object({
  date: z.string(),
  weekday: z.number().int(),
  weekdayName: z.string(),
  isWorkingDay: z.boolean(),
  capacity: dayCapacitySchema,
  slots: z.array(daySlotSchema),
  appointments: z.array(appointmentSummarySchema),
  waiting: z.array(requestSummarySchema),
  counts: z.object({
    programadas: z.number().int().min(0),
    notificadas: z.number().int().min(0),
    confirmadas: z.number().int().min(0),
    enSala: z.number().int().min(0),
    atendidas: z.number().int().min(0),
    noAsistio: z.number().int().min(0),
    canceladas: z.number().int().min(0),
  }),
});

export type DayView = z.infer<typeof dayViewSchema>;

/* ── Historial de estados ──────────────────────────────────────────────────── */

export const statusHistoryEntrySchema = z.object({
  id: z.uuid(),
  entityType: z.enum(['request', 'appointment']),
  entityId: z.uuid(),
  fromStatus: z.enum(APPOINTMENT_STATUSES).nullable(),
  toStatus: z.enum(APPOINTMENT_STATUSES),
  reason: z.string().nullable(),
  actorId: z.uuid().nullable(),
  actorUsername: z.string().nullable(),
  occurredAt: z.string(),
});

export type StatusHistoryEntry = z.infer<typeof statusHistoryEntrySchema>;

/* ── Aviso al paciente (vista previa del lote) ─────────────────────────────── */

export const APPOINTMENT_CONFIRMATION_TEMPLATE_KEY = 'appointment_confirmation';

/**
 * Plantilla por defecto del aviso de cita. En la Fase 4 se siembra en
 * `message_templates` (notifications) para poder editarla sin recompilar; aquí
 * vive la versión canónica, que es la que usa la vista previa del lote.
 */
export const APPOINTMENT_CONFIRMATION_TEMPLATE = {
  key: APPOINTMENT_CONFIRMATION_TEMPLATE_KEY,
  subject: 'Confirmación de tu cita',
  // Ojo con la puntuación: la hora en 12 h ya termina en «a. m.» o «p. m.».
  //
  // El aviso **invita a responder** (ADR 0052): «confirmar» si asistirá o «cancelar»
  // si no puede, que es la petición de la ADR 0053. No dice «quedó confirmada»: avisar
  // y confirmar son hechos distintos.
  body:
    'Hola {paciente}: te esperamos el {fecha} a las {hora}\n' +
    'Lugar: {lugar}\n' +
    'Tu ticket es {ticket}. Responde «confirmar» (o pulsa el botón) para avisarnos de que asistirás; si no puedes, aprieta (cancelar) o escribe cancelar para revocarte la cita.',
} as const;

/**
 * Sustituye `{clave}` por su valor; deja el marcador si falta el dato.
 *
 * Se usa un grupo posicional y no uno con nombre a propósito: en el reemplazo de
 * cadenas, un grupo con nombre llega como objeto en un argumento distinto y es
 * fácil sustituir por error.
 */
export const renderTemplate = (
  template: string,
  values: Readonly<Record<string, string>>,
): string => template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key: string) => values[key] ?? match);

export const notifyPreviewItemSchema = z.object({
  appointmentId: z.uuid(),
  ticket: z.string().nullable(),
  patientId: z.uuid(),
  patientName: z.string(),
  patientPhone: z.string().nullable(),
  channel: z.enum(REQUEST_CHANNELS),
  date: z.string(),
  startTime: z.string(),
  endTime: z.string(),
  place: z.string(),
  subject: z.string(),
  body: z.string(),
  /** `false` cuando la cita no está en un estado notificable o ya se notificó. */
  willSend: z.boolean(),
  skipReason: z.string().nullable(),
});

export type NotifyPreviewItem = z.infer<typeof notifyPreviewItemSchema>;

export const notifyBatchSchema = z.object({
  date: z.string(),
  count: z.number().int().min(0),
  willSendCount: z.number().int().min(0),
  items: z.array(notifyPreviewItemSchema),
});

export type NotifyBatch = z.infer<typeof notifyBatchSchema>;

export const notifyPreviewSchema = z.object({
  date: dateSchema.optional(),
  /** Si se indica, solo se preparan estas citas (reenvío individual). */
  appointmentIds: z.array(z.uuid()).max(200).optional(),
});

export type NotifyPreviewInput = z.infer<typeof notifyPreviewSchema>;

export const notifyBatchInputSchema = notifyPreviewSchema.extend({
  /** Reenvía aunque la cita ya figure como notificada. */
  force: z.boolean().default(false),
});

export type NotifyBatchInput = z.infer<typeof notifyBatchInputSchema>;

export const notifyBatchResultSchema = z.object({
  date: z.string(),
  notified: z.number().int().min(0),
  skipped: z.number().int().min(0),
  appointments: z.array(appointmentSummarySchema),
});

export type NotifyBatchResult = z.infer<typeof notifyBatchResultSchema>;

/** Estados desde los que tiene sentido avisar al paciente. */
export const NOTIFIABLE_STATUSES: readonly AppointmentStatus[] = ['programada'];

/**
 * Estados desde los que el **paciente** puede cancelar su cita desde el bot
 * ([ADR 0053](../../../../docs/adr/0053-cancelacion-de-citas-por-el-paciente.md)): los
 * que todavía no han llegado al consultorio. A partir de `en_sala_espera` el paciente ya
 * está aquí (o en consulta), así que cancelar por chat no tiene sentido.
 *
 * Vive en el contrato para que la agenda y el asistente del bot compartan **la misma**
 * lista: si divergieran, el bot ofrecería cancelar lo que la agenda rechaza.
 */
export const CANCELLABLE_STATUSES: readonly AppointmentStatus[] = [
  'programada',
  'notificada',
  'confirmada',
];
