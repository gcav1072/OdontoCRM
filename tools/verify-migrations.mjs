#!/usr/bin/env node
/**
 * Verificación de aceptación: las migraciones de **cada servicio** se aplican
 * desde cero sobre una base limpia (DoD común a todas las fases del plan).
 *
 *   npm run db:verify-migrations                 → todos los servicios
 *   npm run db:verify-migrations -- --only screens
 *
 * Por cada servicio: crea una base temporal con su rol, aplica sus migraciones con
 * el migrador real del proyecto, comprueba que quedaron las tablas esperadas (y que
 * ningún CHECK se quedó con parámetros `$n`, el tropiezo conocido de drizzle-kit) y
 * borra la base. Nunca imprime credenciales.
 *
 * Requiere `npm run build` previo (usa `packages/db/dist`) y `PG_ADMIN_URL` en el
 * `.env` de la raíz.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Servicios con migraciones propias, en el orden del plan. */
const SERVICES = [
  {
    name: 'identity',
    migrations: 'services/identity/migrations',
    tables: ['users', 'audit_events'],
  },
  {
    name: 'patients',
    migrations: 'services/patients/migrations',
    tables: ['patients', 'patient_files'],
  },
  {
    name: 'scheduling',
    migrations: 'services/scheduling/migrations',
    tables: ['appointments', 'appointment_requests'],
  },
  {
    name: 'notifications',
    migrations: 'services/notifications/migrations',
    tables: ['bot_conversations', 'notifications', 'ics_artifacts'],
  },
  {
    name: 'screens',
    migrations: 'services/screens/migrations',
    tables: ['screen_devices', 'room_state', 'call_events'],
  },
  {
    name: 'clinical',
    migrations: 'services/clinical/migrations',
    tables: [
      'medical_records',
      'medical_record_sections',
      'medical_record_amendments',
      // Fase 7A: la evolución, y 7B: adjuntos de la sesión y récipes.
      'clinical_sessions',
      'clinical_session_files',
      'medications_catalog',
      'prescriptions',
      'prescription_items',
    ],
  },
  {
    name: 'odontogram',
    migrations: 'services/odontogram/migrations',
    tables: ['odontograms', 'tooth_findings', 'tooth_finding_history', 'odontogram_prints'],
  },
  {
    name: 'reporting',
    migrations: 'services/reporting/migrations',
    tables: [
      'dim_patient',
      'fact_request',
      'fact_appointment',
      'fact_clinical_session',
      'fact_prescription',
      'fact_prescription_item',
      'fact_tooth_finding',
      'dim_day_capacity',
      'patient_profiles',
      'report_refreshes',
      'processed_events',
    ],
  },
  {
    name: 'billing',
    migrations: 'services/billing/migrations',
    tables: [
      'exchange_rates',
      'billing_settings',
      'invoice_series',
      'fiscal_forms',
      'treatment_catalog',
      'invoices',
      'invoice_items',
      'invoice_sessions',
      'payments',
      'credit_notes',
      'credit_note_items',
      'processed_events',
    ],
  },
];

const args = process.argv.slice(2);
const onlyIndex = args.indexOf('--only');
const only = onlyIndex === -1 ? undefined : args[onlyIndex + 1];
const targets = only === undefined ? SERVICES : SERVICES.filter((s) => s.name === only);

if (targets.length === 0) {
  console.error(
    `No hay ningún servicio llamado "${only ?? ''}". Opciones: ${SERVICES.map((s) => s.name).join(', ')}`,
  );
  process.exit(1);
}

const ADMIN_URL = process.env.PG_ADMIN_URL;
if (ADMIN_URL === undefined) {
  console.error(
    'Falta PG_ADMIN_URL (en el .env de la raíz).\n' +
      'Ejecuta:  npm run db:bootstrap  &&  npm run db:migrate',
  );
  process.exit(1);
}

const readEnvValue = (relativePath, key) => {
  const path = resolve(ROOT, relativePath);
  if (!existsSync(path)) return undefined;
  const match = new RegExp(`^${key}=(.*)$`, 'm').exec(readFileSync(path, 'utf8'));
  return match?.[1]?.trim();
};

const { runMigrations } = await import('../packages/db/dist/index.js').catch(() => {
  console.error('Falta packages/db/dist. Ejecuta primero "npm run build".');
  process.exit(1);
});
const { default: pg } = await import('pg');

const admin = new pg.Client({
  connectionString: ADMIN_URL,
  application_name: 'odontocrm-mig-check',
});

let fallos = 0;
const fallo = (mensaje) => {
  console.error(`  ✖ ${mensaje}`);
  fallos += 1;
};

/** Todo el trabajo de un servicio, con su base temporal y su rol. */
const verificarServicio = async (servicio) => {
  const serviceUrl =
    process.env[`TEST_${servicio.name.toUpperCase()}_DATABASE_URL`] ??
    readEnvValue(`services/${servicio.name}/.env`, 'DATABASE_URL');

  if (serviceUrl === undefined) {
    console.warn(`  ⚠ sin DATABASE_URL en services/${servicio.name}/.env: se omite`);
    return;
  }

  const owner = decodeURIComponent(new URL(serviceUrl).username);
  const temporal = `odonto_migracion_${servicio.name}`;
  if (!/^[a-z_][a-z0-9_]*$/.test(owner) || !/^[a-z_][a-z0-9_]*$/.test(temporal)) {
    fallo('el nombre de la base temporal o del rol no tiene el formato esperado');
    return;
  }

  const temporalUrl = serviceUrl.replace(/\/[^/]+$/, `/${temporal}`);
  await admin.query(`drop database if exists "${temporal}" with (force)`);
  await admin.query(`create database "${temporal}" owner "${owner}"`);

  // El bootstrap habilita las extensiones en cada base antes de migrar
  // (`pg_trgm` para buscar por nombre y `pgcrypto` para `gen_random_uuid()`), así
  // que la base de prueba tiene que nacer igual: no las crean las migraciones.
  const conExtensiones = new pg.Client({
    connectionString: ADMIN_URL.replace(/\/[^/]+$/, `/${temporal}`),
    application_name: 'odontocrm-mig-check-extensions',
  });
  try {
    await conExtensiones.connect();
    await conExtensiones.query('create extension if not exists pgcrypto');
    await conExtensiones.query('create extension if not exists pg_trgm');
  } catch (error) {
    fallo(`no se pudieron habilitar las extensiones (${String(error)})`);
    await admin.query(`drop database if exists "${temporal}" with (force)`).catch(() => undefined);
    return;
  } finally {
    await conExtensiones.end().catch(() => undefined);
  }

  try {
    await runMigrations({
      connectionString: temporalUrl,
      applicationName: 'odontocrm-mig-check',
      migrationsFolder: servicio.migrations,
    });

    const test = new pg.Client({
      connectionString: temporalUrl,
      application_name: 'odontocrm-mig-check',
    });
    await test.connect();
    try {
      const tablas = await test.query(
        "select tablename from pg_tables where schemaname = 'public' order by tablename",
      );
      const nombres = tablas.rows.map((fila) => fila.tablename);
      for (const tabla of ['outbox_events', ...servicio.tables]) {
        if (!nombres.includes(tabla)) fallo(`falta la tabla ${tabla}`);
      }

      const aplicadas = await test.query(
        'select count(1)::int as n from drizzle.__drizzle_migrations',
      );
      if (aplicadas.rows[0].n < 1) fallo('no se registró ninguna migración');

      // Tropiezo conocido: drizzle-kit parametriza los CHECK y el DDL no sustituye $n.
      const parametros = await test.query(
        "select count(1)::int as n from pg_constraint where pg_get_constraintdef(oid) like '%$%'",
      );
      if (parametros.rows[0].n > 0)
        fallo(`${String(parametros.rows[0].n)} CHECK con parámetros sin sustituir`);

      console.log(
        `  ✔ ${String(nombres.length)} tablas · ${String(aplicadas.rows[0].n)} migraciones · ${nombres
          .filter((n) => !n.startsWith('pg_'))
          .slice(0, 6)
          .join(', ')}…`,
      );
    } finally {
      await test.end();
    }
  } catch (error) {
    fallo(error instanceof Error ? error.message : String(error));
  } finally {
    await admin.query(`drop database if exists "${temporal}" with (force)`).catch((error) => {
      console.warn(`  ⚠ no se pudo borrar la base temporal (${String(error)})`);
    });
  }
};

try {
  await admin.connect();
  console.log(`Verificando ${String(targets.length)} servicio(s) desde cero en bases limpias`);
  for (const servicio of targets) {
    console.log(`\n── ${servicio.name} ──────────────────────────────────────────────`);
    await verificarServicio(servicio);
  }
} catch (error) {
  fallo(error instanceof Error ? error.message : String(error));
} finally {
  await admin.end().catch(() => undefined);
}

// El nombre de la base temporal no debe quedar en ningún sitio: se borra siempre.
if (fallos > 0) {
  console.error(`\nLa verificación de migraciones falló (${String(fallos)} problema(s)).`);
  process.exit(1);
}
console.log('\nMigraciones de todos los servicios verificadas desde cero ✔');
