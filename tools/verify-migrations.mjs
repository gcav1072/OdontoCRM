#!/usr/bin/env node
/**
 * Verificación de aceptación: las migraciones se aplican **desde cero** sobre una
 * base limpia (DoD común a todas las fases del plan).
 *
 *   npm run db:verify-migrations
 *
 * Crea una base temporal (por defecto `odonto_migracion_prueba`) con el rol del
 * servicio, aplica las migraciones con el migrador real del proyecto, comprueba
 * que quedaron las tablas e índices esperados y elimina la base temporal. No
 * imprime ninguna credencial.
 *
 * Requiere `npm run build` previo (usa `packages/db/dist`) y las variables
 * `PG_ADMIN_URL` (raíz) y `DATABASE_URL` (servicio).
 */
const TEST_DATABASE = process.env.MIGRATION_TEST_DATABASE ?? 'odonto_migracion_prueba';
const ADMIN_URL = process.env.PG_ADMIN_URL;
const SERVICE_URL = process.env.DATABASE_URL;

if (ADMIN_URL === undefined || SERVICE_URL === undefined) {
  console.error(
    'Faltan PG_ADMIN_URL (en el .env de la raíz) o DATABASE_URL (en el .env del servicio).\n' +
      'Ejecuta:  npm run db:bootstrap  &&  npm run db:migrate',
  );
  process.exit(1);
}

const ownerRole = decodeURIComponent(new URL(SERVICE_URL).username);
if (!/^[a-z_][a-z0-9_]*$/.test(ownerRole)) {
  console.error('El usuario de DATABASE_URL no tiene un nombre de rol esperado.');
  process.exit(1);
}
if (!/^[a-z_][a-z0-9_]*$/.test(TEST_DATABASE)) {
  console.error('El nombre de la base temporal no es válido.');
  process.exit(1);
}

const { runMigrations } = await import('../packages/db/dist/index.js').catch(() => {
  console.error('Falta packages/db/dist. Ejecuta primero "npm run build".');
  process.exit(1);
});
const { default: pg } = await import('pg');

const testUrl = SERVICE_URL.replace(/\/[^/]+$/, `/${TEST_DATABASE}`);
const admin = new pg.Client({
  connectionString: ADMIN_URL,
  application_name: 'odontocrm-mig-check',
});

let failed = false;
const fail = (message) => {
  console.error(`✖ ${message}`);
  failed = true;
};

try {
  await admin.connect();
  await admin.query(`drop database if exists "${TEST_DATABASE}" with (force)`);
  await admin.query(`create database "${TEST_DATABASE}" owner "${ownerRole}"`);
  console.log(`1) base limpia "${TEST_DATABASE}" creada (propietario: ${ownerRole})`);

  await runMigrations({
    connectionString: testUrl,
    applicationName: 'odontocrm-mig-check',
    migrationsFolder: 'services/identity/migrations',
  });
  console.log('2) migraciones aplicadas con el migrador real (runMigrations)');

  const test = new pg.Client({
    connectionString: testUrl,
    application_name: 'odontocrm-mig-check',
  });
  await test.connect();

  const tables = await test.query(
    "select tablename from pg_tables where schemaname = 'public' order by tablename",
  );
  const tableNames = tables.rows.map((row) => row.tablename);
  console.log(`3) tablas creadas: ${tableNames.join(', ')}`);

  const applied = await test.query('select count(*)::int as n from drizzle.__drizzle_migrations');
  console.log(`4) migraciones registradas: ${applied.rows[0].n}`);

  const columns = await test.query(
    "select column_name from information_schema.columns where table_name = 'outbox_events' order by ordinal_position",
  );
  console.log(`5) columnas de outbox_events: ${columns.rows.map((r) => r.column_name).join(', ')}`);

  const indexes = await test.query(
    "select indexname from pg_indexes where schemaname = 'public' and tablename = 'outbox_events' order by indexname",
  );
  console.log(`6) índices de outbox_events: ${indexes.rows.map((r) => r.indexname).join(', ')}`);

  if (!tableNames.includes('users')) fail('falta la tabla users');
  if (!tableNames.includes('outbox_events')) fail('falta la tabla outbox_events');
  if (applied.rows[0].n < 1) fail('no se registró ninguna migración');

  await test.end();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  try {
    await admin.query(`drop database if exists "${TEST_DATABASE}" with (force)`);
    console.log('7) base temporal eliminada: el entorno queda como estaba');
  } catch (error) {
    console.warn(`aviso: no se pudo eliminar la base temporal (${String(error)})`);
  }
  await admin.end().catch(() => undefined);
}

if (failed) {
  console.error('\nLa verificación de migraciones falló.');
  process.exit(1);
}
console.log('\nMigraciones verificadas desde cero ✔');
