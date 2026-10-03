import {
  SCREEN_SETTINGS_DEFAULT,
  abbreviateName,
  ageAt,
  parseTicket,
  screenSettingsSchema,
  ticketSequence,
  type CallEvent,
  type ConsultationState,
  type CriticalFlag,
  type LobbyState,
  type ScreenDevice,
  type ScreenDeviceInput,
  type ScreenDeviceUpdate,
  type ScreenSettings,
} from '@odontocrm/contracts';
import { NotFoundError } from '@odontocrm/kernel';
import type { DomainEvent } from '@odontocrm/events';
import { EVENT_TOPICS } from '@odontocrm/events';
import { and, asc, count, desc, eq, gte, inArray, isNull } from 'drizzle-orm';

import type { ScreensConfig } from '../config.js';
import type { ScreensDb } from '../db/client.js';
import {
  callEvents,
  roomState,
  screenDevices,
  type CallEventRow,
  type RoomStateRow,
  type ScreenDeviceRow,
} from '../db/schema.js';

/* ── Dispositivos ──────────────────────────────────────────────────────────── */

export const toScreenDevice = (row: ScreenDeviceRow): ScreenDevice => ({
  id: row.id,
  tokenId: row.tokenId,
  label: row.label,
  kind: row.kind as ScreenDevice['kind'],
  isActive: row.isActive,
  settings: screenSettingsSchema.parse(row.settings ?? {}),
  lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
});

export const listDevices = async (db: ScreensDb): Promise<ScreenDevice[]> => {
  const rows = await db.select().from(screenDevices).orderBy(asc(screenDevices.label));
  return rows.map(toScreenDevice);
};

export const createDevice = async (
  db: ScreensDb,
  input: ScreenDeviceInput,
): Promise<ScreenDevice> => {
  const settings: ScreenSettings = {
    ...SCREEN_SETTINGS_DEFAULT,
    ...(input.settings ?? {}),
  };

  const rows = await db
    .insert(screenDevices)
    .values({
      label: input.label,
      kind: input.kind,
      tokenId: input.tokenId,
      settings: { ...settings },
    })
    .returning();

  const row = rows[0];
  if (row === undefined) throw new NotFoundError('No se pudo registrar la pantalla');
  return toScreenDevice(row);
};

export const updateDevice = async (
  db: ScreensDb,
  id: string,
  input: ScreenDeviceUpdate,
): Promise<ScreenDevice> => {
  const current = await deviceById(db, id);
  const settings: ScreenSettings = {
    ...toScreenDevice(current).settings,
    ...(input.settings ?? {}),
  };

  const rows = await db
    .update(screenDevices)
    .set({
      ...(input.label === undefined ? {} : { label: input.label }),
      ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
      settings: { ...settings },
      updatedAt: new Date(),
    })
    .where(eq(screenDevices.id, id))
    .returning();

  const row = rows[0];
  if (row === undefined) throw new NotFoundError('La pantalla no existe');
  return toScreenDevice(row);
};

export const deactivateDevice = async (db: ScreensDb, id: string): Promise<void> => {
  const rows = await db
    .update(screenDevices)
    .set({ isActive: false, updatedAt: new Date() })
    .where(eq(screenDevices.id, id))
    .returning({ id: screenDevices.id });
  if (rows[0] === undefined) throw new NotFoundError('La pantalla no existe');
};

export const deviceById = async (db: ScreensDb, id: string): Promise<ScreenDeviceRow> => {
  const rows = await db.select().from(screenDevices).where(eq(screenDevices.id, id)).limit(1);
  const row = rows[0];
  if (row === undefined) throw new NotFoundError('La pantalla no existe');
  return row;
};

/** Pantalla activa dueña de un token de dispositivo (el `sub` del JWT kiosko). */
export const deviceByTokenId = async (
  db: ScreensDb,
  tokenId: string,
): Promise<ScreenDeviceRow | null> => {
  const rows = await db
    .select()
    .from(screenDevices)
    .where(and(eq(screenDevices.tokenId, tokenId), eq(screenDevices.isActive, true)))
    .limit(1);
  return rows[0] ?? null;
};

/**
 * Marca la pantalla como viva. Se llama en cada consulta de estado y al abrir el
 * flujo en vivo; se salta la escritura si el último latido es reciente.
 */
export const touchDevice = async (db: ScreensDb, id: string, now = new Date()): Promise<void> => {
  const rows = await db
    .select({ lastSeenAt: screenDevices.lastSeenAt })
    .from(screenDevices)
    .where(eq(screenDevices.id, id))
    .limit(1);
  const last = rows[0]?.lastSeenAt ?? null;
  if (last !== null && now.getTime() - last.getTime() < 30_000) return;

  await db.update(screenDevices).set({ lastSeenAt: now }).where(eq(screenDevices.id, id));
};

/* ── Proyección de la sala ─────────────────────────────────────────────────── */

interface EventAppointment {
  id: string;
  date: string | null;
  startTime: string | null;
  status: string | null;
}

interface EventNotification {
  patientId: string | null;
  patientName: string | null;
  ticket: string | null;
  reason: string | null;
}

const readPayload = (
  event: DomainEvent,
): { appointment: EventAppointment | null; notification: EventNotification | null } => {
  const cita = event.payload['appointment'];
  const aviso = event.payload['notification'];

  const appointment =
    typeof cita === 'object' && cita !== null && typeof (cita as { id?: unknown }).id === 'string'
      ? (cita as unknown as EventAppointment)
      : null;

  const notification =
    typeof aviso === 'object' && aviso !== null
      ? {
          patientId:
            typeof (aviso as { patientId?: unknown }).patientId === 'string'
              ? (aviso as { patientId: string }).patientId
              : null,
          patientName:
            typeof (aviso as { patientName?: unknown }).patientName === 'string'
              ? (aviso as { patientName: string }).patientName
              : null,
          ticket:
            typeof (aviso as { ticket?: unknown }).ticket === 'string'
              ? (aviso as { ticket: string }).ticket
              : null,
          reason:
            typeof (aviso as { reason?: unknown }).reason === 'string'
              ? (aviso as { reason: string }).reason
              : null,
        }
      : null;

  return { appointment, notification };
};

/** Datos del paciente para la pantalla (fecha de nacimiento y sexo), best-effort. */
export interface PatientLookup {
  birthDate: string | null;
  sex: string | null;
}

export interface EstadoDeps {
  db: ScreensDb;
  config: ScreensConfig;
  /** Ficha del paciente por id: si falla, la cita entra igual (sin edad ni sexo). */
  patientLookup?: (patientId: string) => Promise<PatientLookup | null>;
}

/**
 * Orden de avance dentro de la sala. Sirve para no retroceder: un `checked_in`
 * que llegue después de un `called` no puede devolver al paciente a «esperando».
 */
const RANGO_ESTADO: Readonly<Record<'en_sala_espera' | 'llamado' | 'en_consulta', number>> = {
  en_sala_espera: 1,
  llamado: 2,
  en_consulta: 3,
};

interface UpsertInput {
  appointmentId: string;
  patientId: string | null;
  patientName: string;
  ticket: string | null;
  reason: string | null;
  estado: 'en_sala_espera' | 'llamado' | 'en_consulta';
  chairLabel: string;
  birthDate?: string | null;
  sex?: string | null;
  /** Hora del **evento** (no la de ahora): la proyección se ordena por ella. */
  cuando: Date;
  /** `true` cuando la cita sale de la sala (atendida, inasistencia, cancelada). */
  salida?: boolean;
}

/**
 * Aplica un cambio de estado a la sala respetando el **orden de los eventos**:
 * la cola puede entregar en un mismo lote `called` y `checked_in` en cualquier
 * orden, así que un evento viejo nunca retrocede el estado ni resucita a quien ya
 * salió (la fila se conserva como lápida con `left_at`).
 */
const upsertRoom = async (db: ScreensDb, input: UpsertInput): Promise<void> => {
  const turno = input.ticket === null ? null : parseTicket(input.ticket);
  const filas = await db
    .select()
    .from(roomState)
    .where(eq(roomState.appointmentId, input.appointmentId))
    .limit(1);
  const actual = filas[0] ?? null;

  const datos = {
    patientId: input.patientId,
    patientName: input.patientName,
    patientDisplayName: abbreviateName(input.patientName),
    ticket: input.ticket,
    turnNumber: turno === null ? null : ticketSequence(turno),
    reason: input.reason,
    chairLabel: input.chairLabel,
  };

  if (actual === null) {
    await db.insert(roomState).values({
      appointmentId: input.appointmentId,
      ...datos,
      ...(input.birthDate === null || input.birthDate === undefined
        ? {}
        : { patientBirthDate: input.birthDate }),
      ...(input.sex === null || input.sex === undefined ? {} : { patientSex: input.sex }),
      estado: input.estado,
      since: input.cuando,
      leftAt: input.salida === true ? input.cuando : null,
      updatedAt: input.cuando,
    });
    return;
  }

  // Ya había salido de la sala después de este evento: no se toca nada.
  if (actual.leftAt !== null && actual.leftAt.getTime() >= input.cuando.getTime()) return;

  const retrocede =
    input.salida !== true &&
    actual.leftAt === null &&
    RANGO_ESTADO[actual.estado as keyof typeof RANGO_ESTADO] > RANGO_ESTADO[input.estado];

  await db
    .update(roomState)
    .set({
      ...datos,
      // Los datos que pueden venir vacíos en un evento posterior se conservan.
      ...(input.patientId === null ? { patientId: actual.patientId } : {}),
      ...(input.ticket === null ? { ticket: actual.ticket, turnNumber: actual.turnNumber } : {}),
      ...(input.reason === null ? { reason: actual.reason } : {}),
      ...(input.birthDate === null || input.birthDate === undefined
        ? { patientBirthDate: actual.patientBirthDate }
        : {}),
      ...(input.sex === null || input.sex === undefined ? { patientSex: actual.patientSex } : {}),
      ...(retrocede
        ? { estado: actual.estado, since: actual.since }
        : {
            estado: input.estado,
            since: input.cuando,
            leftAt: input.salida === true ? input.cuando : null,
          }),
      updatedAt:
        input.cuando.getTime() > actual.updatedAt.getTime() ? input.cuando : actual.updatedAt,
    })
    .where(eq(roomState.appointmentId, input.appointmentId));
};

export interface ApplyResult {
  estado: 'aplicado' | 'duplicado' | 'ignorado';
}

/** Estado en el que está la cita dentro de la sala, si sigue dentro. */
const estadoActual = async (
  db: ScreensDb,
  appointmentId: string,
): Promise<'en_sala_espera' | 'llamado' | 'en_consulta' | null> => {
  const filas = await db
    .select({ estado: roomState.estado })
    .from(roomState)
    .where(eq(roomState.appointmentId, appointmentId))
    .limit(1);
  const fila = filas[0];
  return fila === undefined ? null : (fila.estado as 'en_sala_espera' | 'llamado' | 'en_consulta');
};

/**
 * Aplica un evento de agenda a la proyección de la sala.
 *
 * Es **idempotente**: los llamados se deduplicán por `eventId` y los cambios de
 * estado son un `upsert` por cita, así que un evento repetido no llama dos veces
 * al mismo paciente ni duplica filas.
 */
export const applyEvent = async (deps: EstadoDeps, event: DomainEvent): Promise<ApplyResult> => {
  const { db, config } = deps;
  const { appointment, notification } = readPayload(event);
  if (appointment === null || notification?.patientName == null) return { estado: 'ignorado' };

  // Se usa la hora del **evento**: la cola puede entregar dos acciones del mismo
  // lote en cualquier orden y la proyección tiene que respetar el orden real.
  const cuando = new Date(event.occurredAt);
  const base = {
    appointmentId: appointment.id,
    patientId: notification.patientId,
    patientName: notification.patientName,
    ticket: notification.ticket,
    reason: notification.reason,
    chairLabel: config.CHAIR_LABEL,
    cuando,
  };

  switch (event.eventType) {
    case EVENT_TOPICS.appointmentCheckedIn: {
      const ficha =
        notification.patientId === null || deps.patientLookup === undefined
          ? null
          : await deps.patientLookup(notification.patientId).catch(() => null);

      await upsertRoom(db, {
        ...base,
        estado: 'en_sala_espera',
        birthDate: ficha?.birthDate ?? null,
        sex: ficha?.sex ?? null,
      });
      return { estado: 'aplicado' };
    }

    case EVENT_TOPICS.appointmentCalled: {
      const previos = await db
        .select({ valor: count() })
        .from(callEvents)
        .where(eq(callEvents.appointmentId, appointment.id));
      const callNumber = (previos[0]?.valor ?? 0) + 1;

      const inserted = await db
        .insert(callEvents)
        .values({
          appointmentId: appointment.id,
          patientDisplayName: abbreviateName(notification.patientName),
          turnNumber:
            notification.ticket === null
              ? null
              : (() => {
                  const turno = parseTicket(notification.ticket);
                  return turno === null ? null : ticketSequence(turno);
                })(),
          ticket: notification.ticket,
          callNumber,
          chairLabel: config.CHAIR_LABEL,
          calledAt: cuando,
          calledBy: event.actorId ?? null,
          eventId: event.eventId,
        })
        .onConflictDoNothing({ target: callEvents.eventId })
        .returning({ id: callEvents.id });

      // El llamado ya estaba aplicado: no se toca nada más.
      if (inserted.length === 0) return { estado: 'duplicado' };

      await upsertRoom(db, { ...base, estado: 'llamado' });
      return { estado: 'aplicado' };
    }

    case EVENT_TOPICS.appointmentInConsultation: {
      await upsertRoom(db, { ...base, estado: 'en_consulta' });
      return { estado: 'aplicado' };
    }

    case EVENT_TOPICS.appointmentAttended:
    case EVENT_TOPICS.appointmentNoShow:
    case EVENT_TOPICS.appointmentCancelled:
    case EVENT_TOPICS.appointmentRescheduled: {
      // El paciente sale de la sala. La fila queda como lápida (`left_at`) para
      // que un evento que llegue tarde no lo devuelva a la pantalla.
      await upsertRoom(db, {
        ...base,
        estado: (await estadoActual(db, appointment.id)) ?? 'en_sala_espera',
        salida: true,
      });
      return { estado: 'aplicado' };
    }

    default:
      return { estado: 'ignorado' };
  }
};

/** Datos críticos de la cita en curso (los envía la historia clínica, Fase 6). */
export const setCriticalFlags = async (
  db: ScreensDb,
  appointmentId: string,
  flags: CriticalFlag[],
): Promise<number> => {
  const rows = await db
    .update(roomState)
    .set({ criticalFlags: flags as unknown as Record<string, unknown>[], updatedAt: new Date() })
    .where(eq(roomState.appointmentId, appointmentId))
    .returning({ id: roomState.appointmentId });
  return rows.length;
};

/* ── Estado que pintan las pantallas ───────────────────────────────────────── */

const toCallEvent = (row: CallEventRow): CallEvent => ({
  id: row.id,
  appointmentId: row.appointmentId,
  patientDisplayName: row.patientDisplayName,
  turnNumber: row.turnNumber,
  ticket: row.ticket,
  callNumber: row.callNumber,
  chairLabel: row.chairLabel,
  calledAt: row.calledAt.toISOString(),
  calledBy: row.calledBy,
});

const flagsOf = (row: RoomStateRow): CriticalFlag[] =>
  Array.isArray(row.criticalFlags) ? (row.criticalFlags as unknown as CriticalFlag[]) : [];

export const waitingCount = async (db: ScreensDb): Promise<number> => {
  const rows = await db
    .select({ valor: count() })
    .from(roomState)
    .where(and(eq(roomState.estado, 'en_sala_espera'), isNull(roomState.leftAt)));
  return rows[0]?.valor ?? 0;
};

/**
 * Estado del displaylobby: los llamados **vigentes** (el paciente sigue llamado y
 * el llamado no ha caducado) y cuánta gente espera sentada.
 */
export const lobbyState = async (db: ScreensDb, config: ScreensConfig): Promise<LobbyState> => {
  const desde = new Date(Date.now() - config.SCREEN_CALL_TTL_SECONDS * 1000);
  const llamados = await db
    .select()
    .from(roomState)
    .where(
      and(
        eq(roomState.estado, 'llamado'),
        isNull(roomState.leftAt),
        gte(roomState.updatedAt, desde),
      ),
    )
    .orderBy(desc(roomState.updatedAt))
    .limit(config.SCREEN_CALLS_SHOWN);

  const ids = llamados.map((fila) => fila.appointmentId);
  const eventos =
    ids.length === 0
      ? []
      : await db
          .select()
          .from(callEvents)
          .where(inArray(callEvents.appointmentId, ids))
          .orderBy(desc(callEvents.calledAt))
          .limit(config.SCREEN_CALLS_SHOWN * 4);

  const ultimoPorCita = new Map<string, CallEventRow>();
  for (const evento of eventos) {
    if (!ultimoPorCita.has(evento.appointmentId)) ultimoPorCita.set(evento.appointmentId, evento);
  }

  const calls = llamados.flatMap((fila) => {
    const evento = ultimoPorCita.get(fila.appointmentId);
    if (evento === undefined) return [];
    // El llamado se pinta con el último evento (el 2.º llamado sale en rojo).
    return [
      {
        ...toCallEvent(evento),
        patientDisplayName: fila.patientDisplayName,
        chairLabel: fila.chairLabel,
      },
    ];
  });

  return {
    calls,
    waitingCount: await waitingCount(db),
    updatedAt: new Date().toISOString(),
  };
};

/** Estado de la pantalla del consultorio: quién está dentro (o entrando). */
export const consultationState = async (db: ScreensDb): Promise<ConsultationState> => {
  const filas = await db
    .select()
    .from(roomState)
    .where(and(inArray(roomState.estado, ['en_consulta', 'llamado']), isNull(roomState.leftAt)))
    .orderBy(asc(roomState.since));

  // Se prefiere al que está en el consultorio; si no hay, al último llamado.
  const actual =
    [...filas].reverse().find((fila) => fila.estado === 'en_consulta') ??
    [...filas].reverse().find((fila) => fila.estado === 'llamado') ??
    null;

  const waiting = await waitingCount(db);

  if (actual === null) {
    return {
      appointmentId: null,
      patientId: null,
      patientName: null,
      patientDisplayName: null,
      age: null,
      sex: null,
      ticket: null,
      reason: null,
      since: null,
      criticalFlags: [],
      waitingCount: waiting,
      updatedAt: new Date().toISOString(),
    };
  }

  return {
    appointmentId: actual.appointmentId,
    patientId: actual.patientId,
    patientName: actual.patientName,
    patientDisplayName: actual.patientDisplayName,
    age: ageAt(actual.patientBirthDate),
    sex: actual.patientSex,
    ticket: actual.ticket,
    reason: actual.reason,
    since: actual.estado === 'en_consulta' ? actual.since.toISOString() : null,
    criticalFlags: flagsOf(actual),
    waitingCount: waiting,
    updatedAt: new Date().toISOString(),
  };
};
