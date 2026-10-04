import { runMigrations } from '@odontocrm/db';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadReportingConfig } from '../config.js';

/**
 * Migraciones del servicio de reportes:
 *   npm run db:migrate -w @odontocrm/reporting
 * (o `npm run db:migrate -- --only reporting` desde la raíz).
 */
const main = async (): Promise<void> => {
  const config = loadReportingConfig();
  const here = dirname(fileURLToPath(import.meta.url));
  const migrationsFolder = resolve(here, '../../migrations');

  await runMigrations({
    connectionString: config.DATABASE_URL,
    applicationName: 'odontocrm-reporting',
    migrationsFolder,
  });

  // eslint-disable-next-line no-console -- script de línea de comandos
  console.log(`Migraciones de reporting aplicadas desde ${migrationsFolder}`);
};

await main();
