import type { NotificationSettings, NotificationSettingsInput } from '@odontocrm/contracts';
import { eq } from 'drizzle-orm';

import type { NotificationsDb } from './db/client.js';
import { notificationSettings } from './db/schema.js';

/**
 * Política de cancelación del paciente (ADR 0057): la configuración editable de la
 * clínica en una **sola fila** (`id = 1`).
 *
 * La fila la siembra la migración; aun así se asegura en lectura con un
 * `insert ... on conflict do nothing`, porque una base restaurada de un respaldo
 * anterior a la migración no la tendría y la bandeja no debe caerse por eso.
 */

const FILA = 1;

const toSettings = (row: {
  patientCancelCutoffDays: number;
  updatedAt: Date;
  updatedByUserId: string | null;
}): NotificationSettings => ({
  patientCancelCutoffDays: row.patientCancelCutoffDays,
  updatedAt: row.updatedAt.toISOString(),
  updatedByUserId: row.updatedByUserId,
});

/** Lee la configuración; la crea con los valores por defecto si faltara. */
export const getNotificationSettings = async (
  db: NotificationsDb,
): Promise<NotificationSettings> => {
  const existing = await db
    .select()
    .from(notificationSettings)
    .where(eq(notificationSettings.id, FILA))
    .limit(1);
  const row = existing[0];
  if (row !== undefined) return toSettings(row);

  await db.insert(notificationSettings).values({ id: FILA }).onConflictDoNothing();
  const creada = await db
    .select()
    .from(notificationSettings)
    .where(eq(notificationSettings.id, FILA))
    .limit(1);
  const nueva = creada[0];
  // Si la fila no estuviera ni tras insertarla, la base no es la esperada: se
  // devuelve el valor por defecto sin tocar nada (nunca un `undefined`).
  return nueva === undefined
    ? { patientCancelCutoffDays: 0, updatedAt: null, updatedByUserId: null }
    : toSettings(nueva);
};

/**
 * Guarda la política. Devuelve la fila resultante y **quién** la cambió (queda en la
 * auditoría por el `updatedByUserId`) para que la interfaz confirme el valor real.
 */
export const updateNotificationSettings = async (
  db: NotificationsDb,
  input: NotificationSettingsInput,
  actorId: string | null,
): Promise<NotificationSettings> => {
  await getNotificationSettings(db);

  const updated = await db
    .update(notificationSettings)
    .set({
      patientCancelCutoffDays: input.patientCancelCutoffDays,
      updatedAt: new Date(),
      updatedByUserId: actorId,
    })
    .where(eq(notificationSettings.id, FILA))
    .returning();

  const row = updated[0];
  return row === undefined
    ? {
        patientCancelCutoffDays: input.patientCancelCutoffDays,
        updatedAt: null,
        updatedByUserId: actorId,
      }
    : toSettings(row);
};
