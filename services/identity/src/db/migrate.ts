import { runMigrations } from '@odontocrm/db';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadIdentityConfig } from '../config.js';

/**
 * Entrada de migraciones del servicio: `npm run db:migrate -w @odontocrm/identity`
 * (o `npm run db:migrate` desde la raíz, que recorre todos los servicios).
 * Aplica `services/identity/migrations` y es idempotente.
 */
const main = async (): Promise<void> => {
  const config = loadIdentityConfig();
  const here = dirname(fileURLToPath(import.meta.url));
  const migrationsFolder = resolve(here, '../../migrations');

  await runMigrations({
    connectionString: config.DATABASE_URL,
    applicationName: 'odontocrm-identity',
    migrationsFolder,
  });

  // eslint-disable-next-line no-console -- script de línea de comandos
  console.log(`Migraciones de identity aplicadas desde ${migrationsFolder}`);
};

await main();
