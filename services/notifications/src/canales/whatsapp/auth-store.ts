import {
  BufferJSON,
  initAuthCreds,
  makeCacheableSignalKeyStore,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataSet,
  type SignalDataTypeMap,
  type SignalKeyStore,
} from '@whiskeysockets/baileys';
import { and, eq, inArray } from 'drizzle-orm';

import { decryptBlob, encryptBlob, parseEncryptionKey } from '@odontocrm/storage';

import type { NotificationsDb } from '../../db/client.js';
import { whatsappAuth } from '../../db/schema.js';

/**
 * Estado de autenticación de **Baileys sobre Postgres** (ADR 0073).
 *
 * Baileys documenta `useMultiFileAuthState` para ejemplos, pero no lo recomienda
 * en producción: deja decenas de ficheros sueltos, sin cifrar y fuera del
 * respaldo. Aquí cada valor es una fila de `whatsapp_auth`, cifrada con
 * `STORAGE_ENCRYPTION_KEY` (el mismo AES-256-GCM del almacén) y transaccional.
 *
 * Las claves se guardan con `BufferJSON` para conservar `Buffer`/`Uint8Array`
 * (las claves Signal son binarias). Una instalación sin clave de almacén cae a
 * `plain:` y lo avisa: es solo para desarrollo.
 */

const PREFIX_ENC = 'enc:';
const PREFIX_PLAIN = 'plain:';
const CREDS = 'creds';

export interface WhatsAppAuthHandle {
  state: AuthenticationState;
  /** Persiste las credenciales actuales (Baileys llama tras cada `creds.update`). */
  saveCreds: () => Promise<void>;
  /** Borra toda la sesión (cerrar sesión / `loggedOut`). */
  clear: () => Promise<void>;
  /** `true` si hay credenciales guardadas (la sesión está vinculada). */
  hasCreds: () => Promise<boolean>;
}

export interface WhatsAppAuthOptions {
  /** Clave de la sesión; por defecto `principal`. */
  sessionId: string;
  /** Clave del almacén (`STORAGE_ENCRYPTION_KEY`); `undefined` = desarrollo. */
  encryptionKey?: string | undefined;
  /** Aviso cuando se guarda sin cifrar o cuando falta la clave para leer. */
  warn?: (mensaje: string) => void;
}

const serializar = (valor: unknown): string => JSON.stringify(valor, BufferJSON.replacer);

const deserializar = (texto: string): unknown => JSON.parse(texto, BufferJSON.reviver) as unknown;

const seal = (texto: string, key: Buffer | undefined): string => {
  if (key === undefined) return `${PREFIX_PLAIN}${texto}`;
  return `${PREFIX_ENC}${encryptBlob(Buffer.from(texto, 'utf8'), key).toString('base64')}`;
};

const open = (stored: string, key: Buffer | undefined): string => {
  if (stored.startsWith(PREFIX_PLAIN)) return stored.slice(PREFIX_PLAIN.length);
  if (stored.startsWith(PREFIX_ENC)) {
    if (key === undefined) {
      throw new Error(
        'La sesión de WhatsApp está cifrada y no hay STORAGE_ENCRYPTION_KEY: ' +
          'pon la clave del almacén para leerla',
      );
    }
    return decryptBlob(Buffer.from(stored.slice(PREFIX_ENC.length), 'base64'), key).toString(
      'utf8',
    );
  }
  // Compatibilidad con una fila escrita a mano en desarrollo.
  return stored;
};

export const usePostgresAuthState = async (
  db: NotificationsDb,
  options: WhatsAppAuthOptions,
): Promise<WhatsAppAuthHandle> => {
  const { sessionId } = options;
  const key = parseEncryptionKey(options.encryptionKey);
  if (key === undefined) {
    options.warn?.(
      'WhatsApp se guarda en claro en la base (falta STORAGE_ENCRYPTION_KEY): ' +
        'solo es aceptable en desarrollo',
    );
  }

  const readRow = async (categoria: string, clave: string): Promise<string | null> => {
    const rows = await db
      .select({ valor: whatsappAuth.valor })
      .from(whatsappAuth)
      .where(
        and(
          eq(whatsappAuth.sessionId, sessionId),
          eq(whatsappAuth.categoria, categoria),
          eq(whatsappAuth.clave, clave),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : open(row.valor, key);
  };

  const writeRows = async (
    entries: readonly { categoria: string; clave: string; valor: string | null }[],
  ): Promise<void> => {
    await db.transaction(async (tx) => {
      for (const entry of entries) {
        if (entry.valor === null) {
          await tx
            .delete(whatsappAuth)
            .where(
              and(
                eq(whatsappAuth.sessionId, sessionId),
                eq(whatsappAuth.categoria, entry.categoria),
                eq(whatsappAuth.clave, entry.clave),
              ),
            );
          continue;
        }
        const valor = seal(entry.valor, key);
        await tx
          .insert(whatsappAuth)
          .values({
            sessionId,
            categoria: entry.categoria,
            clave: entry.clave,
            valor,
          })
          .onConflictDoUpdate({
            target: [whatsappAuth.sessionId, whatsappAuth.categoria, whatsappAuth.clave],
            set: { valor, updatedAt: new Date() },
          });
      }
    });
  };

  const storedCreds = await readRow(CREDS, '');
  const creds: AuthenticationCreds =
    storedCreds === null ? initAuthCreds() : (deserializar(storedCreds) as AuthenticationCreds);

  const keysBase: SignalKeyStore = {
    get: async <T extends keyof SignalDataTypeMap>(
      type: T,
      ids: string[],
    ): Promise<{ [id: string]: SignalDataTypeMap[T] }> => {
      if (ids.length === 0) return {};
      const rows = await db
        .select({ clave: whatsappAuth.clave, valor: whatsappAuth.valor })
        .from(whatsappAuth)
        .where(
          and(
            eq(whatsappAuth.sessionId, sessionId),
            eq(whatsappAuth.categoria, type),
            inArray(whatsappAuth.clave, ids),
          ),
        );

      const result: { [id: string]: SignalDataTypeMap[T] } = {};
      for (const row of rows) {
        const texto = open(row.valor, key);
        const parsed = deserializar(texto);
        result[row.clave] =
          type === 'app-state-sync-key'
            ? (proto.Message.AppStateSyncKeyData.fromObject(
                parsed as Record<string, unknown>,
              ) as unknown as SignalDataTypeMap[T])
            : (parsed as SignalDataTypeMap[T]);
      }
      return result;
    },

    set: async (data: SignalDataSet): Promise<void> => {
      const entries: { categoria: string; clave: string; valor: string | null }[] = [];
      for (const [tipo, valores] of Object.entries(data)) {
        if (valores === undefined) continue;
        for (const [clave, valor] of Object.entries(valores)) {
          entries.push({
            categoria: tipo,
            clave,
            valor: valor === null ? null : serializar(valor),
          });
        }
      }
      if (entries.length > 0) await writeRows(entries);
    },

    clear: async (): Promise<void> => {
      await db.delete(whatsappAuth).where(eq(whatsappAuth.sessionId, sessionId));
    },
  };

  const keys = makeCacheableSignalKeyStore(keysBase);

  return {
    state: { creds, keys },
    saveCreds: async () => {
      await writeRows([{ categoria: CREDS, clave: '', valor: serializar(creds) }]);
    },
    clear: async () => {
      // También vacía la caché en memoria: tras un `loggedOut` se vuelve a
      // vincular con el mismo objeto de sesión y no puede quedar nada viejo.
      await keys.clear?.();
      await db.delete(whatsappAuth).where(eq(whatsappAuth.sessionId, sessionId));
    },
    hasCreds: async () => (await readRow(CREDS, '')) !== null,
  };
};
