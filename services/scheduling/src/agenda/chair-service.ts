import { type Chair, type ChairInput, type ChairUpdateInput } from '@odontocrm/contracts';
import { ConflictError, NotFoundError } from '@odontocrm/kernel';
import { asc, eq, sql } from 'drizzle-orm';

import type { SchedulingDb } from '../db/client.js';
import { chairs, type ChairRow } from '../db/schema.js';

export const toChair = (row: ChairRow): Chair => ({
  id: row.id,
  label: row.label,
  shortLabel: row.shortLabel,
  isActive: row.isActive,
  sortOrder: row.sortOrder,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

/** Catálogo de consultorios, activos primero y en el orden que fija la administración. */
export const listChairs = async (
  db: SchedulingDb,
  options: { includeInactive?: boolean } = {},
): Promise<Chair[]> => {
  const rows =
    options.includeInactive === true
      ? await db.select().from(chairs).orderBy(asc(chairs.sortOrder), asc(chairs.label))
      : await db
          .select()
          .from(chairs)
          .where(eq(chairs.isActive, true))
          .orderBy(asc(chairs.sortOrder), asc(chairs.label));
  return rows.map(toChair);
};

export const chairById = async (db: SchedulingDb, id: string): Promise<ChairRow> => {
  const rows = await db.select().from(chairs).where(eq(chairs.id, id)).limit(1);
  const row = rows[0];
  if (row === undefined) throw new NotFoundError('El consultorio no existe');
  return row;
};

/** Comprueba que el consultorio exista y esté activo (no se asigna a uno desactivado). */
export const activeChairOrThrow = async (db: SchedulingDb, id: string): Promise<ChairRow> => {
  const row = await chairById(db, id);
  if (!row.isActive) {
    throw new ConflictError(`El consultorio «${row.label}» está desactivado y no admite citas.`);
  }
  return row;
};

const isUniqueViolation = (error: unknown): boolean => {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null; depth += 1) {
    if (typeof current === 'object' && 'code' in current && current.code === '23505') return true;
    current = typeof current === 'object' && 'cause' in current ? current.cause : null;
  }
  return false;
};

export const createChair = async (db: SchedulingDb, input: ChairInput): Promise<Chair> => {
  try {
    const rows = await db
      .insert(chairs)
      .values({
        label: input.label,
        shortLabel: input.shortLabel,
        isActive: input.isActive,
        sortOrder: input.sortOrder,
      })
      .returning();
    const row = rows[0];
    if (row === undefined) throw new NotFoundError('No se pudo crear el consultorio');
    return toChair(row);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError(`Ya existe un consultorio llamado «${input.label}».`);
    }
    throw error;
  }
};

export const updateChair = async (
  db: SchedulingDb,
  id: string,
  input: ChairUpdateInput,
): Promise<Chair> => {
  // Verifica que exista (lanza 404 si no) antes de intentar el update.
  await chairById(db, id);

  try {
    const rows = await db
      .update(chairs)
      .set({
        ...(input.label === undefined ? {} : { label: input.label }),
        ...(input.shortLabel === undefined ? {} : { shortLabel: input.shortLabel }),
        ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
        ...(input.sortOrder === undefined ? {} : { sortOrder: input.sortOrder }),
        updatedAt: new Date(),
      })
      .where(eq(chairs.id, id))
      .returning();
    const row = rows[0];
    if (row === undefined) throw new NotFoundError('El consultorio no existe');
    return toChair(row);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError(`Ya existe un consultorio llamado «${input.label ?? ''}».`);
    }
    throw error;
  }
};

/**
 * Mapa `id → etiqueta` del catálogo completo (activos e inactivos): sirve para
 * rotular citas históricas de un consultorio ya desactivado sin una consulta por
 * cita. Si no hay ninguno, se devuelve un mapa vacío (y las etiquetas salen `null`).
 */
export const chairLabels = async (db: SchedulingDb): Promise<Map<string, string>> => {
  const rows = await db.select({ id: chairs.id, label: chairs.label }).from(chairs);
  return new Map(rows.map((row) => [row.id, row.label]));
};

/** Etiqueta de un consultorio por id (o `null` si no existe): rotula un evento. */
export const chairLabelById = async (db: SchedulingDb, id: string): Promise<string | null> => {
  const rows = await db
    .select({ label: chairs.label })
    .from(chairs)
    .where(eq(chairs.id, id))
    .limit(1);
  return rows[0]?.label ?? null;
};

/** Identificador estable de un consultorio a partir de su etiqueta (para la migración/seed). */
export const chairCount = async (db: SchedulingDb): Promise<number> => {
  const rows = await db.select({ value: sql<number>`count(1)::int` }).from(chairs);
  return rows[0]?.value ?? 0;
};
