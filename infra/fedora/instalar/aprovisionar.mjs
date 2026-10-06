#!/usr/bin/env node
/**
 * OdontoCRM · aprovisionar el servidor (ADR 0043)
 *
 * **Este es el ÚNICO sitio del despliegue que escribe credenciales.** Genera los
 * secretos una vez, los deja en `/etc/odontocrm/*.env`, crea en PostgreSQL los
 * roles y las bases con **esas mismas** contraseñas y, al final, comprueba cada
 * credencial **conectándose de verdad**.
 *
 * Por qué existe (y por qué no se reutiliza el bootstrap de desarrollo): el modelo
 * anterior tenía los secretos en dos sitios —los `.env` del repositorio y
 * `/etc/odontocrm`— y un paso los copiaba de uno a otro. Cuando esa copia fallaba,
 * la base y los archivos decían cosas distintas y el síntoma aparecía lejos de la
 * causa (`password authentication failed` a mitad del despliegue, cinco veces).
 * Aquí hay **una sola copia** desde el primer momento: la del servidor.
 *
 * Lo que NO hace, a propósito: no escribe nada dentro del código desplegado
 * (`/opt/odontocrm`), que puede borrarse y volver a clonarse sin perder nada.
 *
 * Uso:
 *   node infra/fedora/instalar/aprovisionar.mjs --host=odontocrm.local --ip=192.168.1.50
 *   node infra/fedora/instalar/aprovisionar.mjs --env-dir=/tmp/prueba --dry-run
 *   node infra/fedora/instalar/aprovisionar.mjs --rotate     # contraseñas nuevas
 *
 * Administrador de PostgreSQL: `--admin-url=…` o `PG_ADMIN_URL`; si no, se usa el
 * socket como usuario del sistema `postgres` (runuser), que es lo que funciona en
 * Fedora recién instalado sin escribir ninguna contraseña de administrador.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, chownSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';

/* ── Los 8 servicios con base propia, en orden ─────────────────────────────── */
const SERVICIOS = [
  { nombre: 'identity', puerto: 4001, base: 'odonto_identity' },
  { nombre: 'patients', puerto: 4002, base: 'odonto_patients' },
  { nombre: 'scheduling', puerto: 4003, base: 'odonto_scheduling' },
  { nombre: 'notifications', puerto: 4004, base: 'odonto_notifications' },
  { nombre: 'clinical', puerto: 4005, base: 'odonto_clinical' },
  { nombre: 'odontogram', puerto: 4006, base: 'odonto_odontogram' },
  { nombre: 'screens', puerto: 4007, base: 'odonto_screens' },
  { nombre: 'reporting', puerto: 4008, base: 'odonto_reporting' },
  { nombre: 'billing', puerto: 4009, base: 'odonto_billing' },
];

/** La cola de eventos (pg-boss) es UNA base compartida: todos los servicios la leen igual. */
const COLA = { base: 'odonto_events', rol: 'odonto_events' };

/** El gateway escucha aquí; `odontocrm-gateway.service` y el proxy cuentan con ello. */
const PUERTO_GATEWAY = 8090;

const SERVICIOS_TODOS = [...SERVICIOS.map((s) => s.nombre), 'gateway'];

/* ── Opciones ──────────────────────────────────────────────────────────────── */
const opciones = {
  envDir: '/etc/odontocrm',
  host: 'odontocrm.local',
  ip: '',
  tz: 'America/Caracas',
  dataDir: '/var/lib/odontocrm',
  adminUrl: process.env.PG_ADMIN_URL ?? '',
  rotate: false,
  dryRun: false,
  soloArchivos: false,
  soloBases: false,
  soloVerificar: false,
  espera: 10,
};

for (const arg of process.argv.slice(2)) {
  const [clave, ...resto] = arg.split('=');
  const valor = resto.join('=');
  switch (clave) {
    case '--env-dir': opciones.envDir = valor; break;
    case '--host': opciones.host = valor; break;
    case '--ip': opciones.ip = valor; break;
    case '--tz': opciones.tz = valor; break;
    case '--data-dir': opciones.dataDir = valor; break;
    case '--admin-url': opciones.adminUrl = valor; break;
    case '--rotate': opciones.rotate = true; break;
    case '--dry-run': opciones.dryRun = true; break;
    case '--solo-archivos': opciones.soloArchivos = true; break;
    case '--solo-bases': opciones.soloBases = true; break;
    case '--solo-verificar': opciones.soloVerificar = true; break;
    case '-h':
    case '--help':
      console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 30).map((l) => l.replace(/^ \* ?/, '')).join('\n'));
      process.exit(0);
      break;
    default:
      console.error(`opción no reconocida: ${arg}`);
      process.exit(2);
  }
}

const ETC = resolve(opciones.envDir);
const SQLITE = /^[A-Za-z0-9_-]+$/; // las contraseñas que generamos son base64url

// `--solo-verificar` no crea nada: se limita a comprobar lo que hay. Si falta un
// archivo, se dice cuál en vez de inventarse una contraseña y fallar «por conexión».
if (opciones.soloVerificar) {
  const faltan = ['odontocrm.env', 'gateway.env', ...SERVICIOS.map((s) => `${s.nombre}.env`)].filter(
    (archivo) => !existsSync(join(ETC, archivo)),
  );
  if (faltan.length > 0) {
    console.error(
      `No encuentro el entorno aprovisionado en ${ETC}.\n` +
        `  Faltan: ${faltan.join(', ')}\n` +
        '  Ejecuta primero:  sudo bash infra/fedora/instalar/20-aprovisionar.sh',
    );
    process.exit(1);
  }
}

/* ── Salida ────────────────────────────────────────────────────────────────── */
const tty = process.stdout.isTTY;
const c = {
  ok: tty ? '\u001b[32m✔\u001b[0m' : '✔',
  av: tty ? '\u001b[33m!\u001b[0m' : '!',
  er: tty ? '\u001b[31m✖\u001b[0m' : '✖',
  ti: tty ? '\u001b[1m' : '',
  dim: tty ? '\u001b[2m' : '',
  re: tty ? '\u001b[0m' : '',
};
const ok = (m) => console.log(`  ${c.ok} ${m}`);
const av = (m) => console.log(`  ${c.av} ${m}`);
const err = (m) => console.error(`  ${c.er} ${m}`);
const paso = (m) => console.log(`\n${c.ti}== ${m} ==${c.re}`);
const detalle = (m) => console.log(`      ${c.dim}${m}${c.re}`);
const morir = (m) => {
  console.error(`\n${c.er} ${m}`);
  process.exit(1);
};

/* ── Lectura y escritura de archivos de entorno ────────────────────────────── */

/** Lee `CLAVE=VALOR` sin interpretar nada (ni comillas de shell ni `$`). */
const leerEnv = (ruta) => {
  if (!existsSync(ruta)) return {};
  const valores = {};
  for (const linea of readFileSync(ruta, 'utf8').split('\n')) {
    const limpia = linea.trim();
    if (limpia === '' || limpia.startsWith('#')) continue;
    const corte = limpia.indexOf('=');
    if (corte <= 0) continue;
    const clave = limpia.slice(0, corte).trim();
    let valor = limpia.slice(corte + 1).trim();
    if (
      (valor.startsWith('"') && valor.endsWith('"')) ||
      (valor.startsWith("'") && valor.endsWith("'"))
    ) {
      valor = valor.slice(1, -1);
    }
    valores[clave] = valor;
  }
  return valores;
};

/**
 * Escribe un archivo de entorno: las claves gestionadas se reescriben y **las que
 * puso una persona a mano se conservan**. Reescribirlo entero sin mirar borraría,
 * por ejemplo, el token del bot que alguien acaba de configurar.
 *
 * Reglas aprendidas de fallos reales de este mismo instalador:
 *
 * 1. Si el valor que íbamos a escribir es **vacío** y ya había uno, se respeta el que
 *    había: el instalador no crea el token de BotFather, solo deja el hueco, y
 *    borrarlo en cada corrida sería perder el trabajo de quien lo configuró.
 * 2. Un valor `null` significa **«esta clave no se escribe»**, y se deja comentada como
 *    recordatorio. No es lo mismo `CLAVE=` que no ponerla: en el esquema del servicio
 *    `TELEGRAM_BOT_USERNAME` es `.min(1).optional()`, así que una cadena vacía NO es
 *    «ausente» y hace fallar la configuración entera —el servicio no arranca y ni
 *    siquiera corren sus migraciones—. Se descubrió migrando de verdad.
 */
const escribirEnv = (ruta, gestionadas, comentarios = {}) => {
  const previas = leerEnv(ruta);
  const ajenas = Object.entries(previas).filter(([clave]) => !(clave in gestionadas));

  const definitivas = { ...gestionadas };
  const conservadas = [];
  const omitidas = [];
  for (const [clave, valor] of Object.entries(definitivas)) {
    const previo = (previas[clave] ?? '').trim();
    // Sin valor que poner (nulo) o valor vacío: manda lo que ya hubiera.
    if (valor === null || valor === '') {
      if (previo !== '') {
        definitivas[clave] = previo;
        conservadas.push(clave);
      } else {
        // No se escribe `CLAVE=` (que no es lo mismo que no ponerla): queda comentada.
        delete definitivas[clave];
        omitidas.push(clave);
      }
      continue;
    }
  }

  const lineas = [
    '# ─────────────────────────────────────────────────────────────────────────────',
    '# OdontoCRM · lo escribe `infra/fedora/instalar/20-aprovisionar.sh`.',
    '# No lo edite a mano salvo para añadir claves: el instalador las conserva,',
    '# pero las de abajo las vuelve a calcular cada vez que se ejecuta.',
    '# Permisos 0600 root:root — systemd los lee como root (EnvironmentFile=).',
    '# Este archivo NUNCA se copia al repositorio ni se comparte por chat.',
    '# ─────────────────────────────────────────────────────────────────────────────',
    '',
  ];

  for (const [clave, valor] of Object.entries(definitivas)) {
    if (comentarios[clave]) lineas.push(`# ${comentarios[clave]}`);
    lineas.push(`${clave}=${valor}`);
  }

  if (omitidas.length > 0) {
    // Se dejan COMENTADAS, no vacías: `CLAVE=` no es lo mismo que no ponerla (hay
    // esquemas donde una cadena vacía es inválida y el servicio no arranca).
    lineas.push('', '# ── Sin configurar (descomenta y pon el valor si hace falta) ─────────────────');
    for (const clave of omitidas) {
      if (comentarios[clave]) lineas.push(`# ${comentarios[clave]}`);
      lineas.push(`# ${clave}=`);
    }
  }

  if (conservadas.length > 0) {
    detalle(`conservado el valor que ya había en ${ruta.split('/').pop()}: ${conservadas.join(', ')}`);
  }

  if (ajenas.length > 0) {
    lineas.push('', '# ── Añadido a mano (el instalador NO lo toca) ────────────────────────────────');
    for (const [clave, valor] of ajenas) lineas.push(`${clave}=${valor}`);
  }

  if (opciones.dryRun) {
    detalle(`[dry-run] escribiría ${ruta} (${Object.keys(definitivas).length} claves)`);
    return;
  }
  mkdirSync(dirname(ruta), { recursive: true });
  writeFileSync(ruta, `${lineas.join('\n')}\n`, { mode: 0o600 });
};

/* ── Secretos: se leen los que ya hay, se generan solo los que faltan ──────── */

/** Una contraseña de 32 bytes en base64url: sin `@ : / ?` que rompan una URL. */
const nuevaClave = () => randomBytes(32).toString('base64url');

const contrasenaDeUrl = (url) => {
  if (!url) return undefined;
  try {
    const clave = decodeURIComponent(new URL(url).password);
    return clave.length > 0 ? clave : undefined;
  } catch {
    return undefined;
  }
};

const existentes = {};
for (const servicio of SERVICIOS) {
  const valores = leerEnv(join(ETC, `${servicio.nombre}.env`));
  existentes[servicio.nombre] = {
    clave: contrasenaDeUrl(valores.DATABASE_URL),
    archivo: join(ETC, `${servicio.nombre}.env`),
  };
}
const envIdentity = leerEnv(join(ETC, 'identity.env'));
const claveCola = contrasenaDeUrl(envIdentity.EVENTS_DATABASE_URL) ?? contrasenaDeUrl(
  leerEnv(join(ETC, 'patients.env')).EVENTS_DATABASE_URL,
);

const secretoInterno = opciones.rotate
  ? undefined
  : envIdentity.INTERNAL_SERVICE_SECRET || undefined;
const secretoCookie = opciones.rotate ? undefined : envIdentity.COOKIE_SECRET || undefined;

const claves = {
  servicios: {},
  cola: opciones.rotate ? undefined : claveCola,
  interno: secretoInterno,
  cookie: secretoCookie,
};

let generadas = 0;
const reutilizadas = [];
for (const servicio of SERVICIOS) {
  const previa = opciones.rotate ? undefined : existentes[servicio.nombre].clave;
  claves.servicios[servicio.nombre] = previa ?? nuevaClave();
  if (previa) reutilizadas.push(servicio.nombre);
  else generadas += 1;
}
if (!claves.cola) {
  claves.cola = nuevaClave();
  generadas += 1;
} else {
  reutilizadas.push('cola de eventos');
}
if (!claves.interno) {
  claves.interno = nuevaClave();
  generadas += 1;
}
if (!claves.cookie) {
  claves.cookie = nuevaClave();
  generadas += 1;
}

for (const servicio of SERVICIOS) {
  if (!SQLITE.test(claves.servicios[servicio.nombre])) morir('contraseña generada no segura');
}

/* ── Cuerpo de los archivos ─────────────────────────────────────────────────── */

const urlDe = (rol, clave, base) => `postgres://${rol}:${clave}@127.0.0.1:5432/${base}`;
const urlCola = urlDe(COLA.rol, claves.cola, COLA.base);
const origenes = [`https://${opciones.host}`, ...(opciones.ip ? [`https://${opciones.ip}`] : [])];

/** Lo COMÚN a los 9 (equivale al `.env` de la raíz en desarrollo). */
const envComun = () => {
  const valores = {
    NODE_ENV: 'production',
    LOG_LEVEL: 'info',
    LOG_PRETTY: 'false',
    TZ: opciones.tz,
    SERVICE_VERSION: '0.1.0',
    TEST_MODE: 'false',
    ALLOW_TEST_MODE: 'false',
    GATEWAY_HOST: '127.0.0.1',
    GATEWAY_PORT: String(PUERTO_GATEWAY),
    // El nombre se guarda aquí para que las actualizaciones no lo pierdan: el
    // despliegue lo lee de este archivo cuando no se le pasa --nombre-mdns.
    ODONTOCRM_NOMBRE: opciones.host,
  };
  for (const servicio of SERVICIOS) {
    const alto = servicio.nombre.toUpperCase();
    valores[`${alto}_HOST`] = '127.0.0.1';
    valores[`${alto}_PORT`] = String(servicio.puerto);
  }
  for (const servicio of SERVICIOS) {
    valores[`${servicio.nombre.toUpperCase()}_URL`] = `http://127.0.0.1:${servicio.puerto}`;
  }
  valores.WEB_ORIGIN = origenes.join(', ');
  return valores;
};

/** Las claves propias de cada servicio, además de las comunes a todos. */
const extrasDe = (nombre) => {
  switch (nombre) {
    case 'identity':
      return {
        COOKIE_SECRET: claves.cookie,
        COOKIE_SECURE: 'true',
        JWT_PRIVATE_KEY_PATH: `${ETC}/keys/jwt-private.pem`,
        JWT_PUBLIC_KEY_PATH: `${ETC}/keys/jwt-public.pem`,
      };
    case 'patients':
      return { STORAGE_DIR: `${opciones.dataDir}/storage`, MAX_FILE_BYTES: '20971520' };
    case 'clinical':
      return {
        STORAGE_DIR: `${opciones.dataDir}/storage`,
        MAX_FILE_BYTES: '20971520',
        PLAYWRIGHT_BROWSERS_PATH: `${opciones.dataDir}/ms-playwright`,
        PUBLIC_APP_URL: `https://${opciones.host}`,
      };
    case 'reporting':
      return { PLAYWRIGHT_BROWSERS_PATH: `${opciones.dataDir}/ms-playwright` };
    case 'billing':
      // La factura y el recibo se componen con Chromium: la misma ruta que clinical
      // y reporting. El plan lo avisa (§7.5, punto 16).
      return { PLAYWRIGHT_BROWSERS_PATH: `${opciones.dataDir}/ms-playwright` };
    case 'notifications':
      // Sin token, `TELEGRAM_MODE=auto` usa el bot simulado: la clínica arranca y los
      // avisos quedan como pendientes manuales hasta que haya BotFather. Las otras dos
      // van con `null` (no se escriben, quedan comentadas): en el esquema del servicio
      // son `.optional()` con mínimo, así que una cadena VACÍA es inválida y el
      // servicio no arrancaría. Se descubrió migrando de verdad.
      return { TELEGRAM_MODE: 'auto', TELEGRAM_BOT_TOKEN: null, TELEGRAM_BOT_USERNAME: null };
    default:
      return {};
  }
};

const comentarioDe = (clave) =>
  ({
    DATABASE_URL: 'Base propia del servicio (rol dedicado, sin superusuario).',
    EVENTS_DATABASE_URL: 'Cola compartida (pg-boss): la MISMA en los 9 servicios.',
    INTERNAL_SERVICE_SECRET: 'Secreto de las rutas internas: el MISMO en los 9 servicios.',
    COOKIE_SECRET: 'Firma la cookie de refresco de la sesión.',
    JWT_PRIVATE_KEY_PATH: 'Clave EdDSA que firma los JWT (clave privada, 0640 root:odontocrm).',
    JWT_PUBLIC_KEY_PATH: 'Clave pública con la que el gateway valida los JWT.',
    WEB_ORIGIN: 'Orígenes que el navegador puede usar (CORS). El nombre y la IP de la LAN.',
    PUBLIC_APP_URL: 'La usa el QR del récipe: tiene que ser la dirección por la que entra la clínica.',
    TELEGRAM_BOT_TOKEN: 'Token de BotFather. Sin él los avisos salen en modo simulado.',
    TELEGRAM_BOT_USERNAME: 'Usuario del bot, sin @ (para el enlace t.me/<usuario>).',
  })[clave];

const escribirArchivos = () => {
  paso('1/3 · /etc/odontocrm: los archivos que leen los servicios');

  if (!opciones.dryRun) mkdirSync(ETC, { recursive: true, mode: 0o750 });

  escribirEnv(join(ETC, 'odontocrm.env'), envComun(), {
    WEB_ORIGIN: comentarioDe('WEB_ORIGIN'),
  });
  ok(`odontocrm.env  (común a los 9: puertos, URLs, WEB_ORIGIN=${origenes.join(', ')})`);

  for (const servicio of SERVICIOS) {
    const gestionadas = {
      DATABASE_URL: urlDe(servicio.base, claves.servicios[servicio.nombre], servicio.base),
      EVENTS_DATABASE_URL: urlCola,
      DATABASE_POOL_MAX: '10',
      ...extrasDe(servicio.nombre),
      INTERNAL_SERVICE_SECRET: claves.interno,
    };
    escribirEnv(join(ETC, `${servicio.nombre}.env`), gestionadas, {
      DATABASE_URL: comentarioDe('DATABASE_URL'),
      EVENTS_DATABASE_URL: comentarioDe('EVENTS_DATABASE_URL'),
      INTERNAL_SERVICE_SECRET: comentarioDe('INTERNAL_SERVICE_SECRET'),
      COOKIE_SECRET: comentarioDe('COOKIE_SECRET'),
      JWT_PRIVATE_KEY_PATH: comentarioDe('JWT_PRIVATE_KEY_PATH'),
      JWT_PUBLIC_KEY_PATH: comentarioDe('JWT_PUBLIC_KEY_PATH'),
    });
    ok(`${servicio.nombre}.env`.padEnd(20) + `→ ${servicio.base}`);
  }

  escribirEnv(
    join(ETC, 'gateway.env'),
    {
      INTERNAL_SERVICE_SECRET: claves.interno,
      JWT_PUBLIC_KEY_PATH: `${ETC}/keys/jwt-public.pem`,
    },
    {
      INTERNAL_SERVICE_SECRET: comentarioDe('INTERNAL_SERVICE_SECRET'),
      JWT_PUBLIC_KEY_PATH: comentarioDe('JWT_PUBLIC_KEY_PATH'),
    },
  );
  ok('gateway.env        → sin base de datos: solo el secreto interno y la clave pública');

  if (opciones.dryRun) {
    detalle('(dry-run: no se escribió nada)');
    return;
  }

  // Permisos: los lee systemd COMO ROOT y se los pasa al proceso, así que 0600
  // root:root es lo correcto y el servicio no necesita poder leerlos.
  for (const archivo of ['odontocrm.env', 'gateway.env', ...SERVICIOS.map((s) => `${s.nombre}.env`)]) {
    const ruta = join(ETC, archivo);
    if (existsSync(ruta)) {
      chmodSync(ruta, 0o600);
      try {
        chownSync(ruta, 0, 0);
      } catch {
        /* sin root no se puede; en la prueba local no importa */
      }
    }
  }
  ok('permisos 0600 root:root en los 10 archivos');
};

/* ── SQL: los roles y las bases, con las contraseñas de arriba ─────────────── */

/**
 * Literal de SQL para las contraseñas: se exige el alfabeto base64url, así que no
 * puede contener una comilla que rompa la sentencia. Es una comprobación, no una
 * limpieza: si algún día el generador cambia, esto aborta en vez de improvisar.
 */
const sqlClave = (valor) => {
  if (!SQLITE.test(valor)) morir('contraseña no segura para SQL');
  return `'${valor}'`;
};

/** Literal de SQL para texto corriente (zona horaria, nombre de base). Se escapa. */
const sqlTexto = (valor) => {
  // `\p{Cc}` (categoría «Control» de Unicode) en vez de `[\u0000-\u001f]`: comprueba lo mismo
  // —y también DEL y los controles C1— sin meter caracteres de control en el propio patrón, que
  // es lo que la regla `no-control-regex` de ESLint marca como error.
  if (/\p{Cc}/u.test(valor)) morir('texto con caracteres de control');
  return `'${valor.replace(/'/g, "''")}'`;
};

const construirSql = () => {
  const partes = [
    '-- OdontoCRM · roles y bases. Idempotente: se puede repetir sin miedo.',
    "-- La contraseña se aplica SIEMPRE (no solo al crear): así la base converge a lo",
    '-- que dicen los archivos, que es la única fuente de verdad.',
    '',
  ];

  const todos = [...SERVICIOS.map((s) => ({ rol: s.base, base: s.base })), { rol: COLA.rol, base: COLA.base }];

  for (const { rol, base } of todos) {
    const clave = rol === COLA.rol ? claves.cola : claves.servicios[SERVICIOS.find((s) => s.base === base).nombre];
    partes.push(
      `DO $$ BEGIN`,
      `  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${sqlTexto(rol)}) THEN`,
      `    CREATE ROLE ${rol} LOGIN;`,
      `  END IF;`,
      `END $$;`,
      `ALTER ROLE ${rol} WITH PASSWORD ${sqlClave(clave)};`,
      '',
      `SELECT 'CREATE DATABASE ${base} OWNER ${rol}'`,
      `WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = ${sqlTexto(base)})\\gexec`,
      `ALTER DATABASE ${base} SET timezone TO ${sqlTexto(opciones.tz)};`,
      `REVOKE ALL ON DATABASE ${base} FROM PUBLIC;`,
      `GRANT CONNECT, CREATE, TEMPORARY ON DATABASE ${base} TO ${rol};`,
      '',
    );
  }

  // Las extensiones viven DENTRO de cada base: hay que entrar en cada una.
  // pg_trgm (búsquedas por nombre) y pgcrypto (gen_random_uuid()).
  for (const { base } of todos) {
    partes.push(
      `\\connect ${base}`,
      `CREATE EXTENSION IF NOT EXISTS pgcrypto;`,
      `CREATE EXTENSION IF NOT EXISTS pg_trgm;`,
      '',
    );
  }

  return partes.join('\n');
};

/** Aplica el SQL: por URL de administrador o por el socket como usuario `postgres`. */
const aplicarSql = (sql) => {
  if (opciones.adminUrl) {
    detalle(`aplicando como administrador por URL (${opciones.adminUrl.replace(/:[^:@]*@/, ':***@')})`);
    return spawnSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', opciones.adminUrl], {
      input: sql,
      encoding: 'utf8',
    });
  }
  detalle('aplicando por el socket como usuario del sistema «postgres» (peer)');
  return spawnSync('runuser', ['-u', 'postgres', '--', 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1'], {
    input: sql,
    encoding: 'utf8',
  });
};

const aprovisionarBases = () => {
  paso('2/3 · PostgreSQL: roles, bases y extensiones');

  const sql = construirSql();
  if (opciones.dryRun) {
    detalle('[dry-run] este es el SQL que se aplicaría (contraseñas ocultas):');
    console.log(
      sql
        .split('\n')
        .map((l) => l.replace(/PASSWORD '[^']*'/, "PASSWORD '***'"))
        .map((l) => `      ${c.dim}${l}${c.re}`)
        .join('\n'),
    );
    return;
  }

  if (!opciones.adminUrl && process.getuid?.() !== 0) {
    morir(
      'para crear las bases hace falta ser root (o pasar --admin-url).\n' +
        '    Como usuario normal:  node infra/fedora/instalar/aprovisionar.mjs \\\n' +
        '        --admin-url="postgres://TU_USUARIO@/postgres?host=/var/run/postgresql"',
    );
  }

  const resultado = aplicarSql(sql);
  if (resultado.error) morir(`no pude ejecutar psql: ${resultado.error.message}`);
  if (resultado.status !== 0) {
    const salida = `${resultado.stdout ?? ''}${resultado.stderr ?? ''}`.trim();
    console.error(salida.split('\n').slice(-15).map((l) => `      ${l}`).join('\n'));
    morir(
      'PostgreSQL rechazó el aprovisionamiento.\n' +
        '    Si el error es de autenticación del socket (peer), crea tu rol superusuario:\n' +
        '        sudo -u postgres createuser --superuser "$USER"',
    );
  }

  const nombres = [...SERVICIOS.map((s) => s.base), COLA.base];
  ok(`${nombres.length} roles y ${nombres.length} bases al día (contraseñas aplicadas)`);
  ok('extensiones pgcrypto y pg_trgm en cada base');
};

/* ── Comprobación POR EFECTO: la credencial vale si CONECTA ────────────────── */

const conectar = (rol, clave, base) => {
  const resultado = spawnSync(
    'psql',
    ['-X', '-w', '-tAc', 'select 1', '-h', '127.0.0.1', '-p', '5432', '-U', rol, '-d', base],
    {
      encoding: 'utf8',
      env: { ...process.env, PGPASSWORD: clave, PGPASSFILE: '/dev/null', PGCONNECT_TIMEOUT: '5' },
      timeout: 15000,
    },
  );
  return resultado.status === 0 && (resultado.stdout ?? '').trim() === '1';
};

const verificar = () => {
  paso('3/3 · Comprobación por efecto: cada credencial tiene que CONECTAR');

  const fallos = [];
  for (const servicio of SERVICIOS) {
    const bien = conectar(servicio.base, claves.servicios[servicio.nombre], servicio.base);
    if (bien) ok(`${servicio.nombre.padEnd(14)} conecta (rol ${servicio.base} → base ${servicio.base})`);
    else {
      err(`${servicio.nombre.padEnd(14)} NO conecta: revisa ${join(ETC, `${servicio.nombre}.env`)}`);
      fallos.push(servicio.nombre);
    }
  }
  const colaBien = conectar(COLA.rol, claves.cola, COLA.base);
  if (colaBien) ok(`${'cola de eventos'.padEnd(14)} conecta (rol ${COLA.rol} → base ${COLA.base})`);
  else {
    err(`${'cola de eventos'.padEnd(14)} NO conecta`);
    fallos.push('cola de eventos');
  }

  // Coherencia entre archivos: es la clase de fallo que costó cinco rondas.
  const secretos = new Set(
    SERVICIOS_TODOS.map((n) => leerEnv(join(ETC, `${n}.env`)).INTERNAL_SERVICE_SECRET),
  );
  const colas = new Set(SERVICIOS.map((s) => leerEnv(join(ETC, `${s.nombre}.env`)).EVENTS_DATABASE_URL));
  if (secretos.size === 1 && !secretos.has(undefined)) ok('el secreto interno es el mismo en los 9');
  else {
    err(`INTERNAL_SERVICE_SECRET no coincide en los 9 archivos (${secretos.size} valores distintos)`);
    fallos.push('secreto interno');
  }
  if (colas.size === 1 && !colas.has(undefined)) ok('la cola de eventos es la misma en los 8');
  else {
    err(`EVENTS_DATABASE_URL no coincide (${colas.size} valores distintos)`);
    fallos.push('cola de eventos');
  }

  return fallos;
};

/* ── Punto de entrada ──────────────────────────────────────────────────────── */

paso('OdontoCRM · aprovisionar (la ÚNICA fuente de verdad de las credenciales)');
detalle(`directorio de entorno: ${ETC}`);
detalle(`nombre: ${opciones.host}${opciones.ip ? `   IP: ${opciones.ip}` : ''}`);
if (opciones.rotate) av('--rotate: se generan contraseñas NUEVAS (invalida las anteriores)');
if (opciones.dryRun) av('--dry-run: no se escribe ni se cambia nada');

console.log();
if (opciones.soloVerificar) {
  detalle('modo comprobación: no se escribe ni se cambia nada');
} else {
  ok(
    generadas > 0
      ? `${generadas} secreto(s) generado(s) ahora`
      : 'todos los secretos ya existían: se conservan (usa --rotate para cambiarlos)',
  );
  if (reutilizadas.length > 0) detalle(`conservados: ${reutilizadas.join(', ')}`);
}

if (!opciones.soloBases && !opciones.soloVerificar) escribirArchivos();
if (!opciones.soloArchivos && !opciones.soloVerificar) aprovisionarBases();

const fallos =
  opciones.dryRun || opciones.soloArchivos ? [] : verificar();

if (opciones.dryRun) {
  console.log();
  ok('dry-run terminado: nada se ha tocado');
  process.exit(0);
}

console.log();
if (fallos.length === 0) {
  ok('aprovisionamiento correcto: los 9 servicios tienen credencial que conecta');
  detalle(`siguiente paso:  30-desplegar.sh  (código sin secretos + unidades + TLS)`);
  process.exit(0);
}
err(`${fallos.length} problema(s): ${fallos.join(', ')}`);
process.exit(1);
