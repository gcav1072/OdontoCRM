import type { CanalesHandle } from './canales/index.js';
import type { NotificationsConfig } from './config.js';
import type { NotificationsDb } from './db/client.js';
import type { InternalClients } from './internal-client.js';
import type pg from 'pg';

/** Todo lo que necesitan las rutas y el asistente del servicio de notificaciones. */
export interface NotificationsServices {
  config: NotificationsConfig;
  db: NotificationsDb;
  pool: pg.Pool;
  /** Adaptadores de canal (Telegram, WhatsApp…) y su registro (ADR 0029). */
  canales: CanalesHandle;
  clients: InternalClients;
  /** Último error del asistente o de la cola, para mostrarlo en la bandeja. */
  lastError: string | null;
}
