import { z } from 'zod';

import {
  CLINICAL_ALERT_LABELS,
  clinicalAlertFlagKind,
  clinicalAlertSeverity,
  type ClinicalAlert,
} from './clinical.js';
import { SCREEN_KINDS, type ScreenKind } from './enums.js';

/**
 * Pantallas de sala de espera y consultorio (Fase 5).
 *
 * El servicio `screens` es el **dueño del estado de la sala**: consume los eventos
 * de agenda (`checked_in`, `called`, `in_consultation`, `attended`, `no_show`) y
 * mantiene una proyección propia (`room_state`) más el histórico de llamados
 * (`call_events`). Las pantallas kiosko se autentican con un **token de
 * dispositivo** (rol `pantalla`, solo `screens:display`) y se actualizan por
 * **SSE**, que es unidireccional y sobrevive a reconexiones.
 */

/* ── Dispositivos ──────────────────────────────────────────────────────────── */

/** Ajustes de una pantalla: lo que se puede cambiar sin tocar el código. */
export const screenSettingsSchema = z.object({
  /** Leer el llamado en voz alta (displaylobby). */
  voz: z.boolean().default(true),
  /** Volumen de la voz, de 0 a 1. */
  volumen: z.number().min(0).max(1).default(1),
  /** Cuántos segundos se resalta el llamado en pantalla. */
  resalteSegundos: z.coerce.number().int().min(3).max(120).default(20),
  /** Repetir el llamado en voz alta a los N segundos (0 = no repetir). */
  repetirSegundos: z.coerce.number().int().min(0).max(300).default(0),
});

export type ScreenSettings = z.infer<typeof screenSettingsSchema>;

export const SCREEN_SETTINGS_DEFAULT: ScreenSettings = screenSettingsSchema.parse({});

/** Alta de una pantalla: el token lo genera identity y aquí se guarda su id. */
export const screenDeviceInputSchema = z.object({
  label: z.string().trim().min(3, 'Ponle un nombre a la pantalla').max(60),
  kind: z.enum(SCREEN_KINDS),
  /** Id del token de dispositivo que emitió identity (`POST /api/v1/devices`). */
  tokenId: z.uuid(),
  settings: screenSettingsSchema.partial().optional(),
});

export type ScreenDeviceInput = z.infer<typeof screenDeviceInputSchema>;

export const screenDeviceUpdateSchema = z.object({
  label: z.string().trim().min(3).max(60).optional(),
  settings: screenSettingsSchema.partial().optional(),
  isActive: z.boolean().optional(),
  /**
   * **Reemitir el enlace**: apunta la pantalla a un token de dispositivo nuevo
   * (`POST /api/v1/devices`) y deja de reconocer el anterior. Es la única forma de
   * volver a dar el enlace, porque del token solo se guarda el hash: quien lo perdió
   * (o quiere configurar otro equipo) pide uno nuevo desde la interfaz.
   */
  tokenId: z.uuid().optional(),
});

export type ScreenDeviceUpdate = z.infer<typeof screenDeviceUpdateSchema>;

export interface ScreenDevice {
  id: string;
  tokenId: string | null;
  label: string;
  kind: ScreenKind;
  isActive: boolean;
  settings: ScreenSettings;
  /** Última vez que la pantalla pidió datos o abrió su conexión en vivo. */
  lastSeenAt: string | null;
  createdAt: string;
}

export interface ScreenDeviceList {
  items: ScreenDevice[];
  total: number;
}

/* ── Sala de espera y consultorio ──────────────────────────────────────────── */

/** Estados en los que puede estar una cita dentro de la sala. */
export const ROOM_STATES = ['en_sala_espera', 'llamado', 'en_consulta'] as const;
export type RoomState = (typeof ROOM_STATES)[number];

/** Alerta clínica que la pantalla del consultorio resalta (alergias, crónicos…). */
export const criticalFlagSchema = z.object({
  tipo: z.enum(['alergia', 'cronico', 'medicamento', 'anticoagulante', 'otro']),
  etiqueta: z.string().trim().min(1).max(120),
  /** `alto` pinta en rojo; `medio` en ámbar; `info` en neutro. */
  severidad: z.enum(['alto', 'medio', 'info']).default('info'),
  detalle: z.string().trim().max(300).nullable().default(null),
});

export type CriticalFlag = z.infer<typeof criticalFlagSchema>;

export const criticalFlagsInputSchema = z.object({
  appointmentId: z.uuid(),
  flags: z.array(criticalFlagSchema).max(20),
});

export type CriticalFlagsInput = z.infer<typeof criticalFlagsInputSchema>;

/**
 * Traduce las **alertas clínicas** de la historia a los datos críticos que pinta
 * la pantalla del consultorio: el mismo dato, con el semáforo de riesgo que el
 * doctor lee de reojo antes de entrar. La alergia a la penicilina va en rojo y con
 * su nombre; el texto libre del «otros» va debajo, en pequeño.
 */
export const criticalFlagsFromAlerts = (alerts: readonly ClinicalAlert[]): CriticalFlag[] =>
  alerts.slice(0, 20).map((alert) => ({
    tipo: clinicalAlertFlagKind(alert.code),
    etiqueta: CLINICAL_ALERT_LABELS[alert.code] ?? alert.code,
    severidad: clinicalAlertSeverity(alert.code),
    detalle: alert.detail,
  }));

/** Un llamado en la sala: el 2.º se resalta en rojo en el displaylobby. */
export interface CallEvent {
  id: string;
  appointmentId: string;
  patientDisplayName: string;
  /** Número de turno (el ticket sin formatear), si la cita tenía solicitud. */
  turnNumber: number | null;
  ticket: string | null;
  callNumber: number;
  chairLabel: string;
  calledAt: string;
  calledBy: string | null;
}

/** Estado que pinta el **displaylobby**. */
export interface LobbyState {
  /** Llamados, del más reciente al más antiguo. */
  calls: CallEvent[];
  /** Pacientes sentados en la sala (esperando su llamado). */
  waitingCount: number;
  /** Última actualización del estado (para la cabecera de la pantalla). */
  updatedAt: string;
}

/** Estado que pinta la **pantalla del consultorio**. */
export interface ConsultationState {
  appointmentId: string | null;
  patientId: string | null;
  patientName: string | null;
  /** Nombre abreviado para pantalla: «Juan P.». */
  patientDisplayName: string | null;
  age: number | null;
  sex: string | null;
  ticket: string | null;
  /** Motivo de la consulta, tal como lo escribió el paciente. */
  reason: string | null;
  /** Desde cuándo está en el consultorio. */
  since: string | null;
  /** Datos críticos que la pantalla resalta (llegan de la historia clínica). */
  criticalFlags: CriticalFlag[];
  /** Pacientes esperando en la sala, para el contexto del doctor. */
  waitingCount: number;
  updatedAt: string;
}

/** Tipos de evento del flujo SSE: el cliente solo tiene que reemplazar el estado. */
export const SCREEN_STREAM_EVENTS = ['lobby', 'consultorio', 'latido'] as const;
export type ScreenStreamEvent = (typeof SCREEN_STREAM_EVENTS)[number];

/** Trama SSE ya formateada (un evento por trama, con `id` para `Last-Event-ID`). */
export const formatSseFrame = (input: {
  id: string;
  evento: ScreenStreamEvent;
  datos: unknown;
}): string => `id: ${input.id}\nevent: ${input.evento}\ndata: ${JSON.stringify(input.datos)}\n\n`;

/** Comentario de keepalive: evita que el proxy cierre la conexión inactiva. */
export const SSE_KEEPALIVE = ': latido\n\n';

/* ── Ayudas de presentación ────────────────────────────────────────────────── */

/**
 * Nombre abreviado para las pantallas: «Juan Pérez Gómez» → «Juan P.».
 * Con una sola palabra se muestra tal cual; nunca se inventa nada.
 */
export const abbreviateName = (fullName: string): string => {
  const partes = fullName
    .trim()
    .split(/\s+/)
    .filter((parte) => parte.length > 0);
  const primero = partes[0];
  if (primero === undefined) return '';
  const segundo = partes[1];
  if (segundo === undefined) return primero;
  return `${primero} ${segundo.charAt(0).toLocaleUpperCase('es-VE')}.`;
};

/** Edad cumplida a una fecha (por defecto, hoy). Devuelve `null` si no hay fecha. */
export const ageAt = (
  birthDate: string | null | undefined,
  at: Date = new Date(),
): number | null => {
  if (birthDate === null || birthDate === undefined || birthDate.trim() === '') return null;
  const match = /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})/.exec(birthDate.trim());
  if (match?.groups === undefined) return null;

  const year = Number(match.groups['year']);
  const month = Number(match.groups['month']);
  const day = Number(match.groups['day']);
  // La edad se calcula en UTC: las fechas son días, no instantes (hallazgo Fase 2).
  const today = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  const born = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(born.getTime()) || born.getTime() > today.getTime()) return null;

  let age = today.getUTCFullYear() - born.getUTCFullYear();
  const antesDelCumple =
    today.getUTCMonth() < born.getUTCMonth() ||
    (today.getUTCMonth() === born.getUTCMonth() && today.getUTCDate() < born.getUTCDate());
  if (antesDelCumple) age -= 1;
  return age;
};
