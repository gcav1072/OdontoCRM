import { hashPassword, verifyPassword } from '@odontocrm/kernel';
import { eq } from 'drizzle-orm';
import type { Role } from '@odontocrm/contracts';

import { loadIdentityConfig } from './config.js';
import { createIdentityDatabase } from './db/client.js';
import { userRoles, users } from './db/schema.js';

/**
 * Crea los usuarios iniciales del sistema (Fase 1):
 *   · `admin`     → administrador, acceso total
 *   · `recepcion` → secretaria (recepción, registro, programación, secretaría)
 *   · `egomez`    → odontóloga (consultorio, historia clínica, odontograma)
 *
 *   npm run build:node
 *   npm run seed:users -w @odontocrm/identity              (idempotente)
 *   npm run seed:users -w @odontocrm/identity -- --reset    (regenera contraseñas)
 *   npm run seed:users -w @odontocrm/identity -- --print    (recuerda las claves, sin tocar nada)
 *
 * Todas las contraseñas nacen como **temporales**: el sistema obliga a cambiarlas
 * en el primer acceso. En producción (`NODE_ENV=production`) hay que indicarlas
 * por variables de entorno; no se admiten los valores por defecto de desarrollo.
 */
interface SeedUser {
  username: string;
  fullName: string;
  roles: Role[];
  email: string | null;
  password: string;
  /** Variable de entorno que puede sustituir la contraseña por defecto. */
  passwordEnv: string;
}

const DEVELOPMENT_PASSWORDS = {
  admin: 'admin-odontocrm-2026',
  recepcion: 'recepcion-odontocrm-2026',
  egomez: 'consultorio-odontocrm-2026',
} as const;

const reset = process.argv.includes('--reset');
/** `--print`: solo recuerda las credenciales y su estado; no escribe en la base. */
const soloRecordar = process.argv.includes('--print');

const config = loadIdentityConfig();
const production = config.NODE_ENV === 'production';

const resolvePassword = (username: keyof typeof DEVELOPMENT_PASSWORDS): string => {
  const envName = `SEED_PASSWORD_${username.toUpperCase()}`;
  const fromEnv = process.env[envName];
  if (fromEnv !== undefined && fromEnv.length >= 10) return fromEnv;
  if (production) {
    throw new Error(
      `En producción define ${envName} (mínimo 10 caracteres) antes de sembrar usuarios.`,
    );
  }
  return DEVELOPMENT_PASSWORDS[username];
};

const SEED_USERS: SeedUser[] = [
  {
    username: 'admin',
    fullName: 'Administrador del sistema',
    roles: ['admin'],
    email: null,
    password: resolvePassword('admin'),
    passwordEnv: 'SEED_PASSWORD_ADMIN',
  },
  {
    username: 'recepcion',
    fullName: 'María Pérez',
    roles: ['secretario'],
    email: null,
    password: resolvePassword('recepcion'),
    passwordEnv: 'SEED_PASSWORD_RECEPCION',
  },
  {
    username: 'egomez',
    fullName: 'Od. Erika Gómez',
    roles: ['odontologo'],
    email: null,
    password: resolvePassword('egomez'),
    passwordEnv: 'SEED_PASSWORD_EGOMEZ',
  },
];

const database = createIdentityDatabase(config);

/**
 * Recuerda las credenciales sembradas y, si se puede consultar la base, **si la
 * contraseña por defecto sigue valiendo** (o si alguien la cambió, o si la cuenta
 * está bloqueada por intentos fallidos). No escribe nada.
 */
const recordarCredenciales = async (): Promise<void> => {
  // eslint-disable-next-line no-console -- script de línea de comandos
  console.log('Credenciales sembradas (todas nacen como temporales):\n');

  let filas: {
    username: string;
    passwordHash: string;
    failedAttempts: number;
    lockedUntil: Date | null;
  }[] = [];
  try {
    filas = await database.db
      .select({
        username: users.username,
        passwordHash: users.passwordHash,
        failedAttempts: users.failedAttempts,
        lockedUntil: users.lockedUntil,
      })
      .from(users);
  } catch {
    // Sin base de datos (o sin migrar) se recuerdan igual: es lo que se viene a buscar.
    // eslint-disable-next-line no-console -- script de línea de comandos
    console.log(
      '(No se pudo consultar la base: se muestra la contraseña por defecto sin comprobarla.)\n',
    );
  }

  for (const seedUser of SEED_USERS) {
    const fila = filas.find((usuario) => usuario.username === seedUser.username);
    let estado = 'no existe todavía: créalo con  npm run seed:users';

    if (fila !== undefined) {
      const bloqueada = fila.lockedUntil !== null && fila.lockedUntil.getTime() > Date.now();
      if (bloqueada) {
        estado = `BLOQUEADA por intentos fallidos hasta las ${fila.lockedUntil?.toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit' })}`;
      } else if (await verifyPassword(seedUser.password, fila.passwordHash)) {
        estado = 'la contraseña por defecto SIGUE valiendo (pedirá cambiarla al entrar)';
      } else {
        estado = 'la contraseña ya se cambió (usa --reset para volver a la temporal)';
      }
    }

    // eslint-disable-next-line no-console -- credenciales temporales de desarrollo
    console.log(
      `  ${seedUser.username.padEnd(10)} ${seedUser.password.padEnd(26)} roles: ${seedUser.roles.join(', ')}` +
        `\n             ${estado}\n`,
    );
  }

  // eslint-disable-next-line no-console -- script de línea de comandos
  console.log(
    'Las pruebas de humo cambian la del `admin` a `prueba-e2e-odontocrm-2026`.\n' +
      'Restaurar las tres:  npm run seed:users -- --reset\n' +
      'Cambiarlas antes de sembrar:  SEED_PASSWORD_ADMIN, SEED_PASSWORD_RECEPCION, SEED_PASSWORD_EGOMEZ\n' +
      'Detalle completo:  docs/COMANDOS.md §5',
  );
};

const main = async (): Promise<void> => {
  if (soloRecordar) {
    await recordarCredenciales();
    return;
  }

  const created: SeedUser[] = [];
  const updated: SeedUser[] = [];
  const skipped: SeedUser[] = [];

  for (const seedUser of SEED_USERS) {
    const existing = await database.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, seedUser.username))
      .limit(1);

    if (existing.length > 0 && !reset) {
      skipped.push(seedUser);
      continue;
    }

    const passwordHash = await hashPassword(seedUser.password);

    if (existing.length > 0) {
      const id = existing[0]?.id;
      if (id === undefined) continue;
      await database.db
        .update(users)
        .set({ passwordHash, mustChangePassword: true, failedAttempts: 0, lockedUntil: null })
        .where(eq(users.id, id));
      await database.db.delete(userRoles).where(eq(userRoles.userId, id));
      await database.db
        .insert(userRoles)
        .values(seedUser.roles.map((role) => ({ userId: id, role })));
      updated.push(seedUser);
      continue;
    }

    const inserted = await database.db
      .insert(users)
      .values({
        username: seedUser.username,
        fullName: seedUser.fullName,
        email: seedUser.email,
        passwordHash,
        mustChangePassword: true,
      })
      .returning({ id: users.id });

    const id = inserted[0]?.id;
    if (id === undefined) continue;

    await database.db
      .insert(userRoles)
      .values(seedUser.roles.map((role) => ({ userId: id, role })));
    created.push(seedUser);
  }

  const report = (title: string, list: SeedUser[]): void => {
    if (list.length === 0) return;
    // eslint-disable-next-line no-console -- script de línea de comandos
    console.log(`\n${title}`);
    for (const user of list) {
      // eslint-disable-next-line no-console -- credenciales temporales de desarrollo
      console.log(
        `  ${user.username.padEnd(10)} ${user.password.padEnd(26)} roles: ${user.roles.join(', ')}`,
      );
    }
  };

  report('Usuarios creados (contraseña temporal):', created);
  report('Contraseñas regeneradas (--reset):', updated);

  if (skipped.length > 0) {
    // eslint-disable-next-line no-console -- script de línea de comandos
    console.log(
      `\nYa existían (sin cambios): ${skipped.map((user) => user.username).join(', ')}` +
        '\nPara ver sus claves y si siguen valiendo:  npm run seed:users -- --print' +
        '\nPara volver a generarlas:                  npm run seed:users -- --reset',
    );
  }

  // eslint-disable-next-line no-console -- script de línea de comandos
  console.log(
    '\nTodas las contraseñas son temporales: el sistema pedirá cambiarlas en el primer acceso.' +
      (production
        ? ''
        : `\nPara cambiarlas antes de sembrar: ${SEED_USERS.map((u) => u.passwordEnv).join(', ')}.`),
  );
};

main()
  .catch((error: unknown) => {
    // eslint-disable-next-line no-console -- script de línea de comandos
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await database.close();
  });
