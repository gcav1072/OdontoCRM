import {
  SCREEN_SETTINGS_DEFAULT,
  abbreviateName,
  ageAt,
  parseTicket,
  screenSettingsSchema,
  ticketSequence,
  type CallEvent,
  type ConsultationChair,
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
import type { ChairCatalog, ChairLite, ClinicalAlertLookup } from '../internal-client.js';
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
      /**
       * Reemitir el enlace: la pantalla pasa a reconocer **otro** token de
       * dispositivo (el que acaba de emitir identity). El anterior deja de
       * resolver aquí, así que el enlace viejo muere en el acto; la sesión que ya
       * tuviera abierta caduca sola con su JWT de 15 minutos.
       */
      ...(input.tokenId === undefined ? {} : { tokenId: input.tokenId }),
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
  /** Consultorio de la cita: es lo que pinta la sala para saber dónde entrar. */
  chairLabel: string | null;
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
    // El consultorio viene **en el evento** (ADR 0041); `CHAIR_LABEL` queda como
    // respaldo de una cita capturada antes de la migración multisillón.
    chairLabel: appointment.chairLabel ?? config.CHAIR_LABEL,
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

/**
 * Estado de la pantalla del consultorio, **por consultorio**: la TV es una sola y
 * compartida, así que reparte un tile por sillón (con su paciente dentro, su llamado o
 * «libre»).
 *
 * El catálogo de sillones lo sirve la agenda (`chairCatalog`); si no se puede leer, el
 * estado se arma solo con los sillones que aparezcan en la sala, de modo que la TV
 * siga mostrando lo que pasa aunque la agenda no responda.
 */
export const consultationState = async (
  db: ScreensDb,
  options: {
    alertLookup?: ClinicalAlertLookup | undefined;
    chairCatalog?: ChairCatalog | undefined;
  } = {},
): Promise<ConsultationState> => {
  const [filas, waiting, catalogo] = await Promise.all([
    db
      .select()
      .from(roomState)
      .where(and(inArray(roomState.estado, ['en_consulta', 'llamado']), isNull(roomState.leftAt)))
      .orderBy(asc(roomState.since)),
    waitingCount(db),
    options.chairCatalog === undefined ? Promise.resolve([]) : options.chairCatalog(),
  ]);

  // Una entrada por etiqueta de consultorio: se prefiere al que está **dentro**
  // (`en_consulta`) sobre el que solo fue llamado.
  const porLabel = new Map<string, RoomStateRow>();
  for (const fila of filas) {
    const actual = porLabel.get(fila.chairLabel);
    if (
      actual === undefined ||
      (actual.estado !== 'en_consulta' && fila.estado === 'en_consulta')
    ) {
      porLabel.set(fila.chairLabel, fila);
    }
  }

  // Orden: primero el catálogo de la agenda; después, los sillones que aparezcan en la
  // sala y no estén en el catálogo (p. ej. uno desactivado con un paciente dentro), para
  // no perder de vista a nadie.
  const etiquetas: string[] = [];
  const vistas = new Set<string>();
  for (const chair of catalogo) {
    if (!vistas.has(chair.label)) {
      vistas.add(chair.label);
      etiquetas.push(chair.label);
    }
  }
  for (const label of porLabel.keys()) {
    if (!vistas.has(label)) {
      vistas.add(label);
      etiquetas.push(label);
    }
  }

  const chairs: ConsultationChair[] = [];
  for (const label of etiquetas) {
    const chair = catalogo.find((candidate) => candidate.label === label) ?? null;
    const fila = porLabel.get(label) ?? null;
    chairs.push(await chairEntry(chair, fila, options.alertLookup));
  }

  return {
    chairs,
    waitingCount: waiting,
    updatedAt: new Date().toISOString(),
  };
};

/** Un tile de la pantalla compartida: el sillón con su paciente (o «libre»). */
const chairEntry = async (
  chair: ChairLite | null,
  fila: RoomStateRow | null,
  alertLookup: ClinicalAlertLookup | undefined,
): Promise<ConsultationChair> => {
  if (fila === null) {
    return {
      chairId: chair?.id ?? null,
      chairLabel: chair?.label ?? '—',
      appointmentId: null,
      patientId: null,
      patientName: null,
      patientDisplayName: null,
      age: null,
      sex: null,
      ticket: null,
      reason: null,
      since: null,
      estado: 'libre',
      criticalFlags: [],
    };
  }

  /**
   * Los datos críticos se leen **ahora** de la historia clínica; lo que hubieran
   * empujado antes queda como respaldo si el servicio clínico no responde. Así la
   * alergia que se escribe con el paciente sentado aparece sin esperar a nadie.
   */
  const frescos = fila.patientId === null ? null : await alertLookup?.(fila.patientId);

  return {
    chairId: chair?.id ?? null,
    chairLabel: fila.chairLabel,
    appointmentId: fila.appointmentId,
    patientId: fila.patientId,
    patientName: fila.patientName,
    patientDisplayName: fila.patientDisplayName,
    age: ageAt(fila.patientBirthDate),
    sex: fila.patientSex,
    ticket: fila.ticket,
    reason: fila.reason,
    since: fila.estado === 'en_consulta' ? fila.since.toISOString() : null,
    estado: fila.estado as 'en_consulta' | 'llamado',
    criticalFlags: frescos ?? flagsOf(fila),
  };
};
