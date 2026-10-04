#!/usr/bin/env node
/**
 * Auditoría de conexiones: revisa de una pasada que todo lo construido esté
 * conectado como debe. Es la herramienta que se usó antes de la Fase 6
 * (`docs/AUDITORIA_PRE_FASE_6.md`) y sirve para repetirla en cada fase.
 *
 *   npm run audit                     → todo
 *   npm run audit -- --solo eventos   → una sección (eventos|http|permisos|datos)
 *
 * Qué comprueba:
 *  1. **eventos**: cada tema del catálogo, quién lo publica y quién lo escucha.
 *  2. **http**: rutas de los servicios ↔ prefijos del gateway ↔ llamadas de la web,
 *     y que las rutas internas no queden expuestas.
 *  3. **permisos y configuración**: permisos que ninguna ruta exige y variables que
 *     los servicios leen sin estar en `.env.example`.
 *  4. **datos**: cada base accesible y migrada, outbox sin atascos y trabajos
 *     muertos en la cola compartida.
 *
 * Termina con un resumen. Sale con código 1 solo si hay algo **estructural**
 * (ruta inalcanzable, ruta interna expuesta, outbox atascado o cola con basura);
 * lo que aún no existe porque es de una fase futura se informa aparte.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const METODOS_HTTP = ['get', 'post', 'put', 'patch', 'delete'];

/** Servicios que aún no existen: su contrato está listo y no cuentan como fallo. */
const FASES_FUTURAS = {
  servicios: [],
  permisos: [],
};

/** Variables que genera `db:bootstrap` en cada servicio (no van en la plantilla). */
const GENERADAS = new Set([
  'DATABASE_URL',
  'EVENTS_DATABASE_URL',
  'INTERNAL_SERVICE_SECRET',
  'COOKIE_SECRET',
  'TELEGRAM_BOT_TOKEN',
  'WHATSAPP_TOKEN',
  'WHATSAPP_PHONE_ID',
  'WHATSAPP_VERIFY_TOKEN',
  'WHATSAPP_APP_SECRET',
]);

const estructurables = [];
const pendientes = [];
const deuda = [];
const seccion = (titulo) => console.log(`\n${'─'.repeat(76)}\n${titulo}\n${'─'.repeat(76)}`);

const archivosDe = (dir, filtro = /\.tsx?$/) => {
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return [];
  const salida = [];
  for (const entrada of readdirSync(dir)) {
    const camino = join(dir, entrada);
    if (statSync(camino).isDirectory()) salida.push(...archivosDe(camino, filtro));
    else if (filtro.test(camino) && !/\.test\./.test(camino)) salida.push(camino);
  }
  return salida;
};

const servicios = readdirSync(join(ROOT, 'services')).filter((nombre) =>
  statSync(join(ROOT, 'services', nombre)).isDirectory(),
);

/* ── 1) Eventos ────────────────────────────────────────────────────────────── */

const auditarEventos = () => {
  seccion('1 · Eventos (catálogo ↔ productores ↔ consumidores)');

  const fuente = readFileSync(join(ROOT, 'packages/events/src/topics.ts'), 'utf8');
  const cuerpo = /export const EVENT_TOPICS = \{([\s\S]*?)\} as const;/.exec(fuente)?.[1] ?? '';
  const temas = [...cuerpo.matchAll(/^\s*(\w+):\s*'([^']+)'/gm)].map(([, nombre, topic]) => ({
    nombre,
    topic,
  }));

  const usos = new Map(
    temas.map(({ nombre }) => [
      nombre,
      { productores: new Set(), consumidores: new Set(), mencionado: false },
    ]),
  );

  for (const servicio of servicios) {
    for (const archivo of archivosDe(join(ROOT, 'services', servicio, 'src'))) {
      const lineas = readFileSync(archivo, 'utf8').split('\n');
      lineas.forEach((linea, indice) => {
        const coincidencia = /EVENT_TOPICS\.(\w+)/.exec(linea);
        if (coincidencia === null) return;
        const registro = usos.get(coincidencia[1]);
        if (registro === undefined) {
          estructurables.push(
            `Evento desconocido en ${relative(ROOT, archivo)}: EVENT_TOPICS.${coincidencia[1]}`,
          );
          return;
        }
        registro.mencionado = true;
        const ventana = lineas.slice(Math.max(0, indice - 2), indice + 3).join('\n');
        if (/topic:\s*EVENT_TOPICS\.|topic:\s*input\.topic/.test(ventana))
          registro.productores.add(servicio);
        else if (
          /includes\(|case |Record<|templatesByTopic|TEMAS_QUE|\bif \(event\.eventType/.test(
            ventana,
          ) ||
          /consumer/i.test(archivo)
        )
          registro.consumidores.add(servicio);
      });
    }
  }

  // La auditoría de identity convierte en filas cualquier evento con la forma genérica.
  const auditadosPorFormaGenerica = (topic) =>
    !topic.startsWith('identity.') && !topic.startsWith('notifications.message');

  const tabla = [];
  for (const { nombre, topic } of temas) {
    const registro = usos.get(nombre);
    tabla.push({
      topic,
      produce: [...registro.productores].join(',') || '—',
      consume:
        [...registro.consumidores].join(',') ||
        (auditadosPorFormaGenerica(topic) ? 'auditoría' : '—'),
      mencionado: registro.mencionado,
      // La clínica (Fase 6A) y el odontograma (Fase 6B) ya existen: sus temas se
      // publican de verdad y no se excusan como «de fase futura».
      esDeFaseFutura: FASES_FUTURAS.servicios.some((servicio) => topic.startsWith(`${servicio}.`)),
    });
  }

  const ancho = Math.max(...tabla.map((fila) => fila.topic.length));
  console.log('TEMA'.padEnd(ancho + 2) + 'PRODUCE'.padEnd(14) + 'CONSUME');
  for (const fila of tabla) {
    if (!fila.mencionado) continue;
    console.log(fila.topic.padEnd(ancho + 2) + fila.produce.padEnd(14) + fila.consume);
  }

  const publicadosSinConsumidor = tabla.filter(
    (fila) => fila.produce !== '—' && fila.consume === '—' && !fila.esDeFaseFutura,
  );
  for (const fila of publicadosSinConsumidor) {
    estructurables.push(`Se publica ${fila.topic} y no lo consume nadie (ni la auditoría)`);
  }

  const sinPublicar = tabla.filter((fila) => !fila.mencionado);
  const futuros = sinPublicar.filter((fila) => fila.esDeFaseFutura);
  const huerfanos = sinPublicar.filter((fila) => !fila.esDeFaseFutura);
  console.log(
    `\n${String(tabla.filter((f) => f.mencionado).length)} temas en uso · ${String(futuros.length)} declarados para fases futuras · ${String(huerfanos.length)} declarados sin usar`,
  );
  for (const fila of huerfanos) deuda.push(`Tema declarado y sin publicar: ${fila.topic}`);
  if (publicadosSinConsumidor.length === 0)
    console.log('Sin temas publicados a los que les falte consumidor ✔');
};

/* ── 2) HTTP ───────────────────────────────────────────────────────────────── */

const auditarHttp = () => {
  seccion('2 · HTTP (servicios ↔ gateway ↔ interfaz)');

  const prefijos = [
    ...readFileSync(join(ROOT, 'apps/gateway/src/routes.ts'), 'utf8').matchAll(
      /add\(\s*'([^']+)'/g,
    ),
  ].map(([, prefijo]) => prefijo);
  const cubierta = (ruta) =>
    prefijos.some(
      (prefijo) => ruta === prefijo || ruta.startsWith(`${prefijo}/`) || ruta.startsWith(prefijo),
    );

  const rutas = [];
  for (const servicio of servicios) {
    for (const archivo of archivosDe(join(ROOT, 'services', servicio, 'src'))) {
      readFileSync(archivo, 'utf8')
        .split('\n')
        .forEach((linea, indice) => {
          for (const metodo of METODOS_HTTP) {
            const coincidencia = new RegExp(`app\\.${metodo}\\(\\s*\\n?\\s*'([^']+)'`).exec(linea);
            if (coincidencia !== null)
              rutas.push({
                servicio,
                metodo,
                ruta: coincidencia[1],
                archivo: relative(ROOT, archivo),
                linea: indice + 1,
              });
          }
        });
    }
  }

  const publicas = rutas.filter((ruta) => !ruta.ruta.startsWith('/internal/'));
  const internas = rutas.filter((ruta) => ruta.ruta.startsWith('/internal/'));
  const sinPrefijo = publicas.filter(
    (ruta) => !cubierta(ruta.ruta) && ruta.ruta !== '/health' && ruta.ruta !== '/ready',
  );
  const expuestas = internas.filter((ruta) => cubierta(ruta.ruta));

  console.log(
    `Prefijos del gateway: ${String(prefijos.length)} · rutas públicas: ${String(publicas.length)} · internas: ${String(internas.length)}`,
  );
  for (const ruta of sinPrefijo)
    estructurables.push(
      `Ruta inalcanzable: ${ruta.metodo.toUpperCase()} ${ruta.ruta} (${ruta.archivo}:${String(ruta.linea)})`,
    );
  for (const ruta of expuestas)
    estructurables.push(`Ruta interna expuesta por el gateway: ${ruta.ruta} (${ruta.servicio})`);
  if (sinPrefijo.length === 0 && expuestas.length === 0)
    console.log('Todas las rutas alcanzables y ninguna interna expuesta ✔');

  const llamadas = new Set();
  for (const archivo of archivosDe(join(ROOT, 'apps/web/src'))) {
    for (const coincidencia of readFileSync(archivo, 'utf8').matchAll(
      /api\.(?:get|post|put|patch|delete)(?:<[^>]*>)?\(\s*[`'"](\/[^`'"]+)/g,
    )) {
      llamadas.add(`/api/v1${coincidencia[1]}`);
    }
  }
  const webSinRuta = [...llamadas].filter((ruta) => !cubierta(ruta));
  console.log(
    `Llamadas de la interfaz: ${String(llamadas.size)} · sin prefijo en el gateway: ${String(webSinRuta.length)}`,
  );
  for (const ruta of webSinRuta)
    estructurables.push(`La interfaz llama a ${ruta} y el gateway no la enruta`);
  if (llamadas.size > 0 && webSinRuta.length === 0)
    console.log('Toda llamada de la interfaz tiene su ruta ✔');
};

/* ── 3) Permisos y configuración ───────────────────────────────────────────── */

const auditarPermisosYConfig = () => {
  seccion('3 · Permisos y configuración');

  const enums = readFileSync(join(ROOT, 'packages/contracts/src/domain/enums.ts'), 'utf8');
  const bloque = /export const PERMISSIONS = \[([\s\S]*?)\] as const;/.exec(enums)?.[1] ?? '';
  const permisos = [...bloque.matchAll(/'([^']+)'/g)].map(([, permiso]) => permiso);
  const exigidos = new Set();

  for (const servicio of servicios) {
    for (const archivo of archivosDe(join(ROOT, 'services', servicio, 'src'))) {
      for (const coincidencia of readFileSync(archivo, 'utf8').matchAll(/'([a-z]+:[a-z_]+)'/g))
        exigidos.add(coincidencia[1]);
    }
  }

  const sinGuarda = permisos.filter((permiso) => !exigidos.has(permiso));
  const sinGuardaFuturos = sinGuarda.filter((permiso) => FASES_FUTURAS.permisos.includes(permiso));
  const sinGuardaReales = sinGuarda.filter((permiso) => !FASES_FUTURAS.permisos.includes(permiso));
  console.log(
    `Permisos: ${String(permisos.length)} · exigidos por alguna ruta: ${String(permisos.length - sinGuarda.length)} · de fases futuras: ${String(sinGuardaFuturos.length)}`,
  );
  for (const permiso of sinGuardaReales)
    estructurables.push(`Permiso declarado que ninguna ruta exige: ${permiso}`);
  if (sinGuardaReales.length === 0) console.log('Todo permiso vigente se exige en el servidor ✔');

  const plantilla = readFileSync(join(ROOT, '.env.example'), 'utf8');
  const documentadas = new Set(
    [...plantilla.matchAll(/([A-Z][A-Z0-9_]{3,})/g)].map(([, clave]) => clave),
  );
  const noDocumentadas = new Set();

  for (const dir of ['apps/gateway', ...servicios.map((servicio) => `services/${servicio}`)]) {
    const config = join(ROOT, dir, 'src/config.ts');
    if (!statSync(config, { throwIfNoEntry: false })?.isFile()) continue;
    const claves = [...readFileSync(config, 'utf8').matchAll(/^\s{2}([A-Z][A-Z0-9_]*):/gm)].map(
      ([, clave]) => clave,
    );
    for (const clave of claves) {
      if (
        !documentadas.has(clave) &&
        !GENERADAS.has(clave) &&
        !['NODE_ENV', 'LOG_LEVEL', 'TZ'].includes(clave)
      ) {
        noDocumentadas.add(`${clave} (${dir})`);
      }
    }
  }

  console.log(
    `Variables en .env.example: ${String(documentadas.size)} · leídas sin documentar: ${String(noDocumentadas.size)}`,
  );
  for (const clave of [...noDocumentadas].sort()) deuda.push(`Variable sin documentar: ${clave}`);
  if (noDocumentadas.size === 0)
    console.log('Toda variable de configuración está en la plantilla ✔');
};

/* ── 4) Datos y cola ───────────────────────────────────────────────────────── */

const auditarDatos = async () => {
  seccion('4 · Bases de datos y cola compartida');

  const leerEnv = (ruta, clave) => {
    const camino = join(ROOT, ruta);
    if (!existsSync(camino)) return undefined;
    return new RegExp(`^${clave}=(.*)$`, 'm').exec(readFileSync(camino, 'utf8'))?.[1]?.trim();
  };

  const { default: pg } = await import('pg');
  let eventos;

  console.log('SERVICIO        TABLAS  MIGRACIONES  OUTBOX SIN PUBLICAR');
  for (const servicio of servicios) {
    // Las bases de las fases futuras existen pero aún no tienen migraciones: se
    // informan aparte, con una línea, para no ensuciar la tabla.
    if (FASES_FUTURAS.servicios.includes(servicio)) continue;

    const url = leerEnv(`services/${servicio}/.env`, 'DATABASE_URL');
    if (url === undefined) {
      console.log(`${servicio.padEnd(16)}(sin .env)`);
      continue;
    }
    eventos ??= leerEnv(`services/${servicio}/.env`, 'EVENTS_DATABASE_URL');

    const cliente = new pg.Client({
      connectionString: url,
      application_name: 'odontocrm-auditoria',
    });
    try {
      await cliente.connect();
      const tablas = await cliente.query(
        "select count(1)::int as n from information_schema.tables where table_schema='public'",
      );
      const migraciones = await cliente
        .query('select count(1)::int as n from drizzle.__drizzle_migrations')
        .catch(() => ({ rows: [{ n: '—' }] }));
      const outbox = await cliente
        .query('select count(1)::int as n from outbox_events where published_at is null')
        .catch(() => ({ rows: [{ n: '—' }] }));
      const pendientesOutbox = Number(outbox.rows[0].n);
      console.log(
        `${servicio.padEnd(16)}${String(tablas.rows[0].n).padEnd(8)}${String(migraciones.rows[0].n).padEnd(13)}${outbox.rows[0].n}`,
      );
      if (pendientesOutbox > 0)
        estructurables.push(
          `Outbox atascado en ${servicio}: ${String(pendientesOutbox)} evento(s) sin publicar`,
        );
    } catch (error) {
      estructurables.push(
        `No se pudo conectar a la base de ${servicio}: ${error instanceof Error ? error.message.slice(0, 60) : 'error'}`,
      );
    } finally {
      await cliente.end().catch(() => undefined);
    }
  }

  for (const servicio of FASES_FUTURAS.servicios) {
    const url = leerEnv(`services/${servicio}/.env`, 'DATABASE_URL');
    if (url === undefined) {
      pendientes.push(`La base de ${servicio} no tiene .env (ejecuta db:bootstrap)`);
      continue;
    }
    const cliente = new pg.Client({
      connectionString: url,
      application_name: 'odontocrm-auditoria',
    });
    try {
      await cliente.connect();
      console.log(`  ${servicio}: base creada y accesible, sin migraciones todavía (fase futura)`);
    } catch {
      pendientes.push(`La base de ${servicio} existe en .env pero no se pudo conectar`);
    } finally {
      await cliente.end().catch(() => undefined);
    }
  }

  if (eventos === undefined) return;

  const cola = new pg.Client({
    connectionString: eventos,
    application_name: 'odontocrm-auditoria',
  });
  try {
    await cola.connect();
    const resumen = await cola.query(
      'select name, state, count(1)::int as n from pgboss.job group by 1,2 having count(1) > 0 order by 3 desc limit 12',
    );
    console.log('\nCola compartida (pgboss.job):');
    for (const fila of resumen.rows)
      console.log(`  ${String(fila.n).padStart(6)}  ${String(fila.state).padEnd(10)} ${fila.name}`);

    // Trabajos en estado `created` en colas que nadie trabaja: no se borran solos.
    const muertos = await cola.query(
      "select count(1)::int as n from pgboss.job where state = 'created' and name not like 'domain-events.%'",
    );
    if (muertos.rows[0].n > 0) {
      estructurables.push(
        `Cola con ${String(muertos.rows[0].n)} trabajo(s) en 'created' que nadie procesará (nadie trabaja esa cola)`,
      );
    } else {
      console.log('Sin trabajos muertos en colas sin trabajador ✔');
    }
  } catch (error) {
    pendientes.push(
      `No se pudo leer la cola compartida: ${error instanceof Error ? error.message.slice(0, 60) : 'error'}`,
    );
  } finally {
    await cola.end().catch(() => undefined);
  }
};

/* ── Ejecución ─────────────────────────────────────────────────────────────── */

const solo = (() => {
  const indice = process.argv.indexOf('--solo');
  return indice === -1 ? undefined : process.argv[indice + 1];
})();

if (solo === undefined || solo === 'eventos') auditarEventos();
if (solo === undefined || solo === 'http') auditarHttp();
if (solo === undefined || solo === 'permisos') auditarPermisosYConfig();
if (solo === undefined || solo === 'datos') await auditarDatos();

console.log(`\n${'═'.repeat(76)}`);
if (estructurables.length > 0) {
  console.error(`✖ ${String(estructurables.length)} problema(s) estructural(es):`);
  for (const problema of estructurables) console.error(`  · ${problema}`);
} else {
  console.log('✔ Sin problemas estructurales: las conexiones están como deben.');
}
if (deuda.length > 0) {
  console.log(`\nDeuda anotada (no bloquea): ${String(deuda.length)}`);
  for (const punto of deuda) console.log(`  · ${punto}`);
}
if (pendientes.length > 0) {
  console.log(`\nPendiente por fase futura: ${String(pendientes.length)}`);
  for (const punto of pendientes) console.log(`  · ${punto}`);
}
process.exit(estructurables.length > 0 ? 1 : 0);
