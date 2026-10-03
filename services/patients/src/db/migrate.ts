import { runMigrations } from '@odontocrm/db';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadPatientsConfig } from '../config.js';

/**
 * Entrada de migraciones del servicio de pacientes:
 *   npm run db:migrate -w @odontocrm/patients
 * (o `npm run db:migrate` desde la raíz, que recorre todos los servicios).
 */
const main = async (): Promise<void> => {
  const config = loadPatientsConfig();
  const here = dirname(fileURLToPath(import.meta.url));
  const migrationsFolder = resolve(here, '../../migrations');

  await runMigrations({
    connectionString: config.DATABASE_URL,
    applicationName: 'odontocrm-patients',
    migrationsFolder,
  });

  // eslint-disable-next-line no-console -- script de línea de comandos
  console.log(`Migraciones de patients aplicadas desde ${migrationsFolder}`);
};

await main();
