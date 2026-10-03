import { ROOM_STATES, SCREEN_KINDS } from '@odontocrm/contracts';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/** Lista de valores para un CHECK como literales (ver nota en identity/schema.ts). */
const sqlLiteralList = (values: readonly string[]) => {
  const escaped = values.map((value) => `'${value.replace(/'/g, "''")}'`);
  return sql.join(
    // eslint-disable-next-line no-restricted-syntax -- constantes del contrato, nunca entrada de usuario
    escaped.map((value) => sql.raw(value)),
    sql`, `,
  );
};

/**
 * Pantallas registradas (kiosko de sala y de consultorio). El **token** vive en
 * identity (`device_tokens`, hasheado); aquí se guarda su id y los ajustes de la
 * pantalla (voz, volumen, tiempo de resalte).
 */
export const screenDevices = pgTable(
  'screen_devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** `device_tokens.id` de identity: no hay FK entre bases, se valida al usar. */
    tokenId: uuid('token_id'),
    label: text('label').notNull(),
    kind: text('kind').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
    /** Última vez que la pantalla pidió estado o abrió su flujo en vivo. */
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_screen_devices_token').on(table.tokenId),
    check('chk_screen_devices_kind', sql`${table.kind} in (${sqlLiteralList(SCREEN_KINDS)})`),
  ],
);

/**
 * Proyección del **estado de la sala**: qué pacientes están sentados esperando, a
 * quién se llamó y quién está en el consultorio. Se alimenta solo de eventos de
 * agenda, así que no lee la base de nadie más.
 */
export const roomState = pgTable(
  'room_state',
  {
    appointmentId: uuid('appointment_id').primaryKey(),
    patientId: uuid('patient_id'),
    patientName: text('patient_name').notNull(),
    /** Nombre abreviado para pantalla: «Juan P.». */
    patientDisplayName: text('patient_display_name').notNull(),
    ticket: text('ticket'),
    turnNumber: bigint('turn_number', { mode: 'number' }),
    /** Motivo de la consulta, tal como lo escribió el paciente. */
    reason: text('reason'),
    /** Fecha de nacimiento y sexo: la edad se calcula al pintar la pantalla. */
    patientBirthDate: text('patient_birth_date'),
    patientSex: text('patient_sex'),
    estado: text('estado').notNull(),
    chairLabel: text('chair_label').notNull(),
    /** Alertas clínicas que resalta la pantalla (las envía la historia clínica). */
    criticalFlags: jsonb('critical_flags').$type<Record<string, unknown>[]>().notNull().default([]),
    /** Cuándo entró a la sala / pasó al consultorio. */
    since: timestamp('since', { withTimezone: true }).notNull().defaultNow(),
    /**
     * Cuándo dejó la sala (atendido, inasistencia, cancelada o reprogramada).
     * La fila se conserva como lápida: así un evento que llegue tarde no puede
     * «resucitar» a un paciente que ya salió.
     */
    leftAt: timestamp('left_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_room_state_estado').on(table.estado, table.since),
    index('idx_room_state_dentro').on(table.leftAt),
    check('chk_room_state_estado', sql`${table.estado} in (${sqlLiteralList(ROOM_STATES)})`),
  ],
);

/**
 * Histórico de llamados del displaylobby. `event_id` es el evento de dominio que
 * lo originó: un evento repetido no vuelve a llamar al paciente.
 */
export const callEvents = pgTable(
  'call_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    appointmentId: uuid('appointment_id').notNull(),
    patientDisplayName: text('patient_display_name').notNull(),
    turnNumber: bigint('turn_number', { mode: 'number' }),
    ticket: text('ticket'),
    callNumber: integer('call_number').notNull().default(1),
    chairLabel: text('chair_label').notNull(),
    calledAt: timestamp('called_at', { withTimezone: true }).notNull().defaultNow(),
    calledBy: uuid('called_by'),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
    eventId: text('event_id').notNull(),
  },
  (table) => [
    uniqueIndex('uq_call_events_event').on(table.eventId),
    index('idx_call_events_called_at').on(table.calledAt),
  ],
);

export type ScreenDeviceRow = typeof screenDevices.$inferSelect;
export type RoomStateRow = typeof roomState.$inferSelect;
export type CallEventRow = typeof callEvents.$inferSelect;
