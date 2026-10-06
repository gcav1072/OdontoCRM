import { CLINIC } from '@odontocrm/contracts';
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
 *   · **un odontólogo por cada uno de `CLINIC.dentists`** (consultorio, historia
 *     clínica, odontograma, sesiones y récipes). El nombre, el usuario y el MPPS de
 *     esa sección son los del consultorio: es lo que hay que editar para poner el
 *     sistema con otro odontólogo (`packages/contracts/src/clinic.ts`).
 *
 *   npm run build:node
 *   npm run seed:users -w @odontocrm/identity              (idempotente)
 *   npm run seed:users -w @odontocrm/identity -- --reset    (regenera contraseñas)
 *   npm run seed:users -w @odontocrm/identity -- --print    (recuerda las claves, sin tocar nada)
 *   … --usuarios=admin                                      (solo esa cuenta; el servidor
 *                                                            siembra únicamente el admin)
 *
 * Todas las contraseñas nacen como **temporales**: el sistema obliga a cambiarlas
 * en el primer acceso. En producción (`NODE_ENV=production`) hay que indicarlas
 * por variables de entorno; no se admiten los valores por defecto de desarrollo.
 * `--print` es la excepción: no escribe nada, así que funciona sin ellas.
 */
interface SeedUser {
  username: string;
  fullName: string;
  roles: Role[];
  email: string | null;
  /**
   * Contraseña con la que se siembra. En producción sale del entorno; con `--print` y
   * sin ella vale `null` («no se conoce»), porque ese modo no escribe en la base.
   */
  password: string | null;
  /** Variable de entorno que puede sustituir la contraseña por defecto. */
  passwordEnv: string;
}

const DEVELOPMENT_PASSWORDS: Readonly<Record<string, string>> = {
  admin: 'admin-odontocrm-2026',
  recepcion: 'recepcion-odontocrm-2026',
  egomez: 'consultorio-odontocrm-2026',
} as const;

/**
 * Contraseña temporal del resto de los odontólogos que se añadan a `CLINIC.dentists`:
 * la cuenta nace pidiendo el cambio, así que la temporal solo tiene que existir.
 */
const DENTIST_DEFAULT_PASSWORD = 'consultorio-odontocrm-2026';

const reset = process.argv.includes('--reset');
/** `--print`: solo recuerda las credenciales y su estado; no escribe en la base. */
const soloRecordar = process.argv.includes('--print');

/**
 * `--usuarios=admin[,recepcion,…]`: siembra **solo** esas cuentas, y en producción solo
 * exige las claves de esas. Sin la bandera se siembran todas (desarrollo y pruebas).
 *
 * El servidor la usa para crear **únicamente el administrador**: el resto del personal
 * se da de alta desde la aplicación (`/usuarios`, permiso `users:manage`), que es donde
 * tiene sentido decidir roles y datos. Antes la instalación creaba tres cuentas que la
 * clínica no había pedido y había que borrar después.
 */
const parseUsuariosPedidos = (): string[] | null => {
  const arg = process.argv.find((valor) => valor.startsWith('--usuarios='));
  if (arg === undefined) return null;
  return arg
    .slice('--usuarios='.length)
    .split(',')
    .map((nombre) => nombre.trim().toLowerCase())
    .filter((nombre) => nombre !== '');
};

const usuariosPedidos = parseUsuariosPedidos();
if (usuariosPedidos !== null && usuariosPedidos.length === 0) {
  throw new Error('--usuarios= necesita al menos un usuario (ej.: --usuarios=admin)');
}

/** ¿Esta cuenta entra en la siembra? Sin `--usuarios=` entran todas. */
const seleccionado = (username: string): boolean =>
  usuariosPedidos === null || usuariosPedidos.includes(username.toLowerCase());

/**
 * `--ocultar-claves=admin`: no imprime la contraseña de esas cuentas. Lo usa el
 * instalador cuando la eligió una persona: no hay nada que apuntar, y esa clave no tiene
 * por qué acabar en la salida de la instalación (que puede ir a un registro).
 */
const clavesOcultas = ((): string[] => {
  const arg = process.argv.find((valor) => valor.startsWith('--ocultar-claves='));
  if (arg === undefined) return [];
  return arg
    .slice('--ocultar-claves='.length)
    .split(',')
    .map((nombre) => nombre.trim().toLowerCase())
    .filter((nombre) => nombre !== '');
})();

const ocultarClave = (username: string): boolean => clavesOcultas.includes(username.toLowerCase());

const config = loadIdentityConfig();
const production = config.NODE_ENV === 'production';

/**
 * Claves de producción que faltan, según se van resolviendo. No se lanza el error en
 * cuanto aparece la primera: se anotan todas y se avisa **una sola vez**, con la lista
 * completa. Antes salía una por ejecución —con tres cuentas había que repetir el mismo
 * comando tres veces para enterarse de cuáles faltaban— y en el servidor desplegado ese
 * error es lo único que se ve.
 */
const clavesQueFaltan: string[] = [];

const resolvePassword = (username: string): string | null => {
  const envName = `SEED_PASSWORD_${username.toUpperCase()}`;
  const fromEnv = process.env[envName];
  if (fromEnv !== undefined && fromEnv.length >= 10) return fromEnv;
  if (production) {
    // `--print` no escribe en la base: no necesita las claves, solo recordar quién hay
    // (es el comando con el que se comprueba si una cuenta quedó bloqueada). Y una cuenta
    // que no se va a sembrar (`--usuarios=`) tampoco necesita la suya.
    if (!soloRecordar && seleccionado(username)) clavesQueFaltan.push(envName);
    return null;
  }
  return DEVELOPMENT_PASSWORDS[username] ?? DENTIST_DEFAULT_PASSWORD;
};

/** La clave con la que se ESCRIBE. `null` solo puede pasar con `--print`, que no escribe. */
const claveParaSembrar = (usuario: SeedUser): string => {
  if (usuario.password === null) {
    throw new Error(
      `No puedo sembrar «${usuario.username}» sin su clave: define ${usuario.passwordEnv}.`,
    );
  }
  return usuario.password;
};

/**
 * Los odontólogos salen de `CLINIC.dentists` (`packages/contracts/src/clinic.ts`):
 * para poner el sistema con otro odontólogo se edita esa sección —nombre, usuario y
 * MPPS— y `npm run seed:users` crea su cuenta. Añadir uno más a la lista basta.
 */
const DENTIST_USERS: SeedUser[] = CLINIC.dentists.map((dentist) => ({
  username: dentist.username,
  fullName: dentist.fullName,
  roles: ['odontologo'] as Role[],
  email: dentist.email,
  password: resolvePassword(dentist.username),
  passwordEnv: `SEED_PASSWORD_${dentist.username.toUpperCase()}`,
}));

const TODAS_LAS_CUENTAS: SeedUser[] = [
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
  ...DENTIST_USERS,
];

// Un nombre que no existe en la lista es un error de tecleo, no una siembra vacía.
const desconocidos = (usuariosPedidos ?? []).filter(
  (nombre) => !TODAS_LAS_CUENTAS.some((cuenta) => cuenta.username.toLowerCase() === nombre),
);
if (desconocidos.length > 0) {
  throw new Error(
    `No sé sembrar «${desconocidos.join(', ')}». Cuentas disponibles: ` +
      `${TODAS_LAS_CUENTAS.map((cuenta) => cuenta.username).join(', ')}.`,
  );
}

/** Lo que se siembra de verdad: todo, o solo lo que pidió `--usuarios=`. */
const SEED_USERS: SeedUser[] = TODAS_LAS_CUENTAS.filter((cuenta) => seleccionado(cuenta.username));

// Antes de tocar la base: si falta alguna clave de producción, se dice cuáles y con qué
// comando se arregla (mínimo 10 caracteres; la misma sirve para todas, el sistema pedirá
// cambiarla en el primer acceso). Todo lo que necesita el operador está en este mensaje.
if (clavesQueFaltan.length > 0) {
  throw new Error(
    `En producción define ${clavesQueFaltan.join(', ')} (mínimo 10 caracteres) antes de sembrar usuarios.\n` +
      `  sudo ${clavesQueFaltan.map((nombre) => `${nombre}='…'`).join(' ')} \\\n` +
      '    odontocrm con-entorno identity -- node services/identity/dist/seed.js --reset',
  );
}

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
    console.log('(No se pudo consultar la base: se muestran las credenciales sin comprobarlas.)\n');
  }

  for (const seedUser of SEED_USERS) {
    const fila = filas.find((usuario) => usuario.username === seedUser.username);
    // En el servidor el seed se ejecuta con `con-entorno`, no con los guiones de npm:
    // la receta que se imprime aquí es la que de verdad se puede pegar en la terminal.
    const receta = production
      ? 'sudo odontocrm con-entorno identity -- node services/identity/dist/seed.js'
      : 'npm run seed:users';
    let estado = `no existe todavía: créalo con  ${receta}`;

    if (fila !== undefined) {
      const bloqueada = fila.lockedUntil !== null && fila.lockedUntil.getTime() > Date.now();
      if (bloqueada) {
        estado = `BLOQUEADA por intentos fallidos hasta las ${fila.lockedUntil?.toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit' })}`;
      } else if (seedUser.password === null) {
        estado = `no se comprueba aquí: en producción la clave vive en el entorno (pásala en ${seedUser.passwordEnv} para verificarla)`;
      } else if (await verifyPassword(seedUser.password, fila.passwordHash)) {
        estado = 'la contraseña por defecto SIGUE valiendo (pedirá cambiarla al entrar)';
      } else {
        estado = 'la contraseña ya se cambió (usa --reset para volver a la temporal)';
      }
    }

    const claveVisible = ocultarClave(seedUser.username)
      ? '(la que elegiste)'
      : (seedUser.password ?? '(la del entorno)');
    // eslint-disable-next-line no-console -- credenciales temporales de desarrollo
    console.log(
      `  ${seedUser.username.padEnd(10)} ${claveVisible.padEnd(26)} roles: ${seedUser.roles.join(', ')}` +
        `\n             ${estado}\n`,
    );
  }

  if (production) {
    // En el servidor no hay guiones de npm ni pruebas de humo: lo que sirve es la receta
    // del RUNBOOK (que es donde está la lista de claves que hay que pasarle al seed).
    // eslint-disable-next-line no-console -- script de línea de comandos
    console.log('Siembra y cambios de contraseña:  infra/fedora/RUNBOOK.md §5');
  } else {
    // eslint-disable-next-line no-console -- script de línea de comandos
    console.log(
      'Las pruebas de humo cambian la del `admin` a `prueba-e2e-odontocrm-2026`.\n' +
        `Restaurar las ${String(SEED_USERS.length)}:  npm run seed:users -- --reset\n` +
        `Cambiarlas antes de sembrar:  ${SEED_USERS.map((usuario) => usuario.passwordEnv).join(', ')}\n` +
        'Detalle completo:  docs/COMANDOS.md §5',
    );
  }
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

    const passwordHash = await hashPassword(claveParaSembrar(seedUser));

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
      // La clave que eligió una persona no se imprime: ya la conoce, y esta salida
      // puede acabar en el registro de la instalación (ver `--ocultar-claves=`).
      const clave = ocultarClave(user.username) ? '(la que elegiste)' : claveParaSembrar(user);
      // eslint-disable-next-line no-console -- credenciales temporales de desarrollo
      console.log(
        `  ${user.username.padEnd(10)} ${clave.padEnd(26)} roles: ${user.roles.join(', ')}`,
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
