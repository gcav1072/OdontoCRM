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

/**
 * Bases que necesitan las pruebas de integración de varios servicios: la de
 * pacientes, la de identity y la cola de eventos compartida. Se leen de los
 * `.env` y se exponen como variables `TEST_*` para las pruebas.
 */
const extraEnv = {
  TEST_DATABASE_URL: databaseUrl,
  TEST_IDENTITY_DATABASE_URL:
    process.env.TEST_IDENTITY_DATABASE_URL ??
    readEnvValue('services/identity/.env', 'DATABASE_URL'),
  TEST_PATIENTS_DATABASE_URL:
    process.env.TEST_PATIENTS_DATABASE_URL ??
    readEnvValue('services/patients/.env', 'DATABASE_URL'),
  TEST_EVENTS_DATABASE_URL:
    process.env.TEST_EVENTS_DATABASE_URL ??
    readEnvValue('services/identity/.env', 'EVENTS_DATABASE_URL'),
  TEST_SCHEDULING_DATABASE_URL:
    process.env.TEST_SCHEDULING_DATABASE_URL ??
    readEnvValue('services/scheduling/.env', 'DATABASE_URL'),
  TEST_NOTIFICATIONS_DATABASE_URL:
    process.env.TEST_NOTIFICATIONS_DATABASE_URL ??
    readEnvValue('services/notifications/.env', 'DATABASE_URL'),
};

const url = new URL(databaseUrl);
console.log(
  `Pruebas de integración contra ${url.hostname}:${url.port}${url.pathname} (usuario ${url.username})`,
);

const passthrough = process.argv.slice(2);
// Sin argumentos corre **toda** la suite: con `TEST_DATABASE_URL` presente, las
// pruebas de integración (que sin ella se omiten) se ejecutan de verdad.
const vitestArgs = ['run', ...passthrough];

const result = spawnSync(
  process.execPath,
  [resolve(ROOT, 'node_modules/vitest/vitest.mjs'), ...vitestArgs],
  {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
  },
);

process.exit(result.status ?? 1);
