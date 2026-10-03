#!/usr/bin/env node
/**
 * Aplica las migraciones de todos los servicios implementados.
 *
 * Uso:
 *   npm run db:migrate                 → todos los servicios
 *   npm run db:migrate -- --only identity
 *
 * Requiere haber compilado antes (`npm run build`): las migraciones se ejecutan
 * desde `dist/` para que usen exactamente el mismo código que producción.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const SERVICES = [
  {
    name: 'identity',
    script: 'services/identity/dist/db/migrate.js',
    envFile: 'services/identity/.env',
  },
  {
    name: 'patients',
    script: 'services/patients/dist/db/migrate.js',
    envFile: 'services/patients/.env',
  },
];

const args = process.argv.slice(2);
const onlyIndex = args.indexOf('--only');
const only = onlyIndex === -1 ? undefined : args[onlyIndex + 1];

const targets = only === undefined ? SERVICES : SERVICES.filter((service) => service.name === only);

if (targets.length === 0) {
  console.error(
    `No hay ningún servicio llamado "${only ?? ''}". Opciones: ${SERVICES.map((s) => s.name).join(', ')}`,
  );
  process.exit(1);
}

for (const service of targets) {
  if (!existsSync(service.script)) {
    console.error(
      `Falta ${service.script}. Ejecuta primero "npm run build" (las migraciones corren sobre el código compilado).`,
    );
    process.exit(1);
  }

  console.log(`\n── Migrando ${service.name} ─────────────────────────────────────────`);

  const result = spawnSync(
    process.execPath,
    ['--env-file-if-exists=.env', `--env-file-if-exists=${service.envFile}`, service.script],
    { stdio: 'inherit', cwd: resolve(process.cwd()) },
  );

  if (result.status !== 0) {
    console.error(`\nLa migración de ${service.name} falló (código ${String(result.status)}).`);
    process.exit(result.status ?? 1);
  }
}

console.log('\nMigraciones aplicadas correctamente ✔');
