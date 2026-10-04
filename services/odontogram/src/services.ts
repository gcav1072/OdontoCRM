import type pg from 'pg';

import type { OdontogramConfig } from './config.js';
import type { OdontogramDb } from './db/client.js';
import type { PatientSnapshotLookup } from './shared/patient-client.js';

/** Todo lo que necesitan las rutas del servicio, en un solo objeto. */
export interface OdontogramServices {
  config: OdontogramConfig;
  db: OdontogramDb;
  pool: pg.Pool;
  patientLookup: PatientSnapshotLookup;
  /** Adelanta el publicador del outbox (lo conecta `index.ts`). */
  kickOutbox?: (() => void) | undefined;
}
