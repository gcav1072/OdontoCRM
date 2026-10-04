#!/usr/bin/env node
/**
 * **Tablero de estado y alertas** de la pila (Fase 10, observabilidad).
 *
 * ```
 * npm run estado                 # una foto legible de los 9 servicios, las bases, la cola y el outbox
 * npm run estado -- --json       # la misma foto en JSON (para una máquina)
 * npm run estado -- --alertas    # solo lo que está mal; sale con 1 si hay algo (cron/systemd timer)
 * npm run estado -- --vigilar 5  # refresca cada 5 s (para una terminal abierta)
 * npm run estado -- --sin-servicios  # sin preguntar por HTTP (cuando la pila está parada)
 * ```
 *
 * Mira lo que un tablero tiene que mirar para que no se caiga nada en silencio:
 *
 * 1. **Los nueve procesos** por su `/health` y su `/ready`, con la latencia y el
 *    detalle del chequeo que falla (la base, la cola, el bot…).
 * 2. **Las nueve bases**: tamaño y conexiones, para ver crecer lo que crece.
 * 3. **La cola** de `pg-boss`: pendientes, en curso, completados y **fallidos**, cola
 *    por cola.
 * 4. **El outbox** de cada servicio: eventos sin publicar y eventos con reintentos
 *    (con el último error, que es lo que dice *por qué*).
 * 5. **Los envíos atascados** de notificaciones: mensajes en cola cuyo siguiente
 *    intento ya venció hace rato.
 * 6. **El modo test**: si está activo, avisa en cada foto (los datos son ficticios).
 *
 * Con `--alertas` imprime solo los problemas y devuelve código 1: así lo puede
 * vigilar un `systemd` timer (`infra/fedora/systemd/odontocrm-alertas.*`) sin que
 * nadie lea una tabla.
 */
import { statfs } from 'node:fs/promises';
import { resolve } from 'node:path';

import pg from 'pg';

import { resolveTestMode } from '@odontocrm/contracts';

import { alertasDe, bytes, hace } from './lib/alertas.mjs';

import {
  entornoRaiz,
  leerEnv,
  PROCESOS,
  puertoDe,
  ROOT,
  rutaEnvDe,
  SERVICIOS,
} from './lib/servicios.mjs';

const { Client } = pg;

const args = process.argv.slice(2);
const CONOCIDAS = ['--json', '--alertas', '--vigilar', '--sin-servicios', '--ayuda'];
const desconocida = args.find((arg) => arg.startsWith('--') && !CONOCIDAS.includes(arg));
if (desconocida !== undefined || args.includes('--ayuda')) {
  console.log(
    'Uso: npm run estado [-- --json | --alertas | --vigilar <segundos> | --sin-servicios]\n\n' +
      '  --json           la foto en JSON\n' +
      '  --alertas        solo los problemas; sale con 1 si hay alguno\n' +
      '  --vigilar <seg>  refresca cada N segundos\n' +
      '  --sin-servicios  no pregunta por HTTP (pila parada: solo bases, cola y outbox)\n',
  );
  process.exit(desconocida === undefined ? 0 : 1);
}

const comoJson = args.includes('--json');
const soloAlertas = args.includes('--alertas');
const sinServicios = args.includes('--sin-servicios');
const vigilarIndex = args.indexOf('--vigilar');
const vigilarSegundos =
  vigilarIndex === -1 ? 0 : Math.max(2, Number(args[vigilarIndex + 1] ?? '5') || 5);

const color = {
  ok: (texto) => `\u001b[32m${texto}\u001b[0m`,
  aviso: (texto) => `\u001b[33m${texto}\u001b[0m`,
  error: (texto) => `\u001b[31m${texto}\u001b[0m`,
  tenue: (texto) => `\u001b[2m${texto}\u001b[0m`,
  titulo: (texto) => `\u001b[1m${texto}\u001b[0m`,
};
// Limpia los códigos ANSI cuando hace falta medir el texto sin colores.
const sinColor = (texto) => texto.replaceAll('\u001b', '').replace(/\[\d+m/g, '');

const ahora = () => new Date();

// ── Recolección ───────────────────────────────────────────────────────────────

/** Pregunta a un servicio por HTTP sin dejar que un cuelgue pare el tablero. */
const preguntar = async (url, timeoutMs = 2_000) => {
  const empezado = performance.now();
  try {
    const respuesta = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    const cuerpo = await respuesta.json().catch(() => null);
    return {
      ok: respuesta.ok,
      status: respuesta.status,
      ms: Math.round(performance.now() - empezado),
      cuerpo,
    };
  } catch (fallo) {
    return {
      ok: false,
      status: 0,
      ms: Math.round(performance.now() - empezado),
      error: fallo instanceof Error ? fallo.message : String(fallo),
    };
  }
};

const revisarServicios = async (entorno) => {
  const puertoGateway = puertoDe(
    PROCESOS.find((proceso) => proceso.name === 'gateway') ?? PROCESOS[0],
    entorno,
  );
  const resultados = [];

  for (const proceso of PROCESOS) {
    const puerto = puertoDe(proceso, entorno);
    const base = `http://127.0.0.1:${String(puerto)}`;
    const [health, ready] = await Promise.all([
      preguntar(`${base}/health`),
      preguntar(`${base}/ready`),
    ]);

    // El estado del sistema (`/api/v1/meta`) lo publica la puerta: sirve para
    // saber si esta instalación es de pruebas sin mirar ningún `.env`.
    const meta = proceso.name === 'gateway' ? await preguntar(`${base}/api/v1/meta`) : null;

    resultados.push({
      name: proceso.name,
      port: puerto,
      unidad: proceso.unidad,
      health,
      ready,
      meta: meta?.cuerpo ?? null,
      arriba: health.ok,
      listo: ready.ok,
      checks: Array.isArray(ready.cuerpo?.checks) ? ready.cuerpo.checks : [],
      fallos: (Array.isArray(ready.cuerpo?.checks) ? ready.cuerpo.checks : []).filter(
        (check) => check.status === 'error',
      ),
    });
  }

  return { servicios: resultados, puertoGateway };
};

const conectar = (url, applicationName) => {
  const client = new Client({ connectionString: url, application_name: applicationName });
  return client;
};

const revisarCola = async () => {
  const url = leerEnv(rutaEnvDe(SERVICIOS.find((s) => s.name === 'identity'))).EVENTS_DATABASE_URL;
  if (url === undefined) return { error: 'falta EVENTS_DATABASE_URL' };

  const client = conectar(url, 'odontocrm-estado');
  try {
    await client.connect();
    const { rows } = await client.query(
      `select name,
              count(1) filter (where state in ('created', 'retry', 'active'))::int as pendientes,
              count(1) filter (where state = 'failed')::int as fallidos,
              count(1) filter (where state = 'completed')::int as completados,
              min(created_on) filter (where state in ('created', 'retry')) as mas_antiguo
         from pgboss.job
        where name like 'domain-events%'
        group by name order by name`,
    );
    return {
      colas: rows.map((fila) => ({
        name: fila.name,
        pendientes: fila.pendientes,
        fallidos: fila.fallidos,
        completados: fila.completados,
        masAntiguo: fila.mas_antiguo === null ? null : new Date(fila.mas_antiguo).toISOString(),
      })),
    };
  } catch (fallo) {
    return { error: fallo instanceof Error ? fallo.message : String(fallo) };
  } finally {
    await client.end().catch(() => undefined);
  }
};

/**
 * Una conexión por servicio para las dos cosas que dependen de su base: el outbox
 * (eventos sin publicar) y el tamaño de la base. Se hace así, y no con una conexión
 * de superusuario, para que el tablero funcione **en producción**, donde
 * `PG_ADMIN_URL` no vive en el disco: cada rol ve lo suyo y es suficiente.
 */
const revisarDatos = async () => {
  const resultados = [];

  for (const servicio of SERVICIOS) {
    const url = leerEnv(rutaEnvDe(servicio)).DATABASE_URL;
    if (url === undefined) {
      resultados.push({ name: servicio.name, error: 'sin DATABASE_URL' });
      continue;
    }

    const client = conectar(url, 'odontocrm-estado');
    try {
      await client.connect();
      const { rows } = await client.query(
        `select count(1) filter (where published_at is null)::int as pendientes,
                count(1) filter (where published_at is null and attempts > 0)::int as reintentando,
                min(occurred_at) filter (where published_at is null) as mas_antiguo,
                max(last_error) filter (where published_at is null and last_error is not null) as ultimo_error
           from outbox_events`,
      );
      const { rows: base } = await client.query(
        `select current_database() as base,
                pg_database_size(current_database()) as bytes,
                (select count(1)::int from pg_stat_activity where datname = current_database()) as conexiones,
                version() as version`,
      );
      const fila = rows[0] ?? {};
      resultados.push({
        name: servicio.name,
        pendientes: fila.pendientes ?? 0,
        reintentando: fila.reintentando ?? 0,
        masAntiguo: fila.mas_antiguo === null ? null : new Date(fila.mas_antiguo).toISOString(),
        ultimoError: fila.ultimo_error ?? null,
        base: base[0]?.base ?? servicio.database,
        bytes: Number(base[0]?.bytes ?? 0),
        conexiones: base[0]?.conexiones ?? 0,
        version: String(base[0]?.version ?? '')
          .split(' ')
          .slice(0, 2)
          .join(' '),
      });
    } catch (fallo) {
      resultados.push({
        name: servicio.name,
        error: fallo instanceof Error ? fallo.message : String(fallo),
      });
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  return resultados;
};

/** Resumen de bases: con `PG_ADMIN_URL` (desarrollo) o a partir de cada servicio. */
const revisarBases = async (entorno, datos) => {
  const adminUrl = entorno.PG_ADMIN_URL;
  if (adminUrl !== undefined && adminUrl !== '') {
    const client = conectar(adminUrl, 'odontocrm-estado-admin');
    try {
      await client.connect();
      const { rows: version } = await client.query('select version() as version');
      const { rows: bases } = await client.query(
        `select datname as base, pg_database_size(datname) as bytes
           from pg_database where datname like 'odonto_%' order by datname`,
      );
      const { rows: conexiones } = await client.query(
        `select count(1)::int as total from pg_stat_activity where datname like 'odonto_%'`,
      );
      return {
        origen: 'admin',
        host: new URL(adminUrl).host,
        version: String(version[0]?.version ?? '')
          .split(' ')
          .slice(0, 2)
          .join(' '),
        bases: bases.map((fila) => ({ base: fila.base, bytes: Number(fila.bytes) })),
        conexiones: conexiones[0]?.total ?? 0,
      };
    } catch (fallo) {
      // Sin superusuario se sigue con lo que cada servicio puede contar.
      return resumirBasesDeServicios(datos, fallo instanceof Error ? fallo.message : String(fallo));
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  return resumirBasesDeServicios(datos, null);
};

const resumirBasesDeServicios = (datos, aviso) => {
  const conBase = datos.filter((fila) => fila.bytes !== undefined);
  return {
    origen: 'servicios',
    host: 'las bases de cada servicio',
    version: conBase[0]?.version ?? '',
    bases: conBase.map((fila) => ({ base: fila.base, bytes: fila.bytes })),
    conexiones: conBase.reduce((total, fila) => total + (fila.conexiones ?? 0), 0),
    ...(aviso === null ? {} : { aviso }),
  };
};

const revisarEnvios = async () => {
  const url = leerEnv(rutaEnvDe(SERVICIOS.find((s) => s.name === 'notifications'))).DATABASE_URL;
  if (url === undefined) return { error: 'sin DATABASE_URL' };

  const client = conectar(url, 'odontocrm-estado');
  try {
    await client.connect();
    const { rows } = await client.query(
      `select count(1) filter (where status = 'queued')::int as en_cola,
              count(1) filter (where status = 'failed')::int as fallidos,
              count(1) filter (where status = 'skipped_no_channel')::int as sin_canal,
              min(next_attempt_at) filter (where status = 'queued') as proximo_intento
         from notifications`,
    );
    const fila = rows[0] ?? {};
    return {
      enCola: fila.en_cola ?? 0,
      fallidos: fila.fallidos ?? 0,
      sinCanal: fila.sin_canal ?? 0,
      proximoIntento:
        fila.proximo_intento === null ? null : new Date(fila.proximo_intento).toISOString(),
    };
  } catch (fallo) {
    return { error: fallo instanceof Error ? fallo.message : String(fallo) };
  } finally {
    await client.end().catch(() => undefined);
  }
};

const revisarReportes = async () => {
  const url = leerEnv(rutaEnvDe(SERVICIOS.find((s) => s.name === 'reporting'))).DATABASE_URL;
  if (url === undefined) return { error: 'sin DATABASE_URL' };

  const client = conectar(url, 'odontocrm-estado');
  try {
    await client.connect();
    const { rows } = await client.query(
      `select count(1)::int as total, max(processed_at) as ultimo from processed_events`,
    );
    const { rows: refrescos } = await client.query(
      `select started_at, ok, error, trigger from report_refreshes order by started_at desc limit 1`,
    );
    return {
      eventosProyectados: rows[0]?.total ?? 0,
      ultimoEvento: rows[0]?.ultimo === null ? null : new Date(rows[0]?.ultimo).toISOString(),
      ultimoRefresco:
        refrescos[0] === undefined
          ? null
          : {
              startedAt: new Date(refrescos[0].started_at).toISOString(),
              ok: refrescos[0].ok,
              error: refrescos[0].error,
              trigger: refrescos[0].trigger,
            },
    };
  } catch (fallo) {
    return { error: fallo instanceof Error ? fallo.message : String(fallo) };
  } finally {
    await client.end().catch(() => undefined);
  }
};

const revisarDisco = async () => {
  try {
    const info = await statfs(resolve(ROOT));
    const libre = Number(info.bavail) * Number(info.bsize);
    const total = Number(info.blocks) * Number(info.bsize);
    return { libre, total, porcentaje: total === 0 ? 0 : Math.round((libre / total) * 100) };
  } catch (fallo) {
    return { error: fallo instanceof Error ? fallo.message : String(fallo) };
  }
};

const estadoDelModoTest = (entorno) =>
  resolveTestMode({
    nodeEnv: entorno.NODE_ENV ?? process.env.NODE_ENV ?? 'development',
    testMode: (entorno.TEST_MODE ?? process.env.TEST_MODE ?? 'false') === 'true',
    allowTestMode: (entorno.ALLOW_TEST_MODE ?? process.env.ALLOW_TEST_MODE ?? 'false') === 'true',
  });

/** Una foto completa del sistema. */
export const tomarFoto = async () => {
  const entorno = entornoRaiz();
  const servicios = sinServicios
    ? { servicios: [], puertoGateway: puertoDe(PROCESOS[PROCESOS.length - 1], entorno) }
    : await revisarServicios(entorno);

  const datos = await revisarDatos();
  const [bases, cola, envios, reportes, disco] = await Promise.all([
    revisarBases(entorno, datos),
    revisarCola(),
    revisarEnvios(),
    revisarReportes(),
    revisarDisco(),
  ]);

  return {
    generadoEn: ahora().toISOString(),
    modoTest: estadoDelModoTest(entorno),
    servicios: servicios.servicios,
    bases,
    cola,
    outbox: datos,
    envios,
    reportes,
    disco,
  };
};

// ── Presentación ──────────────────────────────────────────────────────────────

const tablero = (foto) => {
  const problemas = alertasDe(foto);
  const lineas = [];

  lineas.push('');
  lineas.push(
    color.titulo(
      `OdontoCRM · estado del sistema · ${new Date(foto.generadoEn).toLocaleString('es-VE', { timeZone: 'America/Caracas' })}`,
    ),
  );

  if (foto.modoTest.enabled) {
    lineas.push(
      `  ${color.aviso('! MODO TEST activo')}: los datos son ficticios y los envíos están bloqueados.`,
    );
  }

  if (!sinServicios) {
    lineas.push('');
    lineas.push(color.titulo('── Servicios ─────────────────────────────────────────────────────'));
    for (const servicio of foto.servicios) {
      const marca = servicio.arriba && servicio.listo ? color.ok('✔') : color.error('✖');
      const estado = servicio.arriba
        ? `health ${String(servicio.health.status)} (${String(servicio.health.ms)} ms) · ready ${String(servicio.ready.status)} (${String(servicio.ready.ms)} ms)`
        : `sin respuesta (${servicio.health.error ?? `HTTP ${String(servicio.health.status)}`})`;
      const version = servicio.health.cuerpo?.version;
      const uptime = servicio.health.cuerpo?.uptimeSeconds;
      lineas.push(
        `  ${marca} ${servicio.name.padEnd(14)} ${String(servicio.port).padEnd(5)} ${estado}` +
          (version === undefined ? '' : ` · v${String(version)}`) +
          (uptime === undefined
            ? ''
            : ` · ↑ ${hace(new Date(Date.now() - Number(uptime) * 1000).toISOString()).replace('hace ', '')}`),
      );
      for (const fallo of servicio.fallos) {
        lineas.push(
          `      ${color.error('✖')} ${fallo.name}: ${String(fallo.message ?? 'sin detalle')}`,
        );
      }
    }
  }

  lineas.push('');
  lineas.push(color.titulo('── Bases de datos ────────────────────────────────────────────────'));
  if (foto.bases.error !== undefined) {
    lineas.push(`  ${color.error('✖')} ${String(foto.bases.error)}`);
  } else {
    lineas.push(
      `  ${color.ok('✔')} ${foto.bases.version} en ${foto.bases.host} · ${String(foto.bases.conexiones)} conexión(es)`,
    );
    lineas.push(
      `    ${foto.bases.bases.map((base) => `${base.base.replace('odonto_', '')} ${bytes(base.bytes)}`).join(' · ')}`,
    );
  }

  lineas.push('');
  lineas.push(color.titulo('── Cola de eventos ───────────────────────────────────────────────'));
  if (foto.cola.error !== undefined) {
    lineas.push(`  ${color.error('✖')} ${String(foto.cola.error)}`);
  } else if (foto.cola.colas.length === 0) {
    lineas.push(`  ${color.tenue('(sin trabajos: nadie ha publicado todavía)')}`);
  } else {
    for (const cola of foto.cola.colas) {
      const mal = cola.fallidos > 0;
      const retraso =
        cola.pendientes > 0 && cola.masAntiguo !== null
          ? `, el más antiguo ${hace(cola.masAntiguo)}`
          : '';
      lineas.push(
        `  ${mal ? color.error('✖') : color.ok('✔')} ${cola.name.padEnd(28)} ` +
          `${String(cola.pendientes)} pendiente(s), ${String(cola.fallidos)} fallido(s), ${String(cola.completados)} completado(s)${retraso}`,
      );
    }
  }

  lineas.push('');
  lineas.push(color.titulo('── Outbox (eventos sin publicar) ─────────────────────────────────'));
  for (const outbox of foto.outbox) {
    if (outbox.error !== undefined) {
      lineas.push(`  ${color.error('✖')} ${outbox.name.padEnd(14)} ${String(outbox.error)}`);
      continue;
    }
    const marca = outbox.pendientes === 0 ? color.ok('✔') : color.aviso('!');
    const detalle =
      outbox.pendientes === 0
        ? 'todo publicado'
        : `${String(outbox.pendientes)} pendiente(s)${outbox.masAntiguo === null ? '' : `, el más antiguo ${hace(outbox.masAntiguo)}`}${outbox.reintentando > 0 ? `, ${String(outbox.reintentando)} con reintentos` : ''}`;
    lineas.push(`  ${marca} ${outbox.name.padEnd(14)} ${detalle}`);
  }

  lineas.push('');
  lineas.push(color.titulo('── Notificaciones y reportes ─────────────────────────────────────'));
  if (foto.envios?.error === undefined && foto.envios !== undefined) {
    lineas.push(
      `  ${color.ok('✔')} envíos: ${String(foto.envios.enCola)} en cola · ${String(foto.envios.fallidos)} fallidos · ${String(foto.envios.sinCanal)} sin canal`,
    );
  }
  if (foto.reportes?.error === undefined && foto.reportes !== undefined) {
    lineas.push(
      `  ${color.ok('✔')} reportes: ${String(foto.reportes.eventosProyectados)} evento(s) proyectado(s)` +
        (foto.reportes.ultimoRefresco === null
          ? ''
          : ` · último refresco ${hace(foto.reportes.ultimoRefresco.startedAt)} (${String(foto.reportes.ultimoRefresco.trigger)})${foto.reportes.ultimoRefresco.ok ? '' : ' FALLÓ'}`),
    );
  }

  lineas.push('');
  lineas.push(color.titulo('── Alertas ───────────────────────────────────────────────────────'));
  if (problemas.length === 0) {
    lineas.push(`  ${color.ok('✔')} nada que reportar.`);
  } else {
    for (const problema of problemas) lineas.push(`  ${color.error('✖')} ${problema}`);
  }
  lineas.push('');

  return lineas.join('\n');
};

const imprimirAlertas = (foto) => {
  const problemas = alertasDe(foto);
  if (comoJson) {
    console.log(JSON.stringify({ generadoEn: foto.generadoEn, problemas }, null, 2));
    return problemas.length;
  }
  if (problemas.length === 0) {
    if (!soloAlertas)
      console.log(
        `${color.ok('✔')} todo en orden (${new Date(foto.generadoEn).toLocaleString('es-VE', { timeZone: 'America/Caracas' })})`,
      );
    return 0;
  }
  console.log(
    `${color.error('✖')} ${String(problemas.length)} problema(s) · ${new Date(foto.generadoEn).toLocaleString('es-VE', { timeZone: 'America/Caracas' })}`,
  );
  for (const problema of problemas) console.log(`  · ${problema}`);
  return problemas.length;
};

const main = async () => {
  const foto = await tomarFoto();

  if (soloAlertas) {
    const total = imprimirAlertas(foto);
    process.exitCode = total === 0 ? 0 : 1;
    return;
  }

  if (comoJson) {
    console.log(JSON.stringify(foto, null, 2));
    return;
  }

  console.log(tablero(foto));
};

await main();

if (vigilarSegundos > 0) {
  // Modo vigilancia: repite la foto cada N segundos hasta que lo cortes (Ctrl+C).
  setInterval(() => {
    void tomarFoto().then((foto) => {
      console.log(tablero(foto));
    });
  }, vigilarSegundos * 1000);
}

export { sinColor };
