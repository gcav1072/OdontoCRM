import { runMigrations } from '@odontocrm/db';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadClinicalConfig } from '../config.js';

/**
 * Entrada de migraciones del servicio clínico:
 *   npm run db:migrate -w @odontocrm/clinical
 * (o `npm run db:migrate` desde la raíz, que recorre todos los servicios).
 */
const main = async (): Promise<void> => {
  const config = loadClinicalConfig();
  const here = dirname(fileURLToPath(import.meta.url));
  const migrationsFolder = resolve(here, '../../migrations');

  await runMigrations({
    connectionString: config.DATABASE_URL,
    applicationName: 'odontocrm-clinical',
    migrationsFolder,
  });

  // eslint-disable-next-line no-console -- script de línea de comandos
  console.log(`Migraciones de clinical aplicadas desde ${migrationsFolder}`);
};

await main();
