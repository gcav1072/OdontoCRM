import type pg from 'pg';

import type { BillingConfig } from './config.js';
import type { BillingDb } from './db/client.js';
import type { BillingPatientLookup } from './shared/patient-client.js';

/** Todo lo que necesitan las rutas del servicio de facturación. */
export interface BillingServices {
  config: BillingConfig;
  db: BillingDb;
  pool: pg.Pool;
  /** Ficha del paciente para la instantánea del documento (por la red interna). */
  patientLookup: BillingPatientLookup;
  /** Último error del consumidor, para el diagnóstico. */
  lastError: string | null;
}
