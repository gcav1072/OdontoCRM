import {
  NO_SHOW_GRACE_MINUTES,
  allowedTransitions,
  formatTime12h,
  type AppointmentStatus,
  type AppointmentSummary,
  type DayView,
  type Permission,
  type Role,
} from '@odontocrm/contracts';

import { apiErrorMessage, isApiError } from './api';
import type { AppointmentsListParams, RequestsListParams } from './endpoints';
import { TIME_ZONE } from './format';
import { APPOINTMENT_STATUS_LABELS, isAppointmentStatus, t, type TranslationKey } from './i18n';

/**
 * Piezas puras de la agenda (Fase 3): claves de consulta, aritmética de fechas
 * del consultorio, acciones válidas según la máquina de estados y el parcheo
 * quirúrgico de la jornada en la caché.
 *
 * El parcheo es lo que evita recargar el día completo al mover una sola cita:
 * la respuesta de cada mutación es una `AppointmentSummary`, así que la vista
 * del día se recalcula en memoria (citas, franjas, contadores y cupo asignado)
 * a partir del estado anterior conocido.
 */

/* ── Claves de consulta ────────────────────────────────────────────────────── */

export const schedulingKeys = {
  /** Vista completa del día (`GET /agenda/days/:date`). */
  day: (date: string) => ['jornada', date] as const,
  /** Todas las vistas de día cargadas: para invalidar en bloque si hiciera falta. */
  daysRoot: ['jornada'] as const,
  requests: (filters: RequestsListParams) => ['solicitudes', filters] as const,
  requestsRoot: ['solicitudes'] as const,
  appointments: (filters: AppointmentsListParams) => ['citas', filters] as const,
  appointmentsRoot: ['citas'] as const,
  history: (appointmentId: string) => ['cita', appointmentId, 'historial'] as const,
  /** Todas las historias de cita cargadas (se invalidan al cambiar un estado). */
  historyRoot: ['cita'] as const,
  capacity: (from: string, to: string) => ['cupos', from, to] as const,
  templates: ['plantillas'] as const,
  notifyPreview: (date: string, appointmentIds: readonly string[] | undefined) =>
    ['aviso', 'vista-previa', date, appointmentIds ?? null] as const,
};

/* ── Fechas y horas del consultorio ────────────────────────────────────────── */

const formateadorIso = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Fecha de hoy (`AAAA-MM-DD`) en la zona del consultorio (`America/Caracas`). */
export const todayInClinic = (now: Date = new Date()): string => formateadorIso.format(now);

/** Desplaza una fecha `AAAA-MM-DD` en días (a mediodía UTC, sin bordes de zona). */
export const shiftDate = (date: string, days: number): string => {
  const base = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(base.getTime())) return date;
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
};

/**
 * `AAAA-MM-DD` → `dd/mm/aaaa` sin desfase: la fecha del día es un día de
 * calendario, no un instante, y `new Date('2026-10-02')` la interpretaría como
 * medianoche UTC (el día anterior en Caracas).
 */
export const formatDateOnly = (date: string): string => {
  const [anio, mes, dia] = date.split('-');
  return anio !== undefined && mes !== undefined && dia !== undefined
    ? `${dia}/${mes}/${anio}`
    : date;
};

/**
 * Instante de una cita. Caracas no aplica horario de verano (UTC−4 todo el
 * año), así que el desplazamiento fijo `-04:00` es exacto.
 */
export const appointmentInstant = (date: string, startTime: string): Date | null => {
  const instante = new Date(`${date}T${startTime}:00-04:00`);
  return Number.isNaN(instante.getTime()) ? null : instante;
};

/** Minutos que faltan para poder marcar la inasistencia (0 = ya se puede). */
export const minutesToNoShow = (
  appointment: AppointmentSummary,
  now: Date = new Date(),
): number => {
  const instante = appointmentInstant(appointment.date, appointment.startTime);
  if (!instante) return 0;
  const limite = instante.getTime() + NO_SHOW_GRACE_MINUTES * 60_000;
  return Math.max(0, Math.ceil((limite - now.getTime()) / 60_000));
};

export const canMarkNoShow = (appointment: AppointmentSummary, now: Date = new Date()): boolean =>
  minutesToNoShow(appointment, now) === 0;

/* ── Rol y acciones de la máquina de estados ───────────────────────────────── */

const ORDEN_ROLES: readonly Role[] = ['admin', 'secretario', 'odontologo', 'pantalla'];

/**
 * Rol efectivo de la sesión. La máquina de estados decide por rol y la API da
 * permisos por rol, así que con varios roles se toma el más capacitado.
 */
export const effectiveRole = (roles: readonly Role[]): Role | null =>
  ORDEN_ROLES.find((rol) => roles.includes(rol)) ?? null;

export type AppointmentAction =
  | 'assign'
  | 'notify'
  | 'confirm'
  | 'check-in'
  | 'call'
  | 'start'
  | 'attend'
  | 'no-show'
  | 'cancel'
  | 'reschedule';

/** Acción de la interfaz que corresponde al estado destino de una transición. */
export const actionForTransition = (to: AppointmentStatus): AppointmentAction | null => {
  switch (to) {
    case 'programada':
      return 'assign';
    case 'notificada':
      return 'notify';
    case 'confirmada':
      // El estado también se mueve por la máquina de estados: la secretaría puede
      // dejar constancia de la confirmación telefónica (ADR 0052).
      return 'confirm';
    case 'en_sala_espera':
      return 'check-in';
    case 'llamado':
      return 'call';
    case 'en_consulta':
      return 'start';
    case 'atendido':
      return 'attend';
    case 'no_asistio':
      return 'no-show';
    case 'cancelada':
      return 'cancel';
    case 'reprogramada':
      return 'reschedule';
    default:
      return null;
  }
};

const ACTION_LABEL_KEYS: Readonly<Record<AppointmentAction, TranslationKey>> = {
  assign: 'programacion.accion.asignar',
  notify: 'programacion.accion.notificar',
  confirm: 'programacion.accion.confirmar',
  'check-in': 'programacion.accion.checkIn',
  call: 'programacion.accion.llamado',
  start: 'programacion.accion.consulta',
  attend: 'programacion.accion.atendido',
  'no-show': 'programacion.accion.inasistencia',
  cancel: 'programacion.accion.cancelar',
  reschedule: 'programacion.accion.reprogramar',
};

/** Etiqueta de la acción; el segundo llamado se distingue (plan §5.1). */
export const actionLabel = (
  action: AppointmentAction,
  appointment?: AppointmentSummary | null,
): string => {
  if (action === 'call' && (appointment?.callCount ?? 0) > 0) {
    return t('programacion.accion.llamado2');
  }
  return t(ACTION_LABEL_KEYS[action]);
};

/** Acciones que exigen `scheduling:write`; el resto se rige por rol y estado. */
const ACCIONES_DE_ESCRITURA: readonly AppointmentAction[] = ['assign', 'cancel', 'reschedule'];

export interface ActionContext {
  role: Role | null;
  hasPermission: (permission: Permission) => boolean;
  now?: Date;
}

/**
 * Acciones válidas de una cita: la máquina de estados decide por estado y rol;
 * encima se aplican los permisos de la API (`scheduling:write`, `scheduling:notify`)
 * y la tolerancia de la inasistencia (hora de la cita + 15 minutos).
 */
export const appointmentActions = (
  appointment: AppointmentSummary,
  context: ActionContext,
): AppointmentAction[] => {
  if (context.role === null) return [];

  return allowedTransitions(appointment.status, context.role)
    .map((transition) => actionForTransition(transition.to))
    .filter((action): action is AppointmentAction => action !== null)
    .filter((action) => {
      if (action === 'no-show') {
        return canMarkNoShow(appointment, context.now ?? new Date());
      }
      if (action === 'notify') return context.hasPermission('scheduling:notify');
      if (ACCIONES_DE_ESCRITURA.includes(action)) {
        return context.hasPermission('scheduling:write');
      }
      return true;
    });
};

/** Variante visual del estado para `Badge`. */
export const statusBadgeVariant = (
  status: AppointmentStatus,
): 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info' => {
  switch (status) {
    case 'programada':
      return 'primary';
    case 'notificada':
      return 'info';
    case 'confirmada':
      // Verde suave: el paciente dijo que sí, pero todavía no ha llegado.
      return 'success';
    case 'en_sala_espera':
    case 'llamado':
    case 'en_consulta':
      return 'warning';
    case 'atendido':
      return 'success';
    case 'no_asistio':
    case 'cancelada':
      return 'danger';
    default:
      return 'neutral';
  }
};

/* ── Parcheo de la jornada en memoria ──────────────────────────────────────── */

/** Estados que ocupan un lugar del cupo del día. */
const ESTADOS_QUE_OCUPAN: readonly AppointmentStatus[] = [
  'programada',
  'notificada',
  // Confirmar no libera la franja: la cita sigue en pie (ADR 0052).
  'confirmada',
  'en_sala_espera',
  'llamado',
  'en_consulta',
  'atendido',
];

export const occupiesCapacity = (status: AppointmentStatus): boolean =>
  ESTADOS_QUE_OCUPAN.includes(status);

type DayCounts = DayView['counts'];

const ajustarContadores = (
  counts: DayCounts,
  status: AppointmentStatus,
  delta: number,
): DayCounts => {
  const siguiente: DayCounts = { ...counts };
  switch (status) {
    case 'programada':
      siguiente.programadas = Math.max(0, siguiente.programadas + delta);
      break;
    case 'notificada':
      siguiente.notificadas = Math.max(0, siguiente.notificadas + delta);
      break;
    case 'confirmada':
      siguiente.confirmadas = Math.max(0, siguiente.confirmadas + delta);
      break;
    case 'en_sala_espera':
    case 'llamado':
    case 'en_consulta':
      siguiente.enSala = Math.max(0, siguiente.enSala + delta);
      break;
    case 'atendido':
      siguiente.atendidas = Math.max(0, siguiente.atendidas + delta);
      break;
    case 'no_asistio':
      siguiente.noAsistio = Math.max(0, siguiente.noAsistio + delta);
      break;
    case 'cancelada':
      siguiente.canceladas = Math.max(0, siguiente.canceladas + delta);
      break;
    default:
      break;
  }
  return siguiente;
};

export interface AppointmentChange {
  /** Cita tal como la devolvió la mutación. */
  appointment: AppointmentSummary;
  /** Estado anterior conocido de esa misma cita, si ya estaba en el día. */
  previous?: AppointmentSummary | null;
}

export interface DayChangeOptions {
  /** Solicitud que sale de la cola del día al convertirse en cita. */
  removeWaitingRequestId?: string | null;
}

const porHora = (left: { startTime: string }, right: { startTime: string }): number =>
  left.startTime.localeCompare(right.startTime);

/**
 * Devuelve una jornada nueva con las citas cambiadas aplicadas: lista de citas,
 * franjas ocupadas, contadores y cupo asignado. Todo por diferencias respecto al
 * estado anterior, sin volver a pedir el día al servidor.
 */
export const applyDayChanges = (
  day: DayView,
  changes: readonly AppointmentChange[],
  options: DayChangeOptions = {},
): DayView => {
  let appointments = [...day.appointments];
  let counts = { ...day.counts };
  let assigned = day.capacity.assigned;
  /** id → cita final, o `null` cuando la cita ya no pertenece a este día. */
  const finales = new Map<string, AppointmentSummary | null>();

  for (const { appointment, previous } of changes) {
    const previa = previous ?? appointments.find((cita) => cita.id === appointment.id) ?? null;

    if (previa) {
      counts = ajustarContadores(counts, previa.status, -1);
      if (previa.date === day.date && occupiesCapacity(previa.status)) assigned -= 1;
    }

    appointments = appointments.filter((cita) => cita.id !== appointment.id);

    if (appointment.date === day.date) {
      appointments = [...appointments, appointment];
      counts = ajustarContadores(counts, appointment.status, 1);
      if (occupiesCapacity(appointment.status)) assigned += 1;
      finales.set(appointment.id, appointment);
    } else {
      finales.set(appointment.id, null);
    }
  }

  appointments.sort(
    (left, right) => porHora(left, right) || left.createdAt.localeCompare(right.createdAt),
  );

  // Las franjas se reconstruyen: se libera la cita que cambió y se ocupa su hora.
  let slots = day.slots.map((slot) =>
    slot.appointment !== null && finales.has(slot.appointment.id)
      ? { ...slot, state: 'libre' as const, appointment: null }
      : slot,
  );

  for (const cita of finales.values()) {
    if (cita === null || cita.status === 'cancelada' || cita.status === 'reprogramada') continue;

    const indice = slots.findIndex((slot) => slot.startTime === cita.startTime);
    const actual = slots[indice];
    if (actual !== undefined) {
      slots[indice] = { ...actual, state: 'ocupada', appointment: cita };
    } else {
      // Hora manual fuera de la rejilla: se añade su propia franja.
      slots = [
        ...slots,
        {
          startTime: cita.startTime,
          endTime: cita.endTime,
          kind: 'manual' as const,
          state: 'ocupada' as const,
          appointment: cita,
        },
      ].sort(porHora);
    }
  }

  const asignados = Math.max(0, assigned);
  const disponibles = day.capacity.capacity - asignados;

  return {
    ...day,
    slots,
    appointments,
    counts,
    capacity: {
      ...day.capacity,
      assigned: asignados,
      available: disponibles,
      isFull: disponibles <= 0,
    },
    waiting:
      options.removeWaitingRequestId === undefined || options.removeWaitingRequestId === null
        ? day.waiting
        : day.waiting.filter((solicitud) => solicitud.id !== options.removeWaitingRequestId),
  };
};

/* ── Errores con datos útiles (RFC 7807) ───────────────────────────────────── */

export interface SchedulingErrorInfo {
  title: string;
  message: string;
  /** Explicación extra a partir de los datos del cuerpo del error. */
  hint: string | null;
}

const leerRegistro = (valor: unknown): Record<string, unknown> | null =>
  typeof valor === 'object' && valor !== null ? (valor as Record<string, unknown>) : null;

const leerTexto = (fuente: Record<string, unknown> | null, clave: string): string | null => {
  const valor = fuente?.[clave];
  return typeof valor === 'string' && valor.length > 0 ? valor : null;
};

const leerNumero = (fuente: Record<string, unknown> | null, clave: string): number | null => {
  const valor = fuente?.[clave];
  return typeof valor === 'number' && Number.isFinite(valor) ? valor : null;
};

const etiquetaDeEstado = (valor: string | null): string =>
  valor !== null && isAppointmentStatus(valor) ? APPOINTMENT_STATUS_LABELS[valor] : (valor ?? '');

/**
 * Traduce un fallo de la agenda a un mensaje con los datos que el servidor
 * manda en la raíz del cuerpo RFC 7807: día completo (`requiresOverbook`),
 * franja ocupada (`slot`), transición no permitida (`allowed`) y el 400 de la
 * tolerancia de inasistencia (basta el `detail`).
 */
export const schedulingErrorInfo = (error: unknown): SchedulingErrorInfo => {
  if (!isApiError(error)) {
    return { title: t('api.titulo.error'), message: apiErrorMessage(error), hint: null };
  }

  const payload = error.payload;
  const message = error.detail;

  if (payload?.['requiresOverbook'] === true) {
    return {
      title: error.title,
      message,
      hint: t('programacion.error.diaCompleto', {
        asignados: leerNumero(payload, 'assigned') ?? 0,
        cupo: leerNumero(payload, 'capacity') ?? 0,
      }),
    };
  }

  const franja = leerRegistro(payload?.['slot']);
  const inicio = leerTexto(franja, 'startTime');
  if (inicio !== null) {
    return {
      title: error.title,
      message,
      hint: t('programacion.error.franjaOcupada', { hora: formatTime12h(inicio) }),
    };
  }

  const permitidas = payload?.['allowed'];
  if (Array.isArray(permitidas)) {
    const nombres = permitidas
      .map((valor) => (typeof valor === 'string' ? etiquetaDeEstado(valor) : ''))
      .filter((nombre) => nombre.length > 0)
      .join(', ');
    return {
      title: error.title,
      message,
      hint: t('programacion.error.transicion', {
        desde: etiquetaDeEstado(leerTexto(payload, 'from')),
        hasta: etiquetaDeEstado(leerTexto(payload, 'to')),
        permitidas: nombres,
      }),
    };
  }

  if (error.status === 403) {
    return { title: error.title, message, hint: t('programacion.error.permiso') };
  }

  return { title: error.title, message, hint: null };
};

/** ¿La cita se puede marcar como inasistencia y aún no pasó la tolerancia? */
export const noShowPending = (
  appointment: AppointmentSummary,
  now: Date = new Date(),
): number | null => {
  if (!allowedTransitions(appointment.status, 'secretario').some((t2) => t2.to === 'no_asistio')) {
    return null;
  }
  const faltan = minutesToNoShow(appointment, now);
  return faltan > 0 ? faltan : null;
};
