import { checkConnection, createDatabase, outboxEvents, type Database } from '@odontocrm/db';

import type { BillingConfig } from '../config.js';
import * as domain from './schema.js';

/**
 * Esquema completo de la base de facturación: dominio + outbox compartido.
 *
 * El outbox está declarado aunque el borrador **no publique evento** (es un acto interno que se puede
 * descartar): la tabla existe porque la migración la crea —igual que en `reporting`— y porque el
 * primer acto de dinero que se publica (emitir, cobrar) la necesita lista.
 */
export const billingSchema = { ...domain, outboxEvents };

export type BillingSchema = typeof billingSchema;
export type BillingDb = Database<BillingSchema>;

export interface BillingDatabaseHandle {
  db: BillingDb;
  pool: ReturnType<typeof createDatabase<BillingSchema>>['pool'];
  close: () => Promise<void>;
}

export const createBillingDatabase = (
  config: Pick<BillingConfig, 'DATABASE_URL' | 'DATABASE_POOL_MAX'>,
): BillingDatabaseHandle => {
  const handle = createDatabase({
    connectionString: config.DATABASE_URL,
    applicationName: 'odontocrm-billing',
    schema: billingSchema,
    maxConnections: config.DATABASE_POOL_MAX,
  });

  return { db: handle.db, pool: handle.pool, close: handle.close };
};

export { checkConnection };
