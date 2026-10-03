import { runMigrations } from '@odontocrm/db';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadSchedulingConfig } from '../config.js';

/**
 * Migraciones del servicio de agenda:
 *   npm run db:migrate -w @odontocrm/scheduling
 * (o `npm run db:migrate` desde la raíz, que recorre todos los servicios).
 */
const main = async (): Promise<void> => {
  const config = loadSchedulingConfig();
  const here = dirname(fileURLToPath(import.meta.url));
  const migrationsFolder = resolve(here, '../../migrations');

  await runMigrations({
    connectionString: config.DATABASE_URL,
    applicationName: 'odontocrm-scheduling',
    migrationsFolder,
  });

  // eslint-disable-next-line no-console -- script de línea de comandos
  console.log(`Migraciones de scheduling aplicadas desde ${migrationsFolder}`);
};

await main();
