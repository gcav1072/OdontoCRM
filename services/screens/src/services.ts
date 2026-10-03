import type { ScreensConfig } from './config.js';
import type { ScreensDb } from './db/client.js';
import type { ScreenBroadcaster } from './sala/broadcast.js';
import type pg from 'pg';

/** Todo lo que necesitan las rutas y el consumidor del servicio de pantallas. */
export interface ScreensServices {
  config: ScreensConfig;
  db: ScreensDb;
  pool: pg.Pool;
  /** Reparto del estado a las pantallas conectadas por SSE. */
  broadcast: ScreenBroadcaster;
  /** Último error del consumidor de eventos, para mostrarlo en la administración. */
  lastError: string | null;
}
