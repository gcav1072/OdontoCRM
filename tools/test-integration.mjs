#!/usr/bin/env node
/**
 * Ejecuta las pruebas de integración (base de datos real).
 *
 * Toma `TEST_DATABASE_URL` del primer `.env` de servicio que tenga `DATABASE_URL`
 * (por defecto el de identity) y lanza Vitest. Nunca imprime la cadena de
 * conexión.
 *
 *   npm run test:integration
 *   npm run test:integration -- packages/db/src/outbox.integration.test.ts
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const CANDIDATES = ['services/identity/.env', 'services/patients/.env', 'services/scheduling/.env'];

const readEnvValue = (relativePath, key) => {
  const path = resolve(ROOT, relativePath);
  if (!existsSync(path)) return undefined;
  const match = new RegExp(`^${key}=(.*)$`, 'm').exec(readFileSync(path, 'utf8'));
  return match?.[1]?.trim();
};

const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  CANDIDATES.map((candidate) => readEnvValue(candidate, 'DATABASE_URL')).find(Boolean);

if (databaseUrl === undefined) {
  console.error(
    'No hay TEST_DATABASE_URL ni DATABASE_URL en los .env de los servicios.\n' +
      'Ejecuta primero:  npm run db:bootstrap  &&  npm run db:migrate',
  );
  process.exit(1);
}

const url = new URL(databaseUrl);
console.log(
  `Pruebas de integración contra ${url.hostname}:${url.port}${url.pathname} (usuario ${url.username})`,
);

const passthrough = process.argv.slice(2);
const vitestArgs = ['run', ...(passthrough.length > 0 ? passthrough : ['packages/db/src'])];

const result = spawnSync(
  process.execPath,
  [resolve(ROOT, 'node_modules/vitest/vitest.mjs'), ...vitestArgs],
  {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, TEST_DATABASE_URL: databaseUrl },
  },
);

process.exit(result.status ?? 1);
