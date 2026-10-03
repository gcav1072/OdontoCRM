import type { NotificationsConfig } from './config.js';
import type { NotificationsDb } from './db/client.js';
import type { InternalClients } from './internal-client.js';
import type { TelegramTransport } from './telegram.js';
import type pg from 'pg';

/** Todo lo que necesitan las rutas y el bot del servicio de notificaciones. */
export interface NotificationsServices {
  config: NotificationsConfig;
  db: NotificationsDb;
  pool: pg.Pool;
  transport: TelegramTransport;
  clients: InternalClients;
  /** Último error del poller o de la cola, para mostrarlo en la bandeja. */
  lastError: string | null;
}
