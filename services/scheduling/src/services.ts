import type { SchedulingConfig } from './config.js';
import type { SchedulingDb } from './db/client.js';
import type pg from 'pg';

import type { ClinicalSessionLookup } from './shared/clinical-client.js';

/** Todo lo que necesitan las rutas del servicio de agenda. */
export interface SchedulingServices {
  config: SchedulingConfig;
  db: SchedulingDb;
  pool: pg.Pool;
  /**
   * Comprueba contra el servicio clínico que la sesión exista y esté cerrada:
   * es lo que respalda el «atendido» sin motivo (Fase 7).
   */
  sessionLookup: ClinicalSessionLookup;
  /**
   * Adelanta la publicación de los eventos pendientes. Sirve para lo que tiene
   * que verse **ya** en otra pantalla: el llamado de la secretaría aparece en el
   * displaylobby sin esperar al temporizador del publicador.
   */
  kickOutbox?: (() => void) | undefined;
}
