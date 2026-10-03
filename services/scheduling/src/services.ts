import type { SchedulingConfig } from './config.js';
import type { SchedulingDb } from './db/client.js';
import type pg from 'pg';

/** Todo lo que necesitan las rutas del servicio de agenda. */
export interface SchedulingServices {
  config: SchedulingConfig;
  db: SchedulingDb;
  pool: pg.Pool;
  /**
   * Adelanta la publicación de los eventos pendientes. Sirve para lo que tiene
   * que verse **ya** en otra pantalla: el llamado de la secretaría aparece en el
   * displaylobby sin esperar al temporizador del publicador.
   */
  kickOutbox?: (() => void) | undefined;
}
