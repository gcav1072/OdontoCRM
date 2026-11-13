import type { NotificationSettings, NotificationSettingsInput } from '@odontocrm/contracts';
import { eq } from 'drizzle-orm';

import type { NotificationsDb } from './db/client.js';
import { notificationSettings } from './db/schema.js';

/**
 * Configuración editable de la clínica para el bot, en una **sola fila** (`id = 1`):
 *
 *  - la **política de cancelación** del paciente (ADR 0057): el corte de días que se
 *    aplica a una cita ya confirmada;
 *  - la **política de recordatorios** (v1.2): días de antelación, hora de envío,
 *    si se recuerdan también las citas confirmadas;
 *  - el **envío automático de documentos** (Req 5, v1.2).
 *
 * La fila la siembra la migración; aun así se asegura en lectura con un
 * `insert ... on conflict do nothing`, porque una base restaurada de un respaldo
 * anterior a la migración no la tendría y la bandeja no debe caerse por eso.
 */

const FILA = 1;

type SettingsRow = {
  patientCancelCutoffDays: number;
  reminderDaysBefore: number;
  reminderSendHour: number;
  reminderIncludeConfirmed: boolean;
  autoSendDocuments: boolean;
  updatedAt: Date;
  updatedByUserId: string | null;
};

const toSettings = (row: SettingsRow): NotificationSettings => ({
  patientCancelCutoffDays: row.patientCancelCutoffDays,
  reminderDaysBefore: row.reminderDaysBefore,
  reminderSendHour: row.reminderSendHour,
  reminderIncludeConfirmed: row.reminderIncludeConfirmed,
  autoSendDocuments: row.autoSendDocuments,
  updatedAt: row.updatedAt.toISOString(),
  updatedByUserId: row.updatedByUserId,
});

/** Valores por defecto: los de la migración, para no devolver `undefined` nunca. */
const DEFAULTS: Omit<NotificationSettings, 'updatedAt' | 'updatedByUserId'> = {
  patientCancelCutoffDays: 0,
  reminderDaysBefore: 0,
  reminderSendHour: 9,
  reminderIncludeConfirmed: false,
  autoSendDocuments: false,
};

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
    ? { ...DEFAULTS, updatedAt: null, updatedByUserId: null }
    : toSettings(nueva);
};

/**
 * Guarda la configuración **parcialmente**: cada tarjeta del panel manda solo lo suyo
 * (la de cancelación su corte; la de recordatorios sus cuatro ajustes). Los campos que
 * no vienen se conservan tal cual. Devuelve la fila resultante y **quién** la cambió
 * (queda en la auditoría por el `updatedByUserId`) para que la interfaz confirme el
 * valor real.
 */
export const updateNotificationSettings = async (
  db: NotificationsDb,
  input: NotificationSettingsInput,
  actorId: string | null,
): Promise<NotificationSettings> => {
  const actual = await getNotificationSettings(db);

  const siguiente: SettingsRow = {
    patientCancelCutoffDays: input.patientCancelCutoffDays ?? actual.patientCancelCutoffDays,
    reminderDaysBefore: input.reminderDaysBefore ?? actual.reminderDaysBefore,
    reminderSendHour: input.reminderSendHour ?? actual.reminderSendHour,
    reminderIncludeConfirmed: input.reminderIncludeConfirmed ?? actual.reminderIncludeConfirmed,
    autoSendDocuments: input.autoSendDocuments ?? actual.autoSendDocuments,
    updatedAt: new Date(),
    updatedByUserId: actorId,
  };

  const updated = await db
    .update(notificationSettings)
    .set({
      patientCancelCutoffDays: siguiente.patientCancelCutoffDays,
      reminderDaysBefore: siguiente.reminderDaysBefore,
      reminderSendHour: siguiente.reminderSendHour,
      reminderIncludeConfirmed: siguiente.reminderIncludeConfirmed,
      autoSendDocuments: siguiente.autoSendDocuments,
      updatedAt: siguiente.updatedAt,
      updatedByUserId: actorId,
    })
    .where(eq(notificationSettings.id, FILA))
    .returning();

  const row = updated[0];
  return row === undefined
    ? {
        patientCancelCutoffDays: siguiente.patientCancelCutoffDays,
        reminderDaysBefore: siguiente.reminderDaysBefore,
        reminderSendHour: siguiente.reminderSendHour,
        reminderIncludeConfirmed: siguiente.reminderIncludeConfirmed,
        autoSendDocuments: siguiente.autoSendDocuments,
        updatedAt: null,
        updatedByUserId: actorId,
      }
    : toSettings(row);
};
