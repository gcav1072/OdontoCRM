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
  TEST_SCREENS_DATABASE_URL:
    process.env.TEST_SCREENS_DATABASE_URL ?? readEnvValue('services/screens/.env', 'DATABASE_URL'),
  TEST_CLINICAL_DATABASE_URL:
    process.env.TEST_CLINICAL_DATABASE_URL ??
    readEnvValue('services/clinical/.env', 'DATABASE_URL'),
  TEST_ODONTOGRAM_DATABASE_URL:
    process.env.TEST_ODONTOGRAM_DATABASE_URL ??
    readEnvValue('services/odontogram/.env', 'DATABASE_URL'),
  TEST_REPORTING_DATABASE_URL:
    process.env.TEST_REPORTING_DATABASE_URL ??
    readEnvValue('services/reporting/.env', 'DATABASE_URL'),
  TEST_BILLING_DATABASE_URL:
    process.env.TEST_BILLING_DATABASE_URL ?? readEnvValue('services/billing/.env', 'DATABASE_URL'),
};

/**
 * Base **propia** para las suites que afirman cifras o estados **absolutos** sobre datos compartidos.
 *
 * La de reportes lo es: con la pila en marcha, el servicio de reportes proyecta en esa misma base los
 * eventos que publican las demás suites y el humo, y los totales cambiaban según lo que estuviera
 * corriendo. La de **facturación** también: da por hecho que no hay tasa publicada para hoy ni lotes
 * de formas en la serie real, y eso es exactamente lo que dejan el uso de verdad y el humo de
 * facturación.
 *
 * A cada una se le prepara una base temporal (como hace `db:verify-migrations`) con las extensiones y
 * las migraciones del servicio, y se borra al terminar. Si falta `PG_ADMIN_URL` o el build, se usa la
 * base del servicio y la suite se aísla por su cuenta.
 */
const prepararBaseTemporal = async ({ variable, servicio, etiqueta, temporal, aislamiento }) => {
  const compartida = extraEnv[variable];
  const adminUrl = process.env.PG_ADMIN_URL ?? readEnvValue('.env', 'PG_ADMIN_URL');
  const migrador = resolve(ROOT, `services/${servicio}/dist/db/migrate.js`);
  if (compartida === undefined || adminUrl === undefined || !existsSync(migrador)) {
    console.warn(
      `· Suite de ${etiqueta.toLowerCase()} sobre la base del servicio (falta PG_ADMIN_URL o el ` +
        `build): ${aislamiento}.`,
    );
    return { url: compartida, temporal: undefined };
  }

  const { default: pg } = await import('pg');
  const { runMigrations } = await import('../packages/db/dist/index.js');
  const owner = decodeURIComponent(new URL(compartida).username);
  if (!/^[a-z_][a-z0-9_]*$/.test(owner) || !/^[a-z_][a-z0-9_]*$/.test(temporal)) {
    return { url: compartida, temporal: undefined };
  }

  const admin = new pg.Client({
    connectionString: adminUrl,
    application_name: 'odontocrm-test-db',
  });
  await admin.connect();
  try {
    await admin.query(`drop database if exists "${temporal}" with (force)`);
    await admin.query(`create database "${temporal}" owner "${owner}"`);
  } finally {
    await admin.end();
  }

  const url = compartida.replace(/\/[^/]+$/, `/${temporal}`);
  // Las extensiones las crea el bootstrap en cada base (`pgcrypto` para
  // `gen_random_uuid()`): la base de prueba tiene que nacer igual.
  const extensiones = new pg.Client({
    connectionString: url,
    application_name: 'odontocrm-test-ext',
  });
  await extensiones.connect();
  try {
    await extensiones.query('create extension if not exists pgcrypto');
    await extensiones.query('create extension if not exists pg_trgm');
  } finally {
    await extensiones.end();
  }

  await runMigrations({
    connectionString: url,
    applicationName: `odontocrm-test-${servicio}`,
    migrationsFolder: resolve(ROOT, `services/${servicio}/migrations`),
  });
  console.log(`· ${etiqueta}: base temporal "${temporal}" preparada y migrada.`);
  return { url, temporal };
};

const reportes = await prepararBaseTemporal({
  variable: 'TEST_REPORTING_DATABASE_URL',
  servicio: 'reporting',
  etiqueta: 'Reportes',
  temporal: 'odonto_reporting_prueba',
  aislamiento: 'se aísla vaciando el read model y acotando el rango de fechas',
});
if (reportes.url !== undefined) extraEnv.TEST_REPORTING_DATABASE_URL = reportes.url;

const facturacion = await prepararBaseTemporal({
  variable: 'TEST_BILLING_DATABASE_URL',
  servicio: 'billing',
  etiqueta: 'Facturación',
  temporal: 'odonto_billing_prueba',
  aislamiento: 'la suite se aísla marcando su propia tasa y su propia serie de formas',
});
if (facturacion.url !== undefined) extraEnv.TEST_BILLING_DATABASE_URL = facturacion.url;

const url = new URL(databaseUrl);
console.log(
  `Pruebas de integración contra ${url.hostname}:${url.port}${url.pathname} (usuario ${url.username})`,
);

const passthrough = process.argv.slice(2);
// Sin argumentos corre **toda** la suite: con `TEST_DATABASE_URL` presente, las
// pruebas de integración (que sin ella se omiten) se ejecutan de verdad.
//
// `--maxWorkers`: varias suites publican eventos y **esperan a que los servicios en
// marcha los auditen** (la auditoría vive en identity y llega por el outbox). Con los
// 68 archivos en paralelo y los 9 servicios consumiendo la misma cola, la espera se
// quedaba corta de vez en cuando y fallaba una suite distinta en cada corrida; con
// cuatro workers la suite es reproducible. Se puede subir con
// `npm run test:integration -- --maxWorkers=8` cuando la máquina esté libre.
const vitestArgs = ['run', '--maxWorkers=4', ...passthrough];

const result = spawnSync(
  process.execPath,
  [resolve(ROOT, 'node_modules/vitest/vitest.mjs'), ...vitestArgs],
  {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
  },
);

// Las bases temporales no se quedan por ahí: se borran siempre.
for (const base of [reportes, facturacion]) {
  if (base.temporal === undefined) continue;
  const { default: pg } = await import('pg');
  const adminUrl = process.env.PG_ADMIN_URL ?? readEnvValue('.env', 'PG_ADMIN_URL');
  const admin = new pg.Client({
    connectionString: adminUrl,
    application_name: 'odontocrm-test-db',
  });
  try {
    await admin.connect();
    await admin.query(`drop database if exists "${base.temporal}" with (force)`);
    console.log(`· Base temporal "${base.temporal}" borrada.`);
  } catch {
    console.warn(
      `· No se pudo borrar la base temporal "${base.temporal}" (se borrará en la próxima corrida).`,
    );
  } finally {
    await admin.end().catch(() => undefined);
  }
}

/**
 * Las colas de prueba (`domain-events.prueba-*`) se borran al terminar: cada suite
 * declara la suya para no ensuciar las de los servicios, pero si se quedan, el
 * tablero de estado (`npm run estado`) las ve como colas con trabajos pendientes
 * para siempre y las alertas se vuelven ruido.
 */
const limpiarColasDePrueba = async () => {
  const eventsUrl = extraEnv.TEST_EVENTS_DATABASE_URL;
  if (eventsUrl === undefined) return;
  const { default: pg } = await import('pg');
  const client = new pg.Client({
    connectionString: eventsUrl,
    application_name: 'odontocrm-test-colas',
  });
  try {
    await client.connect();
    const { rowCount } = await client.query(
      `delete from pgboss.queue where name like 'domain-events.prueba-%'`,
    );
    await client.query(`delete from pgboss.job where name like 'domain-events.prueba-%'`);
    if ((rowCount ?? 0) > 0) console.log(`· Colas de prueba borradas: ${String(rowCount)}.`);
  } catch {
    console.warn('· No se pudieron borrar las colas de prueba (no afecta al resultado).');
  } finally {
    await client.end().catch(() => undefined);
  }
};

await limpiarColasDePrueba();

process.exit(result.status ?? 1);
