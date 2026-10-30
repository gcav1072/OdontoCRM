import type { proto, WAMessageKey } from '@whiskeysockets/baileys';

/**
 * Caché en memoria de los últimos mensajes **enviados** (D10).
 *
 * Baileys vuelve a pedir el contenido con `getMessage` cuando WhatsApp no pudo
 * descifrar un mensaje (el clásico «espera un momento»). El historial completo
 * está desactivado a propósito, así que se recuerda solo una ventana corta: los
 * últimos ~500 mensajes durante 24 h. No se guardan chats ni mensajes recibidos.
 */
export interface MessageCache {
  record: (key: WAMessageKey, message: proto.IMessage) => void;
  get: (key: WAMessageKey) => proto.IMessage | undefined;
  clear: () => void;
  size: () => number;
}

const keyOf = (key: WAMessageKey): string => `${key.remoteJid ?? ''}\u0000${key.id ?? ''}`;

export const createMessageCache = (
  options: {
    max?: number;
    ttlMs?: number;
    now?: () => number;
  } = {},
): MessageCache => {
  const max = Math.max(1, options.max ?? 500);
  const ttlMs = Math.max(0, options.ttlMs ?? 24 * 60 * 60_000);
  const now = options.now ?? (() => Date.now());
  const entradas = new Map<string, { message: proto.IMessage; expira: number }>();

  const limpiarVencidos = (): void => {
    const instante = now();
    for (const [clave, entrada] of entradas) {
      if (entrada.expira <= instante) entradas.delete(clave);
    }
  };

  return {
    record: (key, message) => {
      limpiarVencidos();
      const clave = keyOf(key);
      entradas.delete(clave);
      entradas.set(clave, { message, expira: now() + ttlMs });
      while (entradas.size > max) {
        const primera = entradas.keys().next().value;
        if (primera === undefined) break;
        entradas.delete(primera);
      }
    },

    get: (key) => {
      const clave = keyOf(key);
      const entrada = entradas.get(clave);
      if (entrada === undefined) return undefined;
      if (entrada.expira <= now()) {
        entradas.delete(clave);
        return undefined;
      }
      // LRU: un acierto lo mueve al final.
      entradas.delete(clave);
      entradas.set(clave, entrada);
      return entrada.message;
    },

    clear: () => entradas.clear(),
    size: () => {
      limpiarVencidos();
      return entradas.size;
    },
  };
};
