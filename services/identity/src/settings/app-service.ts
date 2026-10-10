import {
  DEFAULT_UI_ACCENT,
  type AppSettingsInput,
  type ScreenTexts,
  type UIAccentId,
} from '@odontocrm/contracts';
import { eq } from 'drizzle-orm';

import type { IdentityDb } from '../db/client.js';
import { appSettings } from '../db/schema.js';

/**
 * Configuración de la **aplicación** guardada en la base (ADR 0060): el acento de la
 * interfaz y los textos del kiosko. Una sola fila (`id = 1`).
 *
 * El acento `null` es «el de fábrica» (`DEFAULT_UI_ACCENT`): así el panel distingue
 * «nunca se tocó» de «se eligió el que ya venía». Los textos son un mapa parcial:
 * lo que falte sale del diccionario (`i18n.ts`).
 */

const FILA = 1;

export interface AppSettingsState {
  accent: UIAccentId | null;
  screenTexts: ScreenTexts;
  fromDatabase: boolean;
  updatedAt: Date | null;
}

const readRow = async (db: IdentityDb) => {
  const rows = await db.select().from(appSettings).where(eq(appSettings.id, FILA)).limit(1);
  return rows[0] ?? null;
};

/** El acento que se está aplicando: el guardado o el de fábrica. */
export const effectiveAccent = (accent: UIAccentId | null): UIAccentId =>
  accent ?? DEFAULT_UI_ACCENT;

/** Lee el acento y los textos del kiosko; sin fila, son los de fábrica. */
export const readAppSettings = async (db: IdentityDb): Promise<AppSettingsState> => {
  const row = await readRow(db);
  if (row === null) {
    return { accent: null, screenTexts: {}, fromDatabase: false, updatedAt: null };
  }
  return {
    accent: (row.accent as UIAccentId | null) ?? null,
    screenTexts: row.screenTexts,
    fromDatabase: true,
    updatedAt: row.updatedAt,
  };
};

/** Guarda el acento y los textos (alta o reemplazo de la fila única). */
export const updateAppSettings = async (
  db: IdentityDb,
  input: AppSettingsInput,
  actorId: string | null,
): Promise<void> => {
  const valores = {
    accent: input.accent,
    screenTexts: input.screenTexts,
    updatedAt: new Date(),
    updatedBy: actorId,
  };
  const existing = await readRow(db);
  if (existing === null) {
    await db.insert(appSettings).values({ id: FILA, ...valores });
    return;
  }
  await db.update(appSettings).set(valores).where(eq(appSettings.id, FILA));
};
