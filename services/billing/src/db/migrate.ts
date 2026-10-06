import { runMigrations } from '@odontocrm/db';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadBillingConfig } from '../config.js';

/**
 * Migraciones del servicio de facturación:
 *   npm run db:migrate -w @odontocrm/billing
 * (o `npm run db:migrate -- --only billing` desde la raíz).
 */
const main = async (): Promise<void> => {
  const config = loadBillingConfig();
  const here = dirname(fileURLToPath(import.meta.url));
  const migrationsFolder = resolve(here, '../../migrations');

  await runMigrations({
    connectionString: config.DATABASE_URL,
    applicationName: 'odontocrm-billing',
    migrationsFolder,
  });

  // eslint-disable-next-line no-console -- script de línea de comandos
  console.log(`Migraciones de billing aplicadas desde ${migrationsFolder}`);
};

await main();
