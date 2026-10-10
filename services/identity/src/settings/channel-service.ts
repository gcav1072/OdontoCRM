import {
  DEFAULT_WHATSAPP_API_BASE,
  type ChannelCredentials,
  type ChannelSecretView,
  type ChannelSettingsInput,
  type ChannelSettingsView,
} from '@odontocrm/contracts';
import { decryptBlob, encryptBlob, parseEncryptionKey } from '@odontocrm/storage';
import { eq } from 'drizzle-orm';

import type { IdentityDb } from '../db/client.js';
import { channelSettings } from '../db/schema.js';

/**
 * Credenciales y datos de los **canales de mensajería** guardados en la base (ADR 0060).
 *
 * Sustituye —sin borrarlo— al `.env` que los guardaba: los **secretos** van cifrados con
 * la clave del almacén (AES-256-GCM) y las credenciales en claro solo salen por la ruta
 * **interna** que consume notificaciones. La vista pública nunca devuelve un secreto:
 * dice si está configurado y enseña sus últimos caracteres para reconocerlo.
 *
 * El `.env` sigue leyéndose como **respaldo**: una instalación que ya tenía los tokens en
 * el archivo sigue funcionando aunque nadie rellene el panel.
 */

const FILA = 1;

/** Marca de un secreto guardado cifrado (base64 del blob del almacén). */
const PREFIX_ENC = 'enc:';
/** Marca de un secreto guardado **en claro**: solo cuando no hay clave de almacén (desarrollo). */
const PREFIX_PLAIN = 'plain:';

const readRow = async (db: IdentityDb) => {
  const rows = await db.select().from(channelSettings).where(eq(channelSettings.id, FILA)).limit(1);
  return rows[0] ?? null;
};

/** Cifra un valor para guardarlo (o lo deja en claro si no hay clave, avisando en la vista). */
const seal = (value: string, key: Buffer | undefined): string => {
  if (key === undefined) return `${PREFIX_PLAIN}${value}`;
  return `${PREFIX_ENC}${encryptBlob(Buffer.from(value, 'utf8'), key).toString('base64')}`;
};

/** Descifra lo guardado. Un valor sin marca se devuelve tal cual (compatibilidad). */
const open = (stored: string | null, key: Buffer | undefined): string | null => {
  if (stored === null || stored === '') return null;
  if (stored.startsWith(PREFIX_PLAIN)) return stored.slice(PREFIX_PLAIN.length);
  if (stored.startsWith(PREFIX_ENC)) {
    if (key === undefined) {
      throw new Error(
        'Las credenciales de los canales están cifradas y no hay STORAGE_ENCRYPTION_KEY: ' +
          'pon la clave del almacén para leerlas',
      );
    }
    return decryptBlob(Buffer.from(stored.slice(PREFIX_ENC.length), 'base64'), key).toString(
      'utf8',
    );
  }
  return stored;
};

/** Últimos cuatro caracteres, para reconocer un secreto sin revelarlo. */
const mask = (value: string | null): ChannelSecretView => ({
  configured: value !== null && value !== '',
  preview: value === null || value.length === 0 ? null : `…${value.slice(-4)}`,
});

const keyOf = (config: { STORAGE_ENCRYPTION_KEY?: string | undefined }): Buffer | undefined =>
  parseEncryptionKey(config.STORAGE_ENCRYPTION_KEY);

/**
 * Las credenciales **en claro** que consume notificaciones por la ruta interna. Lo que
 * esté en la base manda; lo que falte se deja en `null` y el servicio de notificaciones
 * cae a su `.env` (compatibilidad).
 */
export const readChannelCredentials = async (
  db: IdentityDb,
  config: { STORAGE_ENCRYPTION_KEY?: string | undefined },
): Promise<ChannelCredentials> => {
  const row = await readRow(db);
  if (row === null) {
    return {
      telegramBotToken: null,
      telegramBotUsername: null,
      adminTelegramBotToken: null,
      adminTelegramChatId: null,
      whatsappToken: null,
      whatsappPhoneId: null,
      whatsappVerifyToken: null,
      whatsappAppSecret: null,
      whatsappApiBase: DEFAULT_WHATSAPP_API_BASE,
    };
  }

  const key = keyOf(config);
  return {
    telegramBotToken: open(row.telegramBotTokenEnc, key),
    telegramBotUsername: row.telegramBotUsername,
    adminTelegramBotToken: open(row.adminTelegramBotTokenEnc, key),
    adminTelegramChatId: row.adminTelegramChatId,
    whatsappToken: open(row.whatsappTokenEnc, key),
    whatsappPhoneId: row.whatsappPhoneId,
    whatsappVerifyToken: open(row.whatsappVerifyTokenEnc, key),
    whatsappAppSecret: open(row.whatsappAppSecretEnc, key),
    whatsappApiBase: row.whatsappApiBase ?? DEFAULT_WHATSAPP_API_BASE,
  };
};

/** La vista **pública**: datos no secretos en claro y secretos enmascarados. */
export const readChannelView = async (
  db: IdentityDb,
  config: { STORAGE_ENCRYPTION_KEY?: string | undefined },
): Promise<ChannelSettingsView> => {
  const row = await readRow(db);
  const key = keyOf(config);

  if (row === null) {
    return {
      telegramBotUsername: null,
      adminTelegramChatId: null,
      whatsappPhoneId: null,
      whatsappApiBase: DEFAULT_WHATSAPP_API_BASE,
      telegramBotToken: mask(null),
      adminTelegramBotToken: mask(null),
      whatsappToken: mask(null),
      whatsappVerifyToken: mask(null),
      whatsappAppSecret: mask(null),
      encrypted: key !== undefined,
      updatedAt: null,
      updatedByUserId: null,
    };
  }

  return {
    telegramBotUsername: row.telegramBotUsername,
    adminTelegramChatId: row.adminTelegramChatId,
    whatsappPhoneId: row.whatsappPhoneId,
    whatsappApiBase: row.whatsappApiBase ?? DEFAULT_WHATSAPP_API_BASE,
    telegramBotToken: mask(open(row.telegramBotTokenEnc, key)),
    adminTelegramBotToken: mask(open(row.adminTelegramBotTokenEnc, key)),
    whatsappToken: mask(open(row.whatsappTokenEnc, key)),
    whatsappVerifyToken: mask(open(row.whatsappVerifyTokenEnc, key)),
    whatsappAppSecret: mask(open(row.whatsappAppSecretEnc, key)),
    encrypted: key !== undefined,
    updatedAt: row.updatedAt.toISOString(),
    updatedByUserId: row.updatedBy,
  };
};

/** Aplica un secreto entrante sobre lo guardado (o conserva / borra según la semántica). */
const patchSecret = (
  existing: string | null,
  incoming: string | undefined,
  key: Buffer | undefined,
): string | null => {
  if (incoming === undefined) return existing;
  if (incoming === '') return null;
  return seal(incoming, key);
};

/**
 * Guarda las credenciales. Semántica de entrada: `undefined` = conservar, `''` = borrar,
 * un valor = fijar. Así el panel puede cambiar solo el teléfono de WhatsApp sin
 * reescribir el token.
 */
export const updateChannelSettings = async (
  db: IdentityDb,
  input: ChannelSettingsInput,
  actorId: string | null,
  config: { STORAGE_ENCRYPTION_KEY?: string | undefined },
): Promise<void> => {
  const row = await readRow(db);
  const key = keyOf(config);
  const existing = row;

  const valores = {
    telegramBotUsername:
      input.telegramBotUsername === undefined
        ? (existing?.telegramBotUsername ?? null)
        : input.telegramBotUsername === ''
          ? null
          : input.telegramBotUsername,
    adminTelegramChatId:
      input.adminTelegramChatId === undefined
        ? (existing?.adminTelegramChatId ?? null)
        : input.adminTelegramChatId === ''
          ? null
          : input.adminTelegramChatId,
    whatsappPhoneId:
      input.whatsappPhoneId === undefined
        ? (existing?.whatsappPhoneId ?? null)
        : input.whatsappPhoneId === ''
          ? null
          : input.whatsappPhoneId,
    whatsappApiBase:
      input.whatsappApiBase === undefined
        ? (existing?.whatsappApiBase ?? null)
        : input.whatsappApiBase === ''
          ? null
          : input.whatsappApiBase,
    telegramBotTokenEnc: patchSecret(
      existing?.telegramBotTokenEnc ?? null,
      input.telegramBotToken,
      key,
    ),
    adminTelegramBotTokenEnc: patchSecret(
      existing?.adminTelegramBotTokenEnc ?? null,
      input.adminTelegramBotToken,
      key,
    ),
    whatsappTokenEnc: patchSecret(existing?.whatsappTokenEnc ?? null, input.whatsappToken, key),
    whatsappVerifyTokenEnc: patchSecret(
      existing?.whatsappVerifyTokenEnc ?? null,
      input.whatsappVerifyToken,
      key,
    ),
    whatsappAppSecretEnc: patchSecret(
      existing?.whatsappAppSecretEnc ?? null,
      input.whatsappAppSecret,
      key,
    ),
    updatedAt: new Date(),
    updatedBy: actorId,
  };

  if (existing === null) {
    await db.insert(channelSettings).values({ id: FILA, ...valores });
    return;
  }
  await db.update(channelSettings).set(valores).where(eq(channelSettings.id, FILA));
};
