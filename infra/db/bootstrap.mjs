#!/usr/bin/env node
/**
 * Prepara la infraestructura de datos en PostgreSQL:
 *   · crea las 9 bases de datos (una por servicio) y su rol propietario;
 *   · genera contraseñas aleatorias de 32 bytes y las escribe en el `.env` de
 *     cada servicio (archivo ignorado por Git);
 *   · habilita las extensiones necesarias y fija la zona horaria;
 *   · es idempotente: volver a ejecutarlo no rompe nada ni cambia contraseñas.
 *
 * Uso:
 *   npm run db:bootstrap              → crea lo que falte
 *   npm run db:bootstrap -- --rotate  → genera contraseñas nuevas para todos
 *   npm run db:bootstrap -- --only identity
 *
 * Requiere `PG_ADMIN_URL` en el `.env` de la raíz (nunca se imprime).
 * Ver docs/SEGURIDAD_SECRETOS.md.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Client } = pg;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TIMEZONE = 'America/Caracas';

// Los servicios se DESCUBREN del repositorio: una carpeta `services/<x>/` con migraciones.
// Antes era una lista copiada a mano (igual que otras cinco por el instalador) y al entrar
// `billing` se quedaba vieja: este es el bootstrap de DESARROLLO, el que crea las bases y los
// roles de la máquina de trabajo, así que su lista tiene que ser la misma que la del servidor.
const SERVICES = readdirSync(join(ROOT, 'services'), { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(ROOT, 'services', d.name, 'migrations')))
  .map((d) => ({
    name: d.name,
    database: `odonto_${d.name}`,
    role: `odonto_${d.name}`,
    envFile: `services/${d.name}/.env`,
  }))
  .sort((a, b) => a.name.localeCompare(b.name));
if (SERVICES.length === 0) {
  console.error('  ✖ no encuentro servicios en services/ (¿estás en la raíz del repositorio?)');
  process.exit(1);
}

const EVENTS_BROKER = { database: 'odonto_events', role: 'odonto_events' };

const args = process.argv.slice(2);
const rotate = args.includes('--rotate');
const onlyIndex = args.indexOf('--only');
const only = onlyIndex === -1 ? undefined : args[onlyIndex + 1];
const targets = only === undefined ? SERVICES : SERVICES.filter((service) => service.name === only);

if (targets.length === 0) {
  console.error(
    `No existe un servicio llamado "${only ?? ''}". Opciones: ${SERVICES.map((s) => s.name).join(', ')}`,
  );
  process.exit(1);
}

/* ── Utilidades ──────────────────────────────────────────────────────────── */

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const SAFE_PASSWORD = /^[A-Za-z0-9_-]+$/;

const ident = (value) => {
  if (!IDENTIFIER.test(value)) throw new Error(`Identificador SQL inseguro: ${value}`);
  return `"${value}"`;
};

const literal = (value) => {
  if (!SAFE_PASSWORD.test(value))
    throw new Error('La contraseña generada contiene caracteres inesperados');
  return `'${value}'`;
};

const readEnvValue = (path, key) => {
  if (!existsSync(path)) return undefined;
  const match = new RegExp(`^${key}=(.*)$`, 'm').exec(readFileSync(path, 'utf8'));
  return match?.[1]?.trim();
};

const upsertEnvFile = (path, values, opciones = { modo: 0o600 }) => {
  const header =
    '# Generado por `npm run db:bootstrap` — no versionar (ver .gitignore y docs/SEGURIDAD_SECRETOS.md).';
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const seen = new Set();
  const lines = existing.split(/\r?\n/).map((line) => {
    const match = /^([A-Z0-9_]+)\s*=/.exec(line);
    const key = match?.[1];
    if (key === undefined || !(key in values)) return line;
    seen.add(key);
    return `${key}=${values[key]}`;
  });

  for (const [key, value] of Object.entries(values)) {
    if (!seen.has(key)) lines.push(`${key}=${value}`);
  }

  const body = lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${header}\n${body}\n`, { mode: opciones.modo });
};

/* ── Punto de entrada ────────────────────────────────────────────────────── */

const rootEnvFile = resolve(ROOT, '.env');
if (existsSync(rootEnvFile)) process.loadEnvFile(rootEnvFile);

const adminUrl = process.env.PG_ADMIN_URL;
if (!adminUrl) {
  console.error(
    'Falta PG_ADMIN_URL.\n' +
      `Crea el archivo ${rootEnvFile} con una de estas líneas:\n` +
      '  PG_ADMIN_URL=postgres://postgres:TU_PASSWORD@127.0.0.1:5432/postgres\n' +
      '  # o, si el superusuario entra por el socket con autenticación peer (Fedora):\n' +
      '  PG_ADMIN_URL=postgres://TU_USUARIO@/postgres?host=/var/run/postgresql\n' +
      'Ver docs/SEGURIDAD_SECRETOS.md §1.',
  );
  process.exit(1);
}

/**
 * Host y puerto del administrador. **Ojo con la forma de socket**: `new URL` no
 * acepta `postgres://usuario@/base?host=/var/run/postgresql` (autoridad vacía con
 * usuario), que sí entiende PostgreSQL y es el camino de Fedora con autenticación
 * `peer` (`postgresql-setup --initdb`). Se lee el `host` de la consulta y se sigue.
 */
const parseAdminUrl = (url) => {
  try {
    const parsed = new URL(url);
    return { host: parsed.hostname, port: parsed.port };
  } catch {
    const consulta = new URLSearchParams(url.slice(url.indexOf('?') + 1));
    return { host: consulta.get('host') ?? '', port: consulta.get('port') ?? '' };
  }
};

const parsedAdminUrl = parseAdminUrl(adminUrl);

/**
 * Si el administrador entra por el socket, los servicios siguen hablando por
 * **TCP a 127.0.0.1**, que es como están configurados y como exige
 * `PrivateTmp=true` de systemd (INSTALL.md §10.3).
 */
const host = parsedAdminUrl.host === '' ? '127.0.0.1' : parsedAdminUrl.host;
const port = parsedAdminUrl.port === '' ? '5432' : parsedAdminUrl.port;

const buildUrl = (role, password, database) =>
  `postgres://${role}:${password}@${host}:${port}/${database}`;

/** Secreto compartido: lo reutiliza si ya existe para no invalidar sesiones. */
const existingInternalSecret =
  readEnvValue(resolve(ROOT, 'services/identity/.env'), 'INTERNAL_SERVICE_SECRET') ??
  randomBytes(32).toString('base64url');
const existingCookieSecret =
  readEnvValue(resolve(ROOT, 'services/identity/.env'), 'COOKIE_SECRET') ??
  randomBytes(32).toString('base64url');

const admin = new Client({ connectionString: adminUrl, application_name: 'odontocrm-bootstrap' });

const despliegue = [];
const avisos = [];

const run = async () => {
  await admin.connect();
  const { rows: versionRows } = await admin.query('select version() as version');
  console.log(`Conectado: ${String(versionRows[0]?.version ?? '').split(',')[0]}`);

  const summary = [];

  for (const service of targets) {
    const envPath = resolve(ROOT, service.envFile);
    const existingUrl = readEnvValue(envPath, 'DATABASE_URL');

    let password;
    let passwordSource;
    if (rotate || existingUrl === undefined) {
      password = randomBytes(32).toString('base64url');
      passwordSource = rotate ? 'rotada' : 'nueva';
    } else {
      password = decodeURIComponent(new URL(existingUrl).password);
      passwordSource = 'conservada del .env';
    }

    const { rows: roleRows } = await admin.query('select 1 from pg_roles where rolname = $1', [
      service.role,
    ]);
    const roleExists = roleRows.length > 0;

    if (!roleExists) {
      await admin.query(`create role ${ident(service.role)} login password ${literal(password)}`);
    } else {
      // **Siempre** se aplica la contraseña, no solo al rotarla o al crearla. El `.env` es la
      // fuente de verdad y la base tiene que coincidir con él: antes, si se desincronizaban
      // una vez (por ejemplo tras borrar los `.env` de §8.6 y reejecutar el bootstrap), no
      // volvían a converger nunca y el servicio quedaba en bucle con «password
      // authentication failed». Es idempotente: aplicar la misma contraseña no cambia nada.
      await admin.query(`alter role ${ident(service.role)} with password ${literal(password)}`);
    }

    const { rows: dbRows } = await admin.query('select 1 from pg_database where datname = $1', [
      service.database,
    ]);
    if (dbRows.length === 0) {
      await admin.query(`create database ${ident(service.database)} owner ${ident(service.role)}`);
    }

    await admin.query(`alter database ${ident(service.database)} set timezone to '${TIMEZONE}'`);
    await admin.query(`revoke all on database ${ident(service.database)} from public`);
    await admin.query(
      `grant connect, create, temporary on database ${ident(service.database)} to ${ident(service.role)}`,
    );

    // Extensiones: pg_trgm para búsquedas por nombre y pgcrypto para gen_random_uuid().
    const serviceDb = new Client({
      connectionString: buildUrl(service.role, password, service.database),
      application_name: 'odontocrm-bootstrap-extensions',
    });
    await serviceDb.connect();
    try {
      await serviceDb.query('create extension if not exists pgcrypto');
      await serviceDb.query('create extension if not exists pg_trgm');
    } finally {
      await serviceDb.end();
    }

    const values = {
      NODE_ENV: process.env.NODE_ENV ?? 'development',
      LOG_LEVEL: process.env.LOG_LEVEL ?? 'debug',
      TZ: TIMEZONE,
      DATABASE_URL: buildUrl(service.role, password, service.database),
      INTERNAL_SERVICE_SECRET: existingInternalSecret,
      ...(service.name === 'identity' ? { COOKIE_SECRET: existingCookieSecret } : {}),
    };
    upsertEnvFile(envPath, values);

    // ── Y lo mismo en el despliegue, si estamos en el servidor ────────────────
    //
    // El bootstrap es la ÚNICA fuente de verdad de las credenciales, así que cuando corre
    // como root y existe /etc/odontocrm (el servidor, no un PC de desarrollo) escribe ahí
    // **las mismas claves** en lugar de dejar que otro paso las copie. Esto elimina la clase
    // de fallo que nos costó cinco rondas: el bootstrap regeneraba la contraseña, la base
    // quedaba con la nueva y `/etc` seguía con la vieja hasta que alguien la trasladara —y
    // si ese traslado fallaba, los servicios y las migraciones fallaban con «password
    // authentication failed» sin decir por qué.
    const etcDir = process.env.ODONTOCRM_ENV_DIR ?? '/etc/odontocrm';
    const etcFile = resolve(etcDir, `${service.name}.env`);
    if (process.getuid?.() === 0 && existsSync(etcFile)) {
      try {
        upsertEnvFile(etcFile, values, { modo: 0o600 });
        despliegue.push(service.name);
      } catch (error) {
        avisos.push(
          `no pude escribir ${etcFile}: ${error instanceof Error ? error.message : error}`,
        );
      }
    }

    summary.push({
      servicio: service.name,
      base: service.database,
      rol: service.role,
      rolCreado: roleExists ? 'ya existía' : 'creado',
      contrasena: passwordSource,
      archivo: service.envFile,
    });
  }

  /* ── Cola de eventos compartida (pg-boss) ──────────────────────────────────
   * pg-boss guarda sus tablas en UNA base de datos: si cada servicio tuviera su
   * propia cola, un consumidor de otro servicio no podría leerla. Por eso existe
   * `odonto_events`, que es infraestructura (el «broker») y no datos de nadie.
   * Cada servicio conserva su propio `outbox_events` para la garantía
   * transaccional y de allí publica en esta cola.
   */
  const existingBrokerUrl = readEnvValue(resolve(ROOT, SERVICES[0].envFile), 'EVENTS_DATABASE_URL');
  let brokerPassword;
  let brokerPasswordSource;
  if (rotate || existingBrokerUrl === undefined) {
    brokerPassword = randomBytes(32).toString('base64url');
    brokerPasswordSource = rotate ? 'rotada' : 'nueva';
  } else {
    brokerPassword = decodeURIComponent(new URL(existingBrokerUrl).password);
    brokerPasswordSource = 'conservada del .env';
  }

  const { rows: brokerRoleRows } = await admin.query('select 1 from pg_roles where rolname = $1', [
    EVENTS_BROKER.role,
  ]);
  const brokerRoleExists = brokerRoleRows.length > 0;

  if (!brokerRoleExists) {
    await admin.query(
      `create role ${ident(EVENTS_BROKER.role)} login password ${literal(brokerPassword)}`,
    );
  } else if (rotate || existingBrokerUrl === undefined) {
    await admin.query(
      `alter role ${ident(EVENTS_BROKER.role)} with password ${literal(brokerPassword)}`,
    );
  }

  const { rows: brokerDbRows } = await admin.query('select 1 from pg_database where datname = $1', [
    EVENTS_BROKER.database,
  ]);
  if (brokerDbRows.length === 0) {
    await admin.query(
      `create database ${ident(EVENTS_BROKER.database)} owner ${ident(EVENTS_BROKER.role)}`,
    );
  }
  await admin.query(
    `alter database ${ident(EVENTS_BROKER.database)} set timezone to '${TIMEZONE}'`,
  );
  await admin.query(`revoke all on database ${ident(EVENTS_BROKER.database)} from public`);
  await admin.query(
    `grant connect, create, temporary on database ${ident(EVENTS_BROKER.database)} to ${ident(EVENTS_BROKER.role)}`,
  );

  const brokerUrl = buildUrl(EVENTS_BROKER.role, brokerPassword, EVENTS_BROKER.database);

  // La cola es compartida: todos los servicios reciben la misma URL.
  for (const service of SERVICES) {
    upsertEnvFile(resolve(ROOT, service.envFile), { EVENTS_DATABASE_URL: brokerUrl });
  }

  summary.push({
    servicio: '(cola de eventos)',
    base: EVENTS_BROKER.database,
    rol: EVENTS_BROKER.role,
    rolCreado: brokerRoleExists ? 'ya existía' : 'creado',
    contrasena: brokerPasswordSource,
    archivo: 'EVENTS_DATABASE_URL en los .env de los servicios',
  });

  /**
   * El gateway no tiene base de datos, pero sus scripts de desarrollo cargan
   * `apps/gateway/.env` con `--env-file-if-exists` y `node --watch` **falla** si el
   * archivo no existe (medido con Node 22 en Fedora: `ENOENT … watch`). Se crea
   * vacío con su explicación para que `npm run dev` arranque en una máquina recién
   * clonada.
   */
  const gatewayEnv = resolve(ROOT, 'apps/gateway/.env');
  if (!existsSync(gatewayEnv)) {
    writeFileSync(
      gatewayEnv,
      '# Gateway — variables propias (desarrollo).\n' +
        '#\n' +
        '# El gateway no tiene base de datos: este archivo puede quedarse vacío. Existe\n' +
        '# porque los scripts de desarrollo lo cargan con --env-file-if-exists y\n' +
        '# `node --watch` falla si el archivo no está. Aquí puedes sobrescribir\n' +
        '# cualquier variable del .env de la raíz solo para el gateway.\n',
      { mode: 0o600 },
    );
    summary.push({
      servicio: 'gateway',
      base: '—',
      rol: '—',
      rolCreado: '—',
      contrasena: '—',
      archivo: 'apps/gateway/.env (vacío)',
    });
  }

  console.table(summary);
  console.log(
    '\nCredenciales escritas en los .env de cada servicio (ignorados por Git).\n' +
      'La cola de eventos vive en ' +
      EVENTS_BROKER.database +
      ' y todos los servicios la reciben como EVENTS_DATABASE_URL.\n' +
      'Siguiente paso:  npm run build  &&  npm run db:migrate',
  );
};

run()
  .catch((error) => {
    const mensaje = error instanceof Error ? error.message : String(error);
    console.error(`\nEl bootstrap falló: ${mensaje}`);

    // El fallo más común en una máquina recién preparada (socket + `peer`): el usuario
    // del sistema que ejecuta esto no tiene rol en PostgreSQL. Se dice el comando exacto
    // en vez de dejar que se adivine —es el tropiezo número uno al instalar en otra PC—.
    if (/peer authentication|autenticaci[oó]n peer|autentificaci[oó]n peer/i.test(mensaje)) {
      const usuario = process.env['SUDO_USER'] ?? process.env['USER'] ?? 'tu_usuario';
      console.error(
        `\n  Es la autenticación del socket (\`peer\`): el rol «${usuario}» tiene que existir\n` +
          '  porque PostgreSQL compara el usuario del sistema con el rol pedido.\n' +
          '  Se arregla con:\n' +
          `      sudo -u postgres createuser --superuser ${usuario}\n` +
          '  (Lo hace `infra/fedora/instalar-base-fedora.sh`. Ver INSTALL.md §6.4.)',
      );
    }
    process.exitCode = 1;
  })
  .finally(async () => {
    await admin.end().catch(() => undefined);
  });
