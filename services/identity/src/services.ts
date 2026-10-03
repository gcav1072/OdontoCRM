import type { PrivateKey } from '@odontocrm/kernel';
import type pg from 'pg';

import type { IdentityConfig } from './config.js';
import type { IdentityDb } from './db/client.js';

/** Todo lo que necesitan las rutas del servicio, en un solo objeto. */
export interface IdentityServices {
  config: IdentityConfig;
  db: IdentityDb;
  pool: pg.Pool;
  privateKey: PrivateKey;
}
