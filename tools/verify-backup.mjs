#!/usr/bin/env node
/**
 * **Simulacro de restauración** (mejora 4.A del plan post-Fase 11).
 *
 * ```
 * npm run verify:backup                          # el respaldo más reciente
 * npm run verify:backup -- --from /var/backups/odontocrm/2026-10-06
 * npm run verify:backup -- --db odonto_billing   # solo una base
 * npm run verify:backup -- --estado              # qué respaldos hay, sin restaurar nada
 * npm run verify:backup -- --sin-aviso           # no manda el aviso al administrador
 * ```
 *
 * **Qué demuestra.** Un respaldo que nunca se ha restaurado es una carpeta con archivos: lo
 * único que se sabe es que ocupa espacio. Esto restaura el respaldo entero en bases
 * **temporales**, comprueba que los datos están y las borra. Si eso funciona, la clínica
 * puede dormir; si no, es mejor saberlo hoy que el día que haga falta.
 *
 * **No toca nada de producción.** Las bases de prueba se llaman
 * `odonto_verify_<base>_<marca>` y se borran siempre (también cuando algo falla), así que un
 * simulacro cortado a mitad no deja basura. Es la razón de que se pueda dejar en un
 * temporizador.
 *
 * **Por qué en Node y no en `bash`.** El respaldo y la restauración real son guiones de
 * shell del servidor Fedora, pero el simulacro tiene que correr también en la máquina de
 * Windows (donde el respaldo lo hace `odontocrm-backup.ps1` y no hay `bash`). Este
 * herramienta lee el respaldo, no lo produce: el mismo `.dump` lo entiende `pg_restore` en
 * cualquier sistema.
 *
 * **Se puede importar** (para las pruebas del mapa de tablas): el trabajo solo se ejecuta si
 * este archivo es el que arrancó Node. Por eso todo vive dentro de `main()`.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import pg from 'pg';

import { enviarAvisoAdmin } from './lib/alerta-admin.mjs';
import { entornoRaiz, leerEnv, ROOT } from './lib/servicios.mjs';

const { Client } = pg;

/* ── Opciones ─────────────────────────────────────────────────────────────── */

const args = process.argv.slice(2);
const valorDe = (nombre) => {
  const directo = args.find((arg) => arg.startsWith(`${nombre}=`));
  if (directo !== undefined) return directo.slice(nombre.length + 1);
  const indice = args.indexOf(nombre);
  return indice === -1 ? undefined : args[indice + 1];
};

if (args.includes('--ayuda') || args.includes('--help')) {
  console.log(
    'Uso: npm run verify:backup [-- --from DIR | --db NOMBRE | --estado | --sin-aviso]\n\n' +
      '  --from DIR     respaldo a probar (por defecto, el más reciente)\n' +
      '  --dest DIR     dónde viven los respaldos (por defecto, el del sistema)\n' +
      '  --db NOMBRE    verifica solo esa base (repetible; vale `patients` u `odonto_patients`)\n' +
      '  --estado       lista los respaldos y no restaura nada\n' +
      '  --sin-aviso    no manda el aviso al administrador si falla\n' +
      '  --conservar    no borra las bases temporales (para mirarlas a mano)\n',
  );
  process.exit(0);
}

const soloEstado = args.includes('--estado');
const sinAviso = args.includes('--sin-aviso');
const conservar = args.includes('--conservar');
const desde = valorDe('--from');
const destino = valorDe('--dest');
const soloBases = args
  .map((arg, indice) =>
    arg === '--db' ? args[indice + 1] : arg.startsWith('--db=') ? arg.slice(5) : undefined,
  )
  .filter((valor) => valor !== undefined && valor !== '');

/* ── Dónde están los respaldos ─────────────────────────────────────────────── */

const ES_WINDOWS = process.platform === 'win32';

/**
 * Carpeta de respaldos del sistema. En Windows el respaldo lo hace `odontocrm-backup.ps1`
 * dentro de `C:\ProgramData\OdontoCRM\backups`; en Fedora, el guion de shell en
 * `/var/backups/odontocrm`. `--dest` (o `ODONTOCRM_BACKUP_DIR`) manda sobre las dos.
 */
const carpetaDeRespaldos = () =>
  destino ??
  process.env['ODONTOCRM_BACKUP_DIR'] ??
  (ES_WINDOWS
    ? join(process.env.ProgramData ?? 'C:\\ProgramData', 'OdontoCRM', 'backups')
    : '/var/backups/odontocrm');

/** Los directorios con nombre `AAAA-MM-DD`, del más nuevo al más viejo. */
const respaldosDisponibles = (raiz) => {
  if (!existsSync(raiz)) return [];
  return readdirSync(raiz, { withFileTypes: true })
    .filter((entrada) => entrada.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entrada.name))
    .map((entrada) => ({ nombre: entrada.name, dir: join(raiz, entrada.name) }))
    .sort((a, b) => b.nombre.localeCompare(a.nombre));
};

/* ── Las bases del respaldo ────────────────────────────────────────────────── */

/**
 * Tabla de control de cada base: la que dice que los datos del dominio están ahí.
 *
 * Es una lista **corta y explícita** a propósito —una tabla por base, la más representativa—
 * y no «todas las tablas»: lo que se quiere saber es si el respaldo tiene datos de verdad,
 * no un inventario. Si la tabla no existe en lo restaurado, el simulacro **falla**: eso
 * significa que el respaldo es de un esquema anterior o que el dump se cortó, y las dos
 * cosas hay que saberlas.
 *
 * `verify-backup.test.ts` comprueba que estas tablas existen en el `schema.ts` de su
 * servicio, así que no se quedan viejas en silencio.
 */
export const TABLA_DE_CONTROL = {
  odonto_identity: 'users',
  odonto_patients: 'patients',
  odonto_scheduling: 'appointments',
  odonto_notifications: 'notifications',
  odonto_clinical: 'clinical_sessions',
  odonto_odontogram: 'tooth_findings',
  odonto_screens: 'screen_devices',
  odonto_reporting: 'processed_events',
  // La caja: la factura es lo que no se puede perder de una facturación.
  odonto_billing: 'invoices',
  // La base de eventos es de `pg-boss` y no tiene tablas del dominio: su control es la
  // propia tabla de trabajos (que exista significa que el esquema de la cola se restauró).
  odonto_events: 'pgboss.job',
};

/* ── Herramientas de PostgreSQL ───────────────────────────────────────────── */

/**
 * Ruta de los binarios de PostgreSQL. En Windows (EDB) no están en el `PATH`, así que se
 * busca en la instalación; en Fedora están en el `PATH` o los dice `--pgbin`.
 */
const PG_BIN = (() => {
  const explicito = valorDe('--pgbin') ?? process.env['ODONTOCRM_PGBIN'] ?? '';
  if (explicito !== '') return explicito;
  if (!ES_WINDOWS) return '';

  const base = 'C:\\Program Files\\PostgreSQL';
  try {
    const versiones = readdirSync(base, { withFileTypes: true })
      .filter((entrada) => entrada.isDirectory() && /^\d+$/.test(entrada.name))
      .map((entrada) => Number(entrada.name))
      .sort((a, b) => b - a);
    return versiones.length === 0 ? '' : join(base, String(versiones[0]), 'bin');
  } catch {
    return '';
  }
})();

const binario = (nombre) => (PG_BIN === '' ? nombre : join(PG_BIN, nombre));

const ejecutar = (nombre, argumentos, opciones = {}) =>
  execFileSync(binario(nombre), argumentos, {
    encoding: 'utf8',
    stdio: opciones.silencioso === true ? ['ignore', 'pipe', 'pipe'] : 'pipe',
    // En Windows `psql`/`pg_restore` son `.exe`: el shell no hace falta, pero las rutas con
    // espacios sí que hay que citarlas (lo hace `execFileSync`).
    ...opciones.extra,
  });

/**
 * `PGPASSWORD`/`PGHOST` para las llamadas a `psql`/`pg_restore`: se le pasan al hijo por
 * entorno (nunca por argumentos, que se ven en la lista de procesos).
 */
const entornoPg = (url) => {
  const partes = new URL(url);
  return {
    ...process.env,
    PGHOST: partes.hostname,
    PGPORT: partes.port === '' ? '5432' : partes.port,
    PGUSER: decodeURIComponent(partes.username),
    PGPASSWORD: decodeURIComponent(partes.password),
    PGDATABASE: partes.pathname.replace(/^\//, ''),
  };
};

/** Ejecuta SQL con el administrador y devuelve las filas. */
const consultar = async (url, sql, parametros) => {
  const cliente = new Client({
    connectionString: url,
    application_name: 'odontocrm-verify-backup',
  });
  await cliente.connect();
  try {
    const { rows } = await cliente.query(sql, parametros);
    return rows;
  } finally {
    await cliente.end().catch(() => undefined);
  }
};

/**
 * La misma URL pero apuntando a otra base.
 *
 * Hace falta porque PostgreSQL **no** permite consultar entre bases: `"otra"."tabla"` se
 * lee como `esquema.tabla`, no como `base.tabla`. Para contar las filas de la base temporal
 * hay que conectarse a ella.
 */
const urlConBase = (url, base) => {
  const partes = new URL(url);
  partes.pathname = `/${base}`;
  return partes.toString();
};

/* ── El simulacro ─────────────────────────────────────────────────────────── */

const urlAdmin = (() => {
  const delEntorno = entornoRaiz().PG_ADMIN_URL ?? leerEnv('.env').PG_ADMIN_URL;
  return (delEntorno ?? '').trim();
})();

const marca = String(Date.now()).slice(-6);
const temporales = [];

const log = (texto = '') => console.log(texto);
const ok = (texto) => console.log(`  ✔ ${texto}`);
const aviso = (texto) => console.log(`  ! ${texto}`);
const fallo = (texto) => console.error(`  ✖ ${texto}`);

const revisarSumas = (dir) => {
  const archivo = join(dir, 'SHA256SUMS');
  if (!existsSync(archivo)) return { comprobado: false, motivo: 'no hay SHA256SUMS' };

  const lineas = readFileSync(archivo, 'utf8')
    .split(/\r?\n/)
    .map((linea) => linea.trim())
    .filter((linea) => linea !== '');
  if (lineas.length === 0) return { comprobado: false, motivo: 'SHA256SUMS está vacío' };

  // `sha256sum --check` es el mismo binario en Linux y en el Git Bash de Windows… pero no
  // existe en Windows, así que la comprobación se hace aquí con Node (que sí está).
  const discrepancias = [];
  let revisados = 0;
  for (const linea of lineas) {
    const coincidencia = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(linea);
    if (coincidencia === null) continue;
    const [, esperada, nombre] = coincidencia;
    const ruta = join(dir, nombre.trim());
    if (!existsSync(ruta)) {
      discrepancias.push(`${nombre} (no está)`);
      continue;
    }
    // El hash se calcula en Node para no depender de `sha256sum` (no existe en Windows).
    const real = createHash('sha256').update(readFileSync(ruta)).digest('hex');
    revisados += 1;
    if (real !== esperada.toLowerCase()) discrepancias.push(nombre);
  }
  return { comprobado: true, revisados, discrepancias };
};

/** Restaura un `.dump` en una base temporal y cuenta la tabla de control. */
const probarBase = async (dir, base) => {
  const archivo = join(dir, `${base}.dump`);
  if (!existsSync(archivo)) return { base, estado: 'ausente', detalle: 'el .dump no está' };

  const temporal = `odonto_verify_${base.replace(/^odonto_/, '')}_${marca}`;
  const bytes = statSync(archivo).size;
  temporales.push(temporal);

  // 1. La base temporal, vacía y sin plantilla (para no arrastrar nada de la de verdad).
  await consultar(urlAdmin, `drop database if exists "${temporal}" with (force)`);
  await consultar(urlAdmin, `create database "${temporal}" template template0`);

  // 2. La restauración. `--exit-on-error` es la comprobación fuerte: cualquier objeto que
  //    no se pueda crear aborta, y un respaldo a medias no pasa de aquí.
  try {
    ejecutar(
      'pg_restore',
      [`--dbname=${temporal}`, '--no-owner', '--exit-on-error', '--no-comments', archivo],
      { extra: { env: entornoPg(urlAdmin), stdio: ['ignore', 'pipe', 'pipe'] } },
    );
  } catch (error) {
    const salida = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim();
    await consultar(urlAdmin, `drop database if exists "${temporal}" with (force)`);
    return {
      base,
      estado: 'fallo',
      detalle: `pg_restore falló: ${salida.split('\n').slice(-3).join(' · ') || 'sin detalle'}`,
      bytes,
    };
  }

  // 3. La tabla de control tiene que estar **y** tener el esquema que se esperaba.
  const control = TABLA_DE_CONTROL[base];
  if (control === undefined) {
    aviso(`${base}: sin tabla de control declarada (se comprueba solo que restaure)`);
    return {
      base,
      estado: 'ok',
      detalle: 'restaurada (sin control declarado)',
      bytes,
      filas: null,
    };
  }

  const [esquema, tabla] = control.includes('.') ? control.split('.') : ['public', control];
  try {
    const filas = await consultar(
      urlConBase(urlAdmin, temporal),
      `select count(1)::int as total from "${esquema}"."${tabla}"`,
    );
    return {
      base,
      estado: 'ok',
      detalle: `${control}: ${String(filas[0]?.total ?? 0)} fila(s)`,
      bytes,
      filas: filas[0]?.total ?? 0,
    };
  } catch (error) {
    return {
      base,
      estado: 'fallo',
      detalle: `la tabla de control ${control} no está: ${error instanceof Error ? error.message : String(error)}`,
      bytes,
    };
  } finally {
    if (!conservar) {
      await consultar(urlAdmin, `drop database if exists "${temporal}" with (force)`);
    }
  }
};

/* ── Ejecución ────────────────────────────────────────────────────────────── */

/**
 * Qué bases trae el respaldo. El `manifest.txt` es la fuente buena —lo escribe el respaldo y
 * declara lo que de verdad se volcó—; si no está (un respaldo copiado a mano, o de una
 * versión anterior), se deducen de los `.dump`, que para el caso es lo mismo.
 */
const basesDelRespaldo = (dir) => {
  const manifiesto = join(dir, 'manifest.txt');
  if (!existsSync(manifiesto)) {
    aviso('no hay manifest.txt: se descubren las bases por los archivos .dump');
    return readdirSync(dir)
      .filter((nombre) => nombre.endsWith('.dump'))
      .map((nombre) => nombre.replace(/\.dump$/, ''));
  }

  const linea = /^bases=(.*)$/m.exec(readFileSync(manifiesto, 'utf8'))?.[1] ?? '';
  const declaradas = linea.split(/\s+/).filter((nombre) => nombre !== '');
  log(`manifiesto: ${String(declaradas.length)} base(s) · ${linea}`);
  return declaradas;
};

/**
 * ¿El nombre que pidió `--db` es esta base? Valen las dos formas: el nombre completo
 * (`odonto_patients`) y el corto (`patients`). Lo corto es lo que uno escribe de memoria, y
 * fallar por eso —«ninguna base que probar»— no ayuda a nadie.
 */
const nombraA = (pedida, base) => pedida === base || `odonto_${pedida}` === base;

/**
 * El simulacro. Todo el trabajo vive aquí para que el módulo se pueda **importar** (las
 * pruebas necesitan `TABLA_DE_CONTROL`) sin que arranque una restauración de verdad.
 *
 * Devuelve el código de salida; quien llama decide qué hacer con él.
 */
export const main = async () => {
  const raiz = carpetaDeRespaldos();
  const disponibles = respaldosDisponibles(raiz);

  /**
   * El respaldo a probar: el que diga `--from`, o **el más reciente** de la carpeta del
   * sistema. Un `--from` explícito vale aunque esa carpeta esté vacía o no exista —es el caso
   * de probar un respaldo que alguien copió a otro sitio—, así que el aviso de «no hay
   * respaldos» solo aparece cuando de verdad no hay ninguno que elegir.
   */
  const elegido =
    desde === undefined
      ? disponibles[0]
      : {
          nombre: desde.split(/[\\/]/).filter(Boolean).pop() ?? desde,
          dir: isAbsolute(desde) ? desde : resolve(ROOT, desde),
        };

  if (elegido === undefined) {
    console.error(`\n✖ no hay respaldos en ${raiz}`);
    console.error('  Si esta máquina respalda a otro sitio, pásalo con --dest DIR.');
    return 1;
  }

  if (desde === undefined) {
    // Solo tiene sentido listar cuando se elige por fecha: con `--from` ya se sabe cuál es.
    log(`\nrespaldo${' '.repeat(8)}carpeta`);
    for (const respaldo of disponibles.slice(0, 10)) {
      log(`  ${respaldo.nombre}     ${respaldo.dir}`);
    }
    if (disponibles.length > 10) log(`  … y ${String(disponibles.length - 10)} más`);
  }

  if (soloEstado) {
    log(
      `\n${String(disponibles.length)} respaldo(s) en ${raiz}. Usa --from DIR para probar uno.\n`,
    );
    return 0;
  }

  if (!existsSync(elegido.dir)) {
    console.error(`\n✖ no existe el respaldo ${elegido.dir}`);
    return 1;
  }

  log(`\n── Simulacro de restauración ─────────────────────────────────────`);
  log(`respaldo: ${elegido.dir}`);

  const basesDeclaradas = basesDelRespaldo(elegido.dir);

  const bases =
    soloBases.length > 0
      ? basesDeclaradas.filter((base) => soloBases.some((pedida) => nombraA(pedida, base)))
      : basesDeclaradas;
  if (bases.length === 0) {
    console.error(
      `✖ ninguna base que probar: --db ${soloBases.join(', ')} no está en el respaldo\n` +
        `  (trae: ${basesDeclaradas.join(', ')})`,
    );
    return 1;
  }

  const sumas = revisarSumas(elegido.dir);
  if (sumas.comprobado) {
    if (sumas.discrepancias.length === 0) {
      ok(`sumas SHA-256 correctas (${String(sumas.revisados)} archivo(s))`);
    } else {
      fallo(`sumas SHA-256 que NO cuadran: ${sumas.discrepancias.join(', ')}`);
    }
  } else {
    aviso(`sumas SHA-256: ${sumas.motivo}`);
  }

  if (urlAdmin === '') {
    console.error(
      '\n✖ falta PG_ADMIN_URL (en el .env de la raíz o en el entorno): sin administrador de\n' +
        '  PostgreSQL no se pueden crear las bases temporales del simulacro.',
    );
    return 1;
  }

  log(`\nrestaurando ${String(bases.length)} base(s) en bases temporales (se borran al terminar)…`);
  const resultados = [];
  for (const base of bases) {
    const resultado = await probarBase(elegido.dir, base);
    resultados.push(resultado);
    if (resultado.estado === 'ok') ok(`${base}  ${resultado.detalle}`);
    else if (resultado.estado === 'ausente') aviso(`${base}  ${resultado.detalle}`);
    else fallo(`${base}  ${resultado.detalle}`);
  }

  // Red de seguridad: si algo se cortó antes de entrar en el `finally` de cada base, se
  // limpian las temporales que queden (el simulacro no puede ensuciar el servidor).
  if (!conservar) {
    for (const temporal of temporales) {
      await consultar(urlAdmin, `drop database if exists "${temporal}" with (force)`).catch(
        () => undefined,
      );
    }
  }

  const fallidas = resultados.filter((resultado) => resultado.estado === 'fallo');
  const ausentes = resultados.filter((resultado) => resultado.estado === 'ausente');
  const correctas = resultados.filter((resultado) => resultado.estado === 'ok');

  log(
    `\nresumen: ${String(correctas.length)} correcta(s) · ${String(fallidas.length)} con fallo · ` +
      `${String(ausentes.length)} ausente(s)`,
  );
  if (!sumas.comprobado || (sumas.discrepancias?.length ?? 0) > 0) {
    log('las sumas SHA-256 no se pudieron dar por buenas (ver arriba)');
  }

  const huboFallo =
    fallidas.length > 0 || (sumas.comprobado && (sumas.discrepancias?.length ?? 0) > 0);

  if (huboFallo && !sinAviso) {
    const detalle = [
      ...fallidas.map((resultado) => `· ${resultado.base}: ${resultado.detalle}`),
      ...(sumas.comprobado && (sumas.discrepancias?.length ?? 0) > 0
        ? [`· las sumas SHA-256 no cuadran: ${(sumas.discrepancias ?? []).join(', ')}`]
        : []),
    ].join('\n');

    const avisoEnviado = await enviarAvisoAdmin({
      level: 'critical',
      title: 'El respaldo NO se pudo restaurar',
      detail:
        'El simulacro de restauración falló: el respaldo de esta máquina no está sirviendo\n' +
        'para recuperar los datos. Hay que mirarlo antes de necesitarlo de verdad.\n\n' +
        detalle,
      source: 'verify-backup',
      context: { respaldo: elegido.nombre, basesProbadas: bases.length },
    });
    if (!avisoEnviado.enviado) {
      aviso(`el aviso no salió: ${String(avisoEnviado.motivo ?? '')}`);
    }
  }

  log('');
  return huboFallo ? 1 : 0;
};

/**
 * Solo se ejecuta si **este archivo arrancó Node**. Así el módulo se puede importar (las
 * pruebas leen `TABLA_DE_CONTROL`) sin que importar dispare una restauración de verdad, que
 * es exactamente lo que pasaba antes.
 */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
