#!/usr/bin/env node
/**
 * Preflight de `npm run dev`: comprueba que los puertos que va a necesitar estén
 * **libres** y que las **bases del proyecto estén completas**; si algo falla, dice
 * qué pasa, quién lo tiene y cómo arreglarlo.
 *
 *   npm run dev:check          (se ejecuta solo antes de `npm run dev`)
 *   npm run dev:check -- --all (no falla: solo informa)
 *
 * Existe por dos casos reales:
 *
 * 1. Un servidor de Vite de una sesión anterior seguía ocupando el 5173 con el grafo
 *    de módulos roto; `npm run dev` no podía tomar el puerto (`strictPort`),
 *    `concurrently -k` mataba el resto y el navegador seguía mirando el servidor
 *    viejo: pantalla en negro sin ningún mensaje.
 * 2. Se arrancó `npm run dev` **mientras `db:reset` seguía borrando y recreando
 *    bases**: el bucle va en orden (`identity`, `patients`, `scheduling`…), así que
 *    los servicios que arrancaron contra una base que ya no existía murieron
 *    (`patients` y `scheduling`) y el bot empezó a fallar con
 *    `ECONNREFUSED 127.0.0.1:4002`. Mirar si las 9 bases están antes de arrancar
 *    convierte ese fallo raro en un mensaje claro.
 *
 * Desde que la pila se cambia de modo con `npm run stack:*`, este preflight es la
 * puerta de `npm run dev`: la regla es **una sola pila a la vez**.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

import { revisarEntornos } from './lib/entorno.mjs';
import {
  bloqueoVigente,
  limpiarBloqueo,
  RUTA_BLOQUEO as RUTA_BLOQUEO_MOSTRADA,
} from './lib/mantenimiento.mjs';
import { cuando, retratoDeLaPila } from './lib/stack.mjs';

const { Client } = pg;

const ROOT = resolve(process.cwd());
const soloInformar = process.argv.includes('--all');

/** Las mismas bases que crea `db:bootstrap` (`infra/db/bootstrap.mjs`). */
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

/* ── 1. ¿Hay una operación de mantenimiento en curso? ──────────────────────── */

const bloqueo = bloqueoVigente();

if (bloqueo !== null && bloqueo.vivo) {
  console.error(
    `dev:check: hay una operación de mantenimiento en curso (${bloqueo.tarea}, PID ${String(bloqueo.pid)}).\n` +
      '  No se arranca la pila: los servicios que apunten a una base que ya no existe\n' +
      '  se caen al conectar (pasó el 2026-10-04 con `patients` y `scheduling`, y el bot\n' +
      '  empezó a fallar con ECONNREFUSED 127.0.0.1:4002).\n\n' +
      '  · Espérala y vuelve a intentarlo.\n' +
      '  · Si ese proceso ya no existe, borra el bloqueo:\n' +
      `      Remove-Item "${RUTA_BLOQUEO_MOSTRADA}"\n`,
  );
  process.exit(soloInformar ? 0 : 1);
}

if (bloqueo !== null) {
  console.warn(
    `dev:check: había un bloqueo caducado (${bloqueo.tarea}, PID ${String(bloqueo.pid)} ya no existe); se limpia.\n`,
  );
  limpiarBloqueo();
}

/* ── 2. ¿A algún .env le faltan claves de su plantilla? ────────────────────── */

/**
 * Solo avisa (no bloquea): sin el token del bot la aplicación funciona, solo que los
 * mensajes no salen a Telegram. Pero hay que decirlo, porque el síntoma —«el bot no
 * contesta»— aparece mucho después y en otro sitio.
 */
const { faltantes, consecuencia } = revisarEntornos();

if (faltantes.length > 0) {
  console.warn('dev:check: a estos .env les faltan claves que su plantilla espera:\n');
  for (const { servicio, claves } of faltantes) {
    console.warn(`  ⚠ services/${servicio}/.env → ${claves.join(', ')}`);
    for (const clave of claves) {
      if (consecuencia[clave] !== undefined)
        console.warn(`      · ${clave}: ${consecuencia[clave]}`);
    }
  }
  console.warn(
    '\n  Copia las que falten desde services/<servicio>/.env.example.' +
      '\n  Detalle:  npm run env:check   ·   docs/COMANDOS.md §4\n',
  );
}

/* ── 2. Puertos ────────────────────────────────────────────────────────────── */

const retrato = await retratoDeLaPila();

if (retrato.ocupados.length > 0) {
  console.error('dev:check: hay puertos ocupados y `npm run dev` los necesita todos:\n');
  for (const entrada of retrato.ocupados) {
    const quien =
      entrada.pid === null ? entrada.nombre : `${entrada.nombre} (PID ${String(entrada.pid)})`;
    console.error(
      `  ✖ ${String(entrada.puerto).padStart(4)} · ${entrada.servicio.padEnd(14)} → ${quien}` +
        `  desde ${cuando(entrada.desde)}${entrada.conWatch ? ' · con recarga' : ''}`,
    );
  }

  const conPm2 = retrato.ocupados.some((entrada) => entrada.pm2 !== null);

  console.error('\nQué hacer:');
  if (conPm2) {
    console.error(
      '  · La pila la tiene PM2 (o procesos sueltos de un `start:*`), que ocupan los mismos puertos.\n' +
        '      Cambiar de modo:   npm run stack:dev    (con recarga: para la anterior y arranca esta)\n' +
        '      Ver qué corre:     npm run stack:status\n' +
        '      Sola la web:       npm run dev:web      (usa el 5173, si está libre)',
    );
  } else {
    console.error(
      '  · Suele ser un `npm run dev` o un Vite de una sesión anterior que quedó vivo.\n' +
        '      Parar y arrancar:  npm run stack:dev',
    );
  }
  console.error('  · Ver solo el estado, sin fallar:   npm run dev:check -- --all\n');

  process.exit(soloInformar ? 0 : 1);
}

/* ── 2. Bases de datos ─────────────────────────────────────────────────────── */

const envFile = resolve(ROOT, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const adminUrl = process.env['PG_ADMIN_URL'];

if (adminUrl === undefined || adminUrl === '') {
  // Sin credenciales de administrador no se puede comprobar: se avisa y se sigue.
  console.warn(
    'dev:check: no hay PG_ADMIN_URL en el .env, así que no puedo comprobar las bases.\n' +
      '           Si los servicios fallan al conectar, ejecuta:  npm run db:bootstrap\n',
  );
  console.log('dev:check: los puertos del desarrollo están libres ✔');
  process.exit(0);
}

const admin = new Client({ connectionString: adminUrl, application_name: 'odontocrm-dev-check' });
/** Bases que faltan (distinto de las claves que faltan en los `.env`, arriba). */
let basesFaltantes = [];
let sinServidor = false;

try {
  await admin.connect();
  const { rows } = await admin.query(
    'select datname from pg_database where datname = any($1::text[])',
    [BASES],
  );
  const existentes = new Set(rows.map((fila) => String(fila.datname)));
  basesFaltantes = BASES.filter((base) => !existentes.has(base));
} catch (error) {
  sinServidor = true;
  console.error(
    `dev:check: no pude conectar con PostgreSQL: ${error instanceof Error ? error.message : String(error)}\n` +
      '  · ¿Está corriendo el servicio? (en Windows: `postgresql-x64-18`)\n' +
      '  · Revisa PG_ADMIN_URL en el .env (ver docs/SEGURIDAD_SECRETOS.md)\n',
  );
} finally {
  await admin.end().catch(() => undefined);
}

if (basesFaltantes.length > 0) {
  console.error(
    'dev:check: faltan bases de datos y los servicios no pueden arrancar así:\n' +
      basesFaltantes.map((base) => `  ✖ ${base}`).join('\n') +
      '\n\n  Lo más probable es que `db:reset` esté a medias (o no se haya ejecutado):\n' +
      '  el bucle borra y recrea una base detrás de otra y, si arrancas la pila en medio,\n' +
      '  los servicios que apunten a una base que ya no existe se caen al conectar.\n\n' +
      '  Qué hacer:\n' +
      '    · Si tienes `db:reset` corriendo en otra terminal: **espéralo** y vuelve a intentarlo.\n' +
      '    · Si no:  npm run db:reset -- --yes     (borra todo y lo deja listo)\n' +
      '    · O solo lo que falta:  npm run db:bootstrap  &&  npm run db:migrate\n',
  );
  process.exit(soloInformar ? 0 : 1);
}

if (sinServidor) process.exit(soloInformar ? 0 : 1);

/**
 * Sin usuarios no se puede entrar con **ninguna** contraseña: es el estado que deja
 * `db:reset --sin-sembrar`. Se avisa aquí (no se falla: los servicios arrancan
 * igual) para no tener que adivinarlo en la pantalla de login. El login también lo
 * dice, pero mejor saberlo antes.
 */
try {
  const identityUrl = /^DATABASE_URL=(.*)$/m
    .exec(readFileSync(resolve(ROOT, 'services/identity/.env'), 'utf8'))?.[1]
    ?.trim();

  if (identityUrl !== undefined) {
    const identidad = new Client({ connectionString: identityUrl });
    await identidad.connect();
    try {
      const { rows } = await identidad.query('select count(*)::int as total from users');
      if (rows[0]?.total === 0) {
        console.warn(
          'dev:check: las bases existen pero **no hay usuarios**: ninguna contraseña va a\n' +
            '           funcionar hasta que los crees con  npm run seed:users\n',
        );
      }
    } finally {
      await identidad.end().catch(() => undefined);
    }
  }
} catch {
  // Si no se puede comprobar (credenciales, tabla a medio migrar), no se bloquea nada.
}

console.log('dev:check: los puertos del desarrollo están libres y las 9 bases existen ✔');
