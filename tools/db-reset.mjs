#!/usr/bin/env node
/**
 * **Borra absolutamente todo** y deja el sistema recién migrado y con los usuarios
 * sembrados. Es la única forma de dejar la base limpia de verdad: los seeds con
 * `--reset` solo quitan lo ficticio, y la historia clínica, las sesiones y los
 * récipes **no se pueden borrar** por diseño (son documentos inmutables,
 * [ADR 0034](../../docs/adr/0034-sesion-clinica-evolucion.md) y
 * [ADR 0036](../../docs/adr/0036-recipe-emitido-documento-archivado.md)).
 *
 * ```
 * npm run db:reset                 # explica lo que haría; NO toca nada
 * npm run db:reset -- --yes        # borra todo y deja el sistema listo
 * npm run db:reset -- --yes --solo-bases     # conserva storage/ (adjuntos y PDFs)
 * npm run db:reset -- --yes --sin-sembrar    # sin usuarios sembrados
 * ```
 *
 * Qué borra:
 *   1. Las **9 bases** `odonto_*` (los 8 servicios + la cola de eventos `pg-boss`),
 *      con `drop database … with (force)`.
 *   2. El contenido de **`storage/`**: adjuntos de las fichas, adjuntos de las
 *      sesiones y los PDF de los récipes (los archivos, no la carpeta).
 *
 * Qué **no** toca: los roles de PostgreSQL, los `.env` (credenciales y secretos),
 * las claves del JWT (`.keys/`) ni la configuración. Al volver a arrancar hay que
 * **iniciar sesión de nuevo**: las sesiones y los refrescos viven en la base.
 *
 * Es una herramienta **de consola y solo de consola**: ningún servicio, ruta, botón
 * ni script de la aplicación la llama, y sin `--yes` no borra nada. Se niega a
 * correr con la pila en marcha (los servicios caerían en bucle contra una base que
 * ya no existe) y en `NODE_ENV=production` (eso no es un entorno de pruebas).
 *
 * Ver docs/COMANDOS.md §5.
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import pg from 'pg';

import { PUERTOS, retratoDeLaPila } from './lib/stack.mjs';
import {
  bloqueoVigente,
  escribirBloqueo,
  limpiarBloqueo,
  RUTA_BLOQUEO,
} from './lib/mantenimiento.mjs';

const { Client } = pg;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STORAGE = resolve(ROOT, 'storage');

/**
 * Las bases del proyecto, en el orden en que se crean. Es una **lista cerrada** a
 * propósito: el borrado nunca construye nombres desde argumentos del usuario, así
 * que no hay forma de que se lleve por delante otra base de la instancia.
 */
const BASES = [
  'odonto_identity',
  'odonto_patients',
  'odonto_scheduling',
  'odonto_notifications',
  'odonto_clinical',
  'odonto_odontogram',
  'odonto_screens',
  'odonto_reporting',
  'odonto_events',
];

const args = process.argv.slice(2);
const confirmado = args.includes('--yes');
const soloBases = args.includes('--solo-bases');
const sinSembrar = args.includes('--sin-sembrar');
/** Permite apuntar a una base que no está en esta máquina (por defecto, se niega). */
const permitirRemoto = args.includes('--remoto');

const linea = (texto = '') => console.log(texto);

/* ── 1. Confirmación explícita ─────────────────────────────────────────────── */

if (!confirmado) {
  linea('db:reset — borra TODO y deja el sistema recién migrado (no ha tocado nada).');
  linea();
  linea('  Se borran:');
  linea(`    · las ${String(BASES.length)} bases odonto_* (datos, auditoría, cola de eventos)`);
  linea(
    `    · el contenido de storage/ (adjuntos y PDF de récipes)${soloBases ? ' — OMITIDO con --solo-bases' : ''}`,
  );
  linea();
  linea('  Se conservan: los roles y credenciales de PostgreSQL (.env), las claves del JWT');
  linea('  (.keys/) y la configuración. Habrá que volver a iniciar sesión.');
  linea();
  linea('  Para hacerlo de verdad:');
  linea('    npm run db:reset -- --yes');
  linea('    npm run db:reset -- --yes --solo-bases     (conserva los archivos)');
  linea('    npm run db:reset -- --yes --sin-sembrar    (SIN usuarios: hay que sembrarlos luego)');
  process.exit(1);
}

/* ── 2. Ya hay un reset en curso (o quedó a medias) ────────────────────────── */

const bloqueo = bloqueoVigente();

if (bloqueo !== null && bloqueo.vivo) {
  console.error(
    `db:reset: ya hay una operación de mantenimiento en curso (${bloqueo.tarea}, PID ${String(bloqueo.pid)}).\n` +
      '  Se niega a trabajar encima: dos resets a la vez dejarían las bases a medias.\n' +
      '  · Si es de otra terminal: espérala.\n' +
      `  · Si ese proceso ya no existe, borra el bloqueo y vuelve a intentarlo:\n` +
      `      Remove-Item "${RUTA_BLOQUEO}"`,
  );
  process.exit(1);
}

if (bloqueo !== null) {
  linea(
    `db:reset: había un bloqueo caducado (${bloqueo.tarea}, PID ${String(bloqueo.pid)} ya no existe); se ignora.`,
  );
  limpiarBloqueo();
}

/* ── 2. Fuera de un entorno de pruebas no se toca nada ─────────────────────── */

const rootEnv = resolve(ROOT, '.env');
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

if (process.env['NODE_ENV'] === 'production') {
  console.error(
    'db:reset: NODE_ENV=production. Este comando es de desarrollo y pruebas: no se\n' +
      'ejecuta contra la base de la clínica. Si de verdad hay que reinstalar desde cero\n' +
      'en el servidor, usa el runbook de la Fase 10 (infra/fedora/).',
  );
  process.exit(1);
}

const adminUrl = process.env['PG_ADMIN_URL'];
if (adminUrl === undefined || adminUrl === '') {
  console.error(
    'db:reset: falta PG_ADMIN_URL en el .env de la raíz.\n' +
      '  PG_ADMIN_URL=postgres://postgres:TU_PASSWORD@127.0.0.1:5432/postgres\n' +
      'Ver docs/SEGURIDAD_SECRETOS.md §1.',
  );
  process.exit(1);
}

/**
 * Solo contra una base **de esta máquina**. Borrar por accidente la base de un
 * servidor remoto (una URL copiada en el `.env`, un túnel de por medio) no tiene
 * vuelta atrás; si de verdad es lo que se quiere, hay que decirlo con `--remoto`.
 */
const HOSTS_LOCALES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const hostAdmin = (() => {
  try {
    return new URL(adminUrl).hostname;
  } catch {
    return '';
  }
})();

if (!HOSTS_LOCALES.has(hostAdmin) && !permitirRemoto) {
  console.error(
    `db:reset: PG_ADMIN_URL no apunta a esta máquina (host «${hostAdmin}»).\n` +
      '  Este comando borra bases enteras: contra un servidor remoto no se ejecuta por\n' +
      '  descuido. Si es de verdad lo que quieres (una máquina de pruebas aparte), añade\n' +
      '  `--remoto` y vuelve a intentarlo.',
  );
  process.exit(1);
}

/* ── 3. La pila tiene que estar parada ─────────────────────────────────────── */

const retrato = await retratoDeLaPila();
if (retrato.ocupados.length > 0) {
  const nombres = retrato.ocupados
    .map((entrada) => `${String(entrada.puerto)} (${entrada.nombre})`)
    .join(', ');
  console.error(
    `db:reset: hay una pila corriendo y no se puede borrar la base debajo de sus pies.\n` +
      `  Puertos ocupados: ${nombres}\n\n` +
      '  Párala primero:   npm run stack:down\n' +
      '  Y después:        npm run db:reset -- --yes\n\n' +
      `  (Los puertos que vigila el proyecto son ${PUERTOS.map((p) => String(p.puerto)).join(', ')}.)`,
  );
  process.exit(1);
}

/* ── 4. Borrado de las bases ───────────────────────────────────────────────── */

const admin = new Client({ connectionString: adminUrl, application_name: 'odontocrm-db-reset' });

/**
 * Un paso del ciclo, con la salida del comando a la vista. Se lanza como **una sola
 * cadena** (`npm run <script>`) y no como programa + argumentos: con `shell: true` y
 * un array, Node avisa (DEP0190) de que los argumentos no se escapan.
 *
 * Lanza en vez de llamar a `process.exit`: así el `finally` que quita el bloqueo de
 * mantenimiento se ejecuta siempre y no queda un candado pegado.
 */
class PasoFallido extends Error {}

const correrNpm = (script) => {
  linea(`\n── npm run ${script} ${'─'.repeat(Math.max(0, 50 - script.length))}`);
  const resultado = spawnSync(`npm run ${script}`, { stdio: 'inherit', cwd: ROOT, shell: true });
  if (resultado.status !== 0) {
    throw new PasoFallido(`"${script}" falló (código ${String(resultado.status)}).`);
  }
};

/**
 * A partir de aquí se borra de verdad: se deja el **bloqueo de mantenimiento** para
 * que nadie arranque la pila a medias (la puerta `dev:check` y `stack:*` lo miran).
 */
escribirBloqueo('db:reset');

linea('\n── Bloqueo de mantenimiento activo ────────────────────────────');
linea(`  · ${RUTA_BLOQUEO}`);
linea('  · no arranques la pila hasta que termine (npm run dev y stack:* lo detectan)');

try {
  try {
    await admin.connect();
    linea('\n── Borrando las bases ─────────────────────────────────────────');

    for (const base of BASES) {
      const { rows } = await admin.query('select 1 from pg_database where datname = $1', [base]);
      if (rows.length === 0) {
        linea(`  · ${base.padEnd(22)} no existía`);
        continue;
      }

      // `with (force)` cierra las conexiones que queden (pgAdmin, una terminal suelta):
      // si no, `drop database` falla con «is being accessed by other users».
      await admin.query(`drop database if exists "${base}" with (force)`);
      linea(`  · ${base.padEnd(22)} borrada`);
    }
  } finally {
    await admin.end().catch(() => undefined);
  }

  /* ── 5. Borrado de los archivos del almacén ──────────────────────────────── */

  if (soloBases) {
    linea('\n── storage/ conservado (--solo-bases) ─────────────────────────');
  } else if (!existsSync(STORAGE)) {
    linea('\n── storage/ no existía ────────────────────────────────────────');
  } else {
    /**
     * Antes de borrar nada se comprueba **qué** se va a borrar: la ruta resuelta tiene
     * que ser exactamente `<raíz del repo>/storage`. Un `rm -rf` sobre una ruta
     * calculada que no se ha comprobado es justo el accidente que hay que evitar.
     */
    const dentroDelRepo = STORAGE === join(ROOT, 'storage') && dirname(STORAGE) === ROOT;
    if (!dentroDelRepo) {
      throw new Error(`la ruta del almacén no es la esperada (${STORAGE}); no se borra nada`);
    }

    const medir = (ruta) => {
      let archivos = 0;
      let bytes = 0;
      for (const entrada of readdirSync(ruta, { withFileTypes: true })) {
        const camino = join(ruta, entrada.name);
        if (entrada.isDirectory()) {
          const dentro = medir(camino);
          archivos += dentro.archivos;
          bytes += dentro.bytes;
        } else {
          archivos += 1;
          bytes += statSync(camino).size;
        }
      }
      return { archivos, bytes };
    };

    const { archivos, bytes } = medir(STORAGE);
    for (const entrada of readdirSync(STORAGE, { withFileTypes: true })) {
      rmSync(join(STORAGE, entrada.name), { recursive: true, force: true });
    }
    linea('\n── Borrando los archivos del almacén ──────────────────────────');
    linea(
      `  · storage/             ${String(archivos)} archivo(s), ${(bytes / 1024).toFixed(0)} kB liberados`,
    );
    linea('  · la carpeta storage/ se conserva (los servicios la crean si falta)');
  }

  /* ── 6. Reconstrucción: compilar, crear, migrar y sembrar ────────────────── */

  linea('\n── Reconstruyendo ─────────────────────────────────────────────');
  correrNpm('build:node');
  correrNpm('db:bootstrap');
  correrNpm('db:migrate');
  if (sinSembrar) {
    linea('\n── Usuarios: NO se siembran (--sin-sembrar) ───────────────────');
    linea('  ⚠ La base queda SIN usuarios: la interfaz no se puede usar y no hay con qué');
    linea('    entrar hasta que los siembres:   npm run seed:users');
  } else {
    correrNpm('seed:users');
  }
} catch (error) {
  console.error(
    `\ndb:reset: ${error instanceof Error ? error.message : String(error)}\n` +
      '  Las bases pueden haber quedado a medias: vuelve a ejecutar el comando cuando\n' +
      '  resuelvas el problema (es idempotente: borra y crea lo que haga falta).',
  );
  process.exitCode = 1;
} finally {
  limpiarBloqueo();
}

if (process.exitCode === 1) process.exit(1);

linea('\n── Bloqueo de mantenimiento liberado ──────────────────────────');
linea('\n── Listo ──────────────────────────────────────────────────────');
if (sinSembrar) {
  linea('  Base limpia y migrada, pero SIN usuarios: ejecuta `npm run seed:users` antes de');
  linea('  entrar a la interfaz.');
} else {
  linea('  La base está limpia, migrada y con los usuarios sembrados (contraseñas');
  linea('  temporales: el sistema pedirá cambiarlas al entrar).');
}
linea();
linea('  Arranca la pila:  npm run stack:fijo   (PM2, sin recarga)');
linea('                    npm run stack:dev    (todo con recarga)');
linea('  Comprueba antes:  npm run stack:status');
