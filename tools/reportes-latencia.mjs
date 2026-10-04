#!/usr/bin/env node
/**
 * Prueba de latencia de los reportes (Fase 9).
 *
 * El criterio de aceptación de la fase dice: «ninguna consulta pesada golpea las
 * BD operativas (**< 2 s por reporte con 10.000 citas**)». Esta herramienta lo
 * mide de verdad: llena el read model de `reporting` con 10.000 citas y 3.000
 * pacientes **sintéticos** (marcados con un prefijo de UUID reconocible, nunca
 * datos reales), refresca las vistas materializadas y cronometra cada reporte a
 * través del gateway, con sesión de administrador.
 *
 *   npm run build && npm run db:migrate
 *   npm run stack:fijo            # o: npm run dev
 *   npm run reports:latencia      # inserta, mide y limpia
 *   npm run reports:latencia -- --keep   # deja los datos sintéticos (para mirar la pantalla)
 *   npm run reports:latencia -- --clean  # solo limpia
 *
 * ⚠️ Cambia la contraseña del administrador sembrado si nace con
 * `mustChangePassword`. Al terminar:  npm run seed:users -- --reset
 *
 * Cómo elige lo que mide: se cronometra la respuesta completa por el gateway
 * (proxy incluido), que es como la vive la pantalla. La primera llamada de cada
 * reporte puede pagar el `REFRESH` que dejó el lote de eventos; por eso se mide
 * dos veces y se informa la **segunda** (la consulta en régimen).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GATEWAY = process.env.REPORTS_GATEWAY_URL ?? 'http://127.0.0.1:8090';
const LIMITE_MS = Number(process.env.REPORTS_LIMIT_MS ?? 2_000);
const CITAS = Number(process.env.REPORTS_CITAS ?? 10_000);
const PACIENTES = Number(process.env.REPORTS_PACIENTES ?? 3_000);
const args = process.argv.slice(2);
const soloLimpiar = args.includes('--clean');
const conservar = args.includes('--keep');

/** Prefijo de los identificadores sintéticos: así se borran sin tocar nada más. */
const PREFIJO = 'ffff0000';

let fallos = 0;
const check = (etiqueta, condicion, detalle = '') => {
  if (!condicion) fallos += 1;
  console.log(`${condicion ? '✔' : '✖'} ${etiqueta}${detalle === '' ? '' : ` → ${detalle}`}`);
};

const leerEnv = (ruta, clave) => {
  const camino = resolve(ROOT, ruta);
  if (!existsSync(camino)) return undefined;
  const match = new RegExp(`^${clave}=(.*)$`, 'm').exec(readFileSync(camino, 'utf8'));
  return match?.[1]?.trim();
};

const databaseUrl =
  process.env.REPORTS_DATABASE_URL ?? leerEnv('services/reporting/.env', 'DATABASE_URL');

if (databaseUrl === undefined) {
  console.error(
    'No hay REPORTS_DATABASE_URL ni DATABASE_URL en services/reporting/.env.\n' +
      'Ejecuta primero:  npm run db:bootstrap  &&  npm run db:migrate',
  );
  process.exit(1);
}

/* ── 1) Datos sintéticos en el read model ──────────────────────────────────── */

const uuid = (grupo, indice) =>
  `${PREFIJO}-0000-4000-8000-${grupo}${String(indice).padStart(11, '0')}`;

const limpiar = async (client) => {
  await client.query('delete from fact_appointment where patient_id::text like $1', [
    `${PREFIJO}%`,
  ]);
  await client.query('delete from fact_request where patient_id::text like $1', [`${PREFIJO}%`]);
  await client.query('delete from fact_prescription_item where patient_id::text like $1', [
    `${PREFIJO}%`,
  ]);
  await client.query('delete from fact_prescription where patient_id::text like $1', [
    `${PREFIJO}%`,
  ]);
  await client.query('delete from fact_clinical_session where patient_id::text like $1', [
    `${PREFIJO}%`,
  ]);
  await client.query('delete from fact_tooth_finding where patient_id::text like $1', [
    `${PREFIJO}%`,
  ]);
  await client.query('delete from dim_patient where patient_id::text like $1', [`${PREFIJO}%`]);
};

const sembrar = async (client) => {
  console.log(`· Insertando ${PACIENTES} pacientes y ${CITAS} citas sintéticas en el read model…`);

  // Pacientes: en bloques de 500 para no armar una sentencia gigantesca.
  for (let inicio = 0; inicio < PACIENTES; inicio += 500) {
    const valores = [];
    const parametros = [];
    for (let i = inicio; i < Math.min(inicio + 500, PACIENTES); i += 1) {
      const base = parametros.length;
      valores.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}::date, $${base + 6}, false, $${base + 7}, now())`,
      );
      parametros.push(
        uuid(1, i),
        `V-9${String(10_000_000 + i)}`,
        `Paciente Latencia ${String(i)}`,
        i % 3 === 0 ? 'M' : i % 3 === 1 ? 'F' : 'O',
        `19${String(50 + (i % 50))}-0${String(1 + (i % 9))}-1${String(i % 9)}`,
        i % 5 === 0 ? 'en_espera_cita' : 'activo',
        i % 7 === 0 ? ['diabetes'] : i % 11 === 0 ? ['alergia_penicilina'] : [],
      );
    }
    await client.query(
      `insert into dim_patient
         (patient_id, document, full_name, sex, birth_date, status, is_fictitious, profile_alerts, updated_at)
       values ${valores.join(', ')}
       on conflict (patient_id) do nothing`,
      parametros,
    );
  }

  // Citas: repartidas en los últimos 365 días, con estados y horas variadas.
  for (let inicio = 0; inicio < CITAS; inicio += 500) {
    const valores = [];
    const parametros = [];
    for (let i = inicio; i < Math.min(inicio + 500, CITAS); i += 1) {
      const base = parametros.length;
      const estado =
        i % 10 === 0
          ? 'no_asistio'
          : i % 4 === 0
            ? 'programada'
            : i % 7 === 0
              ? 'notificada'
              : 'atendido';
      valores.push(
        `($${base + 1}, $${base + 2}, (current_date - ($${base + 3}::int % 365)), $${base + 4}, $${base + 5}, $${base + 6}, now(), $${base + 7}::timestamptz, $${base + 8}::timestamptz)`,
      );
      parametros.push(
        uuid(2, i),
        uuid(1, i % PACIENTES),
        i,
        `${String(8 + (i % 9)).padStart(2, '0')}:${i % 2 === 0 ? '00' : '30'}`,
        `${String(8 + (i % 9)).padStart(2, '0')}:${i % 2 === 0 ? '30' : '00'}`,
        estado,
        i % 4 === 0 ? null : new Date(),
        estado === 'atendido' ? new Date() : null,
      );
    }
    await client.query(
      `insert into fact_appointment
         (appointment_id, patient_id, appointment_date, start_time, end_time, status, last_event_at, scheduled_at, finished_at)
       values ${valores.join(', ')}
       on conflict (appointment_id) do nothing`,
      parametros,
    );
  }

  // Las vistas materializadas se refrescan como lo haría el consumidor.
  for (const vista of [
    'mv_daily_kpis',
    'mv_funnel',
    'mv_oral_health',
    'mv_demographics',
    'mv_prescriptions',
  ]) {
    await client.query(`refresh materialized view ${vista}`);
  }
  console.log('· Vistas materializadas refrescadas.');
};

/* ── 2) Medición por el gateway ────────────────────────────────────────────── */

let token = '';
const call = async (ruta, options = {}) => {
  const respuesta = await fetch(`${GATEWAY}${ruta}`, {
    ...options,
    signal: AbortSignal.timeout(30_000),
    headers: {
      ...(token === '' ? {} : { authorization: `Bearer ${token}` }),
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
  });
  const texto = await respuesta.text();
  let cuerpo;
  try {
    cuerpo = JSON.parse(texto);
  } catch {
    cuerpo = texto.slice(0, 200);
  }
  return { status: respuesta.status, body: cuerpo };
};

const login = async () => {
  const intentar = (password) =>
    call('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: process.env.REPORTS_USERNAME ?? 'admin', password }),
    });
  const nueva = process.env.REPORTS_NEW_PASSWORD ?? 'prueba-e2e-odontocrm-2026';
  let respuesta = await intentar(process.env.REPORTS_PASSWORD ?? 'admin-odontocrm-2026');
  if (respuesta.status === 401) respuesta = await intentar(nueva);
  if (respuesta.status !== 200) {
    console.error(
      '\nNo se pudo iniciar sesión en el gateway. ¿Está la pila arriba (npm run stack:status)?\n' +
        'Si la contraseña sembrada cambió:  npm run seed:users -- --reset',
    );
    process.exit(1);
  }
  token = respuesta.body?.accessToken ?? '';
  if (respuesta.body?.user?.mustChangePassword === true) {
    const cambiada = await call('/api/v1/auth/password/change', {
      method: 'POST',
      body: JSON.stringify({
        currentPassword: process.env.REPORTS_PASSWORD ?? 'admin-odontocrm-2026',
        newPassword: nueva,
        repeatPassword: nueva,
      }),
    });
    token = cambiada.body?.accessToken ?? token;
  }
};

const medir = async (ruta) => {
  // Dos pasadas: la primera puede pagar lo que dejó el lote de eventos.
  const primera = await call(ruta);
  const inicio = performance.now();
  const segunda = await call(ruta);
  const ms = performance.now() - inicio;
  const ok = primera.status === 200 && segunda.status === 200;
  return { ruta, ms, ok, status: segunda.status };
};

/* ── Programa principal ────────────────────────────────────────────────────── */

/** `false` cuando solo se pidió limpiar: entonces no se habla de latencias. */
let medido = true;

const pool = new pg.Pool({
  connectionString: databaseUrl,
  max: 2,
  applicationName: 'odontocrm-latencia',
});
const client = await pool.connect();

try {
  if (soloLimpiar) {
    await limpiar(client);
    console.log('Datos sintéticos borrados ✔ (no se midió nada: solo se pidió --clean)');
    medido = false;
  } else {
    await limpiar(client);
    await sembrar(client);

    await login();
    const rutas = [
      '/api/v1/reports/funnel',
      '/api/v1/reports/capacity',
      '/api/v1/reports/demographics',
      '/api/v1/reports/clinical-profile',
      '/api/v1/reports/oral-health',
      '/api/v1/reports/prescriptions',
    ];

    console.log(`\nCronometrando los reportes con ${CITAS} citas (límite ${LIMITE_MS} ms):\n`);
    for (const ruta of rutas) {
      const { ms, ok, status } = await medir(ruta);
      check(
        `${ruta} responde y baja de ${LIMITE_MS} ms`,
        ok && ms < LIMITE_MS,
        `status ${status} · ${ms.toFixed(0)} ms`,
      );
    }

    if (!conservar) {
      await limpiar(client);
      for (const vista of [
        'mv_daily_kpis',
        'mv_funnel',
        'mv_oral_health',
        'mv_demographics',
        'mv_prescriptions',
      ]) {
        await client.query(`refresh materialized view ${vista}`);
      }
      console.log('\n· Datos sintéticos borrados y vistas refrescadas.');
    } else {
      console.log('\n· Datos sintéticos conservados (--keep): recuerda borrarlos con --clean.');
    }
  }
} finally {
  client.release();
  await pool.end();
}

if (fallos > 0) {
  console.error(`\n${String(fallos)} reporte(s) por encima del límite o sin respuesta ✖`);
  process.exit(1);
}
if (medido) console.log(`\nLos seis reportes responden por debajo de ${LIMITE_MS} ms ✔`);
