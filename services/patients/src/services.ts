import type { BlobStore } from '@odontocrm/storage';
import type { PatientsConfig } from './config.js';
import type { PatientsDb } from './db/client.js';
import type pg from 'pg';

/** Todo lo que necesitan las rutas del servicio, en un solo objeto. */
export interface PatientsServices {
  config: PatientsConfig;
  db: PatientsDb;
  pool: pg.Pool;
  blobStore: BlobStore;
}
