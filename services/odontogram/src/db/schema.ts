import {
  CLINICAL_STATES,
  DENTITIONS,
  PROSTHESIS_ARCHES,
  PROSTHESIS_KINDS,
  TOOTH_CONDITIONS,
  TOOTH_SURFACES,
} from '@odontocrm/contracts';
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  pgTable,
  smallint,
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
 * Un odontograma **por paciente** (`uq_odontograms_patient`): es la boca completa
 * y su estado va cambiando. El histórico de quién cambió qué vive en
 * `tooth_finding_history`.
 */
export const odontograms = pgTable(
  'odontograms',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    patientId: uuid('patient_id').notNull(),
    /**
     * Dentición de la boca. No se elige en la interfaz: se deduce del primer
     * hallazgo registrado (el 1.º dígito del FDI), pero se guarda para poder servir
     * la arcada correcta sin leer las filas.
     */
    dentition: text('dentition').notNull().default('permanente'),
    notes: text('notes'),
    lastPrintedAt: timestamp('last_printed_at', { withTimezone: true }),
    printCount: integer('print_count').notNull().default(0),
    recordedBy: uuid('recorded_by'),
    recordedByUsername: text('recorded_by_username'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_odontograms_patient').on(table.patientId),
    index('idx_odontograms_updated').on(table.updatedAt),
    check('chk_odontograms_dentition', sql`${table.dentition} in (${sqlLiteralList(DENTITIONS)})`),
  ],
);

/**
 * Hallazgo vigente: **una fila por excepción**. La pieza sana no tiene fila, y por
 * eso «diente sano = ausencia de fila» es la lectura correcta del patrón.
 *
 * `surface` a `null` significa que la condición afecta a la pieza completa
 * (ausente, extracción indicada, corona, implante, endodoncia). Esas condiciones
 * **mandan sobre las caras**: al registrarlas, las caras se dan por superadas
 * (`resolved_at`) y dejan de leerse, pero no se borran (ADR 0031).
 */
export const toothFindings = pgTable(
  'tooth_findings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    odontogramId: uuid('odontogram_id')
      .notNull()
      .references(() => odontograms.id, { onDelete: 'cascade' }),
    patientId: uuid('patient_id').notNull(),
    toothNumber: smallint('tooth_number').notNull(),
    /** `null` = pieza completa. */
    surface: text('surface'),
    condition: text('condition').notNull(),
    /** `pendiente` (rojo) o `completado` (azul). */
    state: text('state').notNull().default('pendiente'),
    notes: text('notes'),
    recordedBy: uuid('recorded_by'),
    recordedByUsername: text('recorded_by_username'),
    /** Sesión clínica en la que se registró (Fase 7); opcional. */
    recordedInSessionId: uuid('recorded_in_session_id'),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    /** Cuándo se dio por superado por una condición de pieza completa. */
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (table) => [
    // Clave natural del hallazgo: una fila por pieza, cara y condición.
    uniqueIndex('uq_tooth_findings_slot').on(
      table.odontogramId,
      table.toothNumber,
      table.surface,
      table.condition,
    ),
    index('idx_tooth_findings_odontogram').on(table.odontogramId),
    index('idx_tooth_findings_patient').on(table.patientId),
    index('idx_tooth_findings_tooth').on(table.patientId, table.toothNumber),
    // FDI: las piezas permanentes son 11–48 y las temporales 51–85.
    check(
      'chk_tooth_findings_tooth_number',
      sql`(${table.toothNumber} between 11 and 48 or ${table.toothNumber} between 51 and 85)`,
    ),
    check(
      'chk_tooth_findings_surface',
      sql`${table.surface} is null or ${table.surface} in (${sqlLiteralList(TOOTH_SURFACES)})`,
    ),
    check(
      'chk_tooth_findings_condition',
      sql`${table.condition} in (${sqlLiteralList(TOOTH_CONDITIONS)})`,
    ),
    check('chk_tooth_findings_state', sql`${table.state} in (${sqlLiteralList(CLINICAL_STATES)})`),
    // El **estado** tiene que ser válido para la condición (spec anexo ADR 0032 §2),
    // espejo de `isStateAllowed`: la caries y la extracción indicada solo existen
    // `pendiente`, la pieza ausente solo `completado`, y los tratamientos admiten las
    // dos. Es el último guardián: aunque el servicio y el contrato fallen, la base no
    // admite la pieza imposible del informe de fallo («extracción completada + implante»).
    check(
      'chk_tooth_findings_state_allowed',
      sql`(
        (${table.condition} in ('caries', 'extraccion_indicada') and ${table.state} = 'pendiente')
        or (${table.condition} in ('ausente', 'extraida') and ${table.state} = 'completado')
        or ${table.condition} in ('restauracion', 'corona', 'implante', 'endodoncia')
      )`,
    ),
    // Una condición de cara no puede guardarse como pieza completa y al revés.
    check(
      'chk_tooth_findings_scope',
      sql`(${table.surface} is null and ${table.condition} in ('ausente', 'extraccion_indicada', 'extraida', 'corona', 'implante', 'endodoncia')) or (${table.surface} is not null and ${table.condition} in ('caries', 'restauracion'))`,
    ),
  ],
);

/**
 * Histórico **append-only** del odontograma: una fila por cada vez que se registra,
 * cambia, borra o da por superado un hallazgo. Es lo que alimenta la vista de
 * evolución por sesión y lo que deja rastro de cada cambio.
 */
export const toothFindingHistory = pgTable(
  'tooth_finding_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    odontogramId: uuid('odontogram_id')
      .notNull()
      .references(() => odontograms.id, { onDelete: 'cascade' }),
    /** Hallazgo afectado; queda `null` si la fila ya no existe. */
    findingId: uuid('finding_id'),
    patientId: uuid('patient_id').notNull(),
    toothNumber: smallint('tooth_number').notNull(),
    surface: text('surface'),
    condition: text('condition').notNull(),
    state: text('state').notNull(),
    /** `registrado` | `actualizado` | `eliminado` | `superado`. */
    event: text('event').notNull(),
    reason: text('reason'),
    notes: text('notes'),
    actorId: uuid('actor_id'),
    actorUsername: text('actor_username'),
    /** Sesión clínica (Fase 7), para agrupar la evolución por sesión. */
    sessionId: uuid('session_id'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_tooth_finding_history').on(table.odontogramId, table.occurredAt),
    index('idx_tooth_finding_history_tooth').on(table.patientId, table.toothNumber),
  ],
);

/**
 * Constancia de impresión del odontograma. La secretaría imprime el odontograma
 * (decisión 23): imprimir es leer, pero cada impresión queda registrada con quién
 * la hizo, igual que en la historia clínica.
 */
export const odontogramPrints = pgTable(
  'odontogram_prints',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    odontogramId: uuid('odontogram_id')
      .notNull()
      .references(() => odontograms.id, { onDelete: 'cascade' }),
    printedBy: uuid('printed_by'),
    printedByUsername: text('printed_by_username'),
    printedAt: timestamp('printed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('idx_odontogram_prints').on(table.odontogramId, table.printedAt)],
);

/**
 * Prótesis **removible** vigente (PPR/PRT). Es una entidad de **nivel de arcada o de
 * tramo**, no de pieza: por eso vive en su propia tabla y no dentro de
 * `tooth_findings`. `tooth_numbers` guarda el tramo (PPR) o la arcada completa (PRT)
 * como `smallint[]`.
 *
 * Reglas: la parcial cubre un tramo contiguo; la total, la arcada entera. La unicidad
 * de una PRT por arcada la garantiza un índice parcial (`kind = 'prt'` sin resolver).
 */
export const prostheses = pgTable(
  'prostheses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    odontogramId: uuid('odontogram_id')
      .notNull()
      .references(() => odontograms.id, { onDelete: 'cascade' }),
    patientId: uuid('patient_id').notNull(),
    /** `ppr` (parcial) o `prt` (total). */
    kind: text('kind').notNull(),
    /** `maxilar` o `mandibula`. */
    arch: text('arch').notNull(),
    /** Piezas que cubre, en orden FDI. */
    toothNumbers: smallint('tooth_numbers').array().notNull(),
    /** `pendiente` (rojo, indicada) o `completado` (azul, instalada). */
    state: text('state').notNull().default('pendiente'),
    notes: text('notes'),
    recordedBy: uuid('recorded_by'),
    recordedByUsername: text('recorded_by_username'),
    recordedInSessionId: uuid('recorded_in_session_id'),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    /** Cuándo se retiró/superó la prótesis. */
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (table) => [
    index('idx_prostheses_odontogram').on(table.odontogramId),
    index('idx_prostheses_patient').on(table.patientId),
    // Una sola PRT vigente por arcada: la prótesis total es única por definición.
    uniqueIndex('uq_prosthesis_prt_arch')
      .on(table.odontogramId, table.arch)
      .where(sql`${table.kind} = 'prt' and ${table.resolvedAt} is null`),
    check('chk_prostheses_kind', sql`${table.kind} in (${sqlLiteralList(PROSTHESIS_KINDS)})`),
    check('chk_prostheses_arch', sql`${table.arch} in (${sqlLiteralList(PROSTHESIS_ARCHES)})`),
    check('chk_prostheses_state', sql`${table.state} in (${sqlLiteralList(CLINICAL_STATES)})`),
  ],
);

/**
 * Histórico **append-only** de las prótesis: una fila por registro, cambio o retirada.
 * Espejo de `tooth_finding_history` para el nivel de arcada/tramo.
 */
export const prosthesisHistory = pgTable(
  'prosthesis_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    odontogramId: uuid('odontogram_id')
      .notNull()
      .references(() => odontograms.id, { onDelete: 'cascade' }),
    /** Prótesis afectada; queda `null` si la fila ya no existe. */
    prosthesisId: uuid('prosthesis_id'),
    patientId: uuid('patient_id').notNull(),
    kind: text('kind').notNull(),
    arch: text('arch').notNull(),
    toothNumbers: smallint('tooth_numbers').array().notNull(),
    state: text('state').notNull(),
    /** `registrado` | `actualizado` | `eliminado`. */
    event: text('event').notNull(),
    reason: text('reason'),
    notes: text('notes'),
    actorId: uuid('actor_id'),
    actorUsername: text('actor_username'),
    sessionId: uuid('session_id'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('idx_prosthesis_history').on(table.odontogramId, table.occurredAt)],
);

export type OdontogramRow = typeof odontograms.$inferSelect;
export type ToothFindingRow = typeof toothFindings.$inferSelect;
export type ToothFindingHistoryRow = typeof toothFindingHistory.$inferSelect;
export type ProsthesisRow = typeof prostheses.$inferSelect;
export type ProsthesisHistoryRow = typeof prosthesisHistory.$inferSelect;
export type OdontogramPrintRow = typeof odontogramPrints.$inferSelect;