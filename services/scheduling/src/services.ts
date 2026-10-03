import type { SchedulingConfig } from './config.js';
import type { SchedulingDb } from './db/client.js';
import type pg from 'pg';

/** Todo lo que necesitan las rutas del servicio de agenda. */
export interface SchedulingServices {
  config: SchedulingConfig;
  db: SchedulingDb;
  pool: pg.Pool;
}
