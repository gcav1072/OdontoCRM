import { eq } from 'drizzle-orm';

import type { BotServices } from './bot.js';
import { handleUpdate } from './bot.js';
import { botState, processedUpdates } from './db/schema.js';
import type { TelegramUpdate } from './telegram.js';

const OFFSET_KEY = 'update_offset';

export interface PollerResult {
  fetched: number;
  handled: number;
  duplicated: number;
}

export interface Poller {
  start: () => void;
  stop: () => Promise<void>;
  /** Un ciclo completo de `getUpdates` (para pruebas y para forzar un refresco). */
  tick: () => Promise<PollerResult>;
}

/**
 * Poller **único** del bot (ADR 0008 y plan §7): Telegram prohíbe dos `getUpdates`
 * simultáneos, así que solo corre un proceso con el token.
 *
 * - El `offset` se guarda en la base: un reinicio no vuelve a pedir lo ya visto.
 * - Cada `update_id` se marca en `processed_updates` **antes** de procesarlo: una
 *   pulsación repetida (o un reintento de Telegram) no crea dos tickets.
 * - Un fallo al procesar un mensaje se registra y no tumba el poller.
 */
export const createPoller = (
  services: BotServices,
  options: { onError?: (error: unknown) => void; onCycle?: (result: PollerResult) => void } = {},
): Poller => {
  let running = false;
  let stopping = false;

  const readOffset = async (): Promise<number> => {
    const rows = await services.db
      .select()
      .from(botState)
      .where(eq(botState.key, OFFSET_KEY))
      .limit(1);
    return rows[0] === undefined ? 0 : Number(rows[0].value);
  };

  const writeOffset = async (offset: number): Promise<void> => {
    await services.db
      .insert(botState)
      .values({ key: OFFSET_KEY, value: String(offset) })
      .onConflictDoUpdate({
        target: botState.key,
        set: { value: String(offset), updatedAt: new Date() },
      });
  };

  const processUpdate = async (update: TelegramUpdate): Promise<boolean> => {
    const chatId =
      update.callback_query?.message?.chat.id === undefined
        ? update.message?.chat.id === undefined
          ? null
          : String(update.message.chat.id)
        : String(update.callback_query.message.chat.id);

    const claimed = await services.db
      .insert(processedUpdates)
      .values({ updateId: update.update_id, chatId })
      .onConflictDoNothing({ target: processedUpdates.updateId })
      .returning({ updateId: processedUpdates.updateId });

    // Ya estaba procesado: se ignora (idempotencia por update_id).
    if (claimed.length === 0) return false;

    await handleUpdate(services, update);
    return true;
  };

  const tick = async (): Promise<PollerResult> => {
    const offset = await readOffset();
    const updates = await services.transport.getUpdates(
      offset,
      services.config.TELEGRAM_POLL_TIMEOUT_SECONDS,
    );

    let handled = 0;
    let duplicated = 0;
    for (const update of updates) {
      try {
        const done = await processUpdate(update);
        if (done) handled += 1;
        else duplicated += 1;
      } catch (error) {
        options.onError?.(error);
      }
      await writeOffset(update.update_id + 1);
    }

    const result = { fetched: updates.length, handled, duplicated };
    if (updates.length > 0) options.onCycle?.(result);
    return result;
  };

  return {
    tick,

    start: () => {
      if (running || stopping) return;
      running = true;

      const loop = async (): Promise<void> => {
        while (!stopping) {
          try {
            await tick();
          } catch (error) {
            // El long polling puede fallar por red: se espera un poco y se sigue.
            options.onError?.(error);
            await new Promise((resolve) => setTimeout(resolve, 5_000));
          }
        }
        running = false;
      };

      void loop();
    },

    stop: async () => {
      stopping = true;
      // El ciclo en curso termina solo (el long polling dura como mucho el timeout).
      for (let attempt = 0; attempt < 40 && running; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    },
  };
};
