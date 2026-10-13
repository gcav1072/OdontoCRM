/**
 * Informes del **bot de administración**: el estado del sistema y los respaldos a demanda.
 *
 * **El estado no se recalcula aquí**: se ejecuta el MISMO tablero (`tools/estado.mjs --json`)
 * y se compone un texto compacto (Telegram no pinta colores y corta a 4096 caracteres). Las
 * reglas de «qué es un problema» salen de `alertas.mjs`, la fuente única; así el bot nunca dice
 * algo distinto de `npm run estado`.
 *
 * **Los respaldos sí viven aquí**, y hay dos, con propósitos distintos:
 *
 *   · `tomarRespaldos()` — el de `/respaldos`: `pg_dump -Fc` de cada base a una carpeta
 *     **temporal**, para mandarla por Telegram. Sirve para llevarse las bases ahora.
 *   · `tomarRespaldoCompleto()` — el de `/respaldo` (y `npm run respaldo:manual`): bases +
 *     **configuración** + **almacén** en una carpeta **del servidor**, con los nombres y el
 *     formato que esperan `odontocrm recuperar --from DIR` y `npm run verify:backup -- --from
 *     DIR`. Es la copia que vale para un fallo físico; la del chat no (le faltan los adjuntos
 *     y los secretos).
 *
 * Ninguno de los dos usa el `.pgpass` del respaldo nocturno a propósito: en Windows ese archivo
 * es de solo Administradores y el bot corre como `LocalService`, así que no podría leerlo. El rol
 * de cada servicio es dueño de su base y puede volcarla, y `--no-owner` deja el volcado listo
 * para restaurar en cualquier sitio.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { alertasDe, bytes } from './alertas.mjs';
import { dirDeEntornos, entornoRaiz, leerEnv, ROOT, rutaEnvDe, SERVICIOS } from './servicios.mjs';

const CARACAS = 'America/Caracas';
const MAX_TELEGRAM_TEXTO = 4096;
/** Telegram corta en 50 MB por archivo. */
export const MAX_ARCHIVO_TELEGRAM = 50 * 1024 * 1024;

const fechaCaracas = (iso) =>
  new Date(iso).toLocaleString('es-VE', { timeZone: CARACAS, hour12: false });

const recortar = (texto, limite = MAX_TELEGRAM_TEXTO) =>
  texto.length <= limite ? texto : `${texto.slice(0, limite - 20)}\n…(recortado)`;

/* ── Estado del sistema ────────────────────────────────────────────────────── */

/**
 * Ejecuta el tablero en modo JSON y devuelve `{ foto, problemas }`, o `{ error }` si no se
 * pudo tomar la foto. Se lanza como **proceso hijo** para no importar `estado.mjs` (que al
 * cargarse lee `process.argv` y se ejecuta solo).
 */
export const tomarEstado = () => {
  const tablero = join(ROOT, 'tools', 'estado.mjs');
  let salida;
  try {
    salida = execFileSync(process.execPath, [tablero, '--json', '--sin-aviso'], {
      encoding: 'utf8',
      env: process.env,
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (fallo) {
    const detalle = fallo instanceof Error ? fallo.message : String(fallo);
    return { error: `no pude tomar el estado: ${detalle}` };
  }

  let foto;
  try {
    foto = JSON.parse(salida);
  } catch {
    return { error: 'el tablero no devolvió JSON' };
  }
  return { foto, problemas: alertasDe(foto) };
};

/** Texto compacto del estado, para Telegram. */
export const formatearEstado = (foto, problemas) => {
  const lineas = [`OdontoCRM · estado · ${fechaCaracas(foto.generadoEn)}`, ''];

  if (foto.modoTest?.enabled === true) {
    lineas.push('⚠ MODO TEST activo: los datos son ficticios.');
  }

  const servicios = Array.isArray(foto.servicios) ? foto.servicios : [];
  if (servicios.length > 0) {
    const arriba = servicios.filter((servicio) => servicio.arriba).length;
    const listos = servicios.filter((servicio) => servicio.listo).length;
    lineas.push(
      `Servicios: ${arriba}/${servicios.length} arriba · ${listos}/${servicios.length} listos`,
    );
    const caidos = servicios
      .filter((servicio) => !servicio.arriba)
      .map((servicio) => servicio.name);
    if (caidos.length > 0) lineas.push(`Sin responder: ${caidos.join(', ')}`);
  }

  if (foto.bases !== undefined) {
    if (foto.bases.error !== undefined) {
      lineas.push(`Bases: ✖ ${foto.bases.error}`);
    } else {
      const lista = Array.isArray(foto.bases.bases) ? foto.bases.bases : [];
      const total = lista.reduce((suma, base) => suma + (base.bytes ?? 0), 0);
      lineas.push(`Bases: ${foto.bases.version} · ${lista.length} base(s) · ${bytes(total)}`);
    }
  }

  if (foto.cola?.error === undefined && Array.isArray(foto.cola?.colas)) {
    const pendientes = foto.cola.colas.reduce((suma, cola) => suma + cola.pendientes, 0);
    const fallidos = foto.cola.colas.reduce((suma, cola) => suma + cola.fallidos, 0);
    lineas.push(`Cola: ${pendientes} pendiente(s) · ${fallidos} fallido(s)`);
  }

  const outbox = Array.isArray(foto.outbox) ? foto.outbox : [];
  if (outbox.length > 0) {
    const pendientes = outbox.reduce((suma, fila) => suma + (fila.pendientes ?? 0), 0);
    const atascados = outbox.filter((fila) => (fila.pendientes ?? 0) > 0).map((fila) => fila.name);
    lineas.push(
      `Outbox: ${pendientes === 0 ? 'todo publicado' : `${pendientes} sin publicar (${atascados.join(', ')})`}`,
    );
  }

  if (foto.envios?.error === undefined && foto.envios !== undefined) {
    lineas.push(
      `Envíos: ${foto.envios.enCola} en cola · ${foto.envios.fallidos} fallidos · ${foto.envios.sinCanal} sin canal`,
    );
  }

  if (foto.cartasMuertas?.error === undefined && foto.cartasMuertas !== undefined) {
    lineas.push(
      `Eventos perdidos: ${foto.cartasMuertas.ultimas24h ?? 0} en 24 h · ${foto.cartasMuertas.pendientesDeRecoger ?? 0} sin recoger`,
    );
  }

  if (foto.disco?.porcentaje !== undefined) {
    lineas.push(`Disco: ${foto.disco.porcentaje} % libre (${bytes(foto.disco.libre ?? 0)})`);
  }

  if (foto.permisos?.envLegible === false) {
    lineas.push('');
    lineas.push(
      `⚠ sin permisos para leer ${foto.permisos.raiz ?? 'los entornos'}: no se comprobaron cola, outbox ni envíos`,
    );
  }

  lineas.push('');
  if (problemas.length === 0) {
    lineas.push('✔ Todo en orden.');
  } else {
    lineas.push(`⚠ ${problemas.length} problema(s):`);
    const visibles = problemas.slice(0, 12);
    for (const problema of visibles) lineas.push(`· ${problema}`);
    if (problemas.length > visibles.length) {
      lineas.push(`… y ${problemas.length - visibles.length} más`);
    }
  }

  return recortar(lineas.join('\n'));
};

/* ── Respaldo a demanda ────────────────────────────────────────────────────── */

/** Binarios de PostgreSQL. En Windows (EDB) no están en el PATH: se busca la versión mayor. */
const PGBIN = (() => {
  const explicito = process.env.ODONTOCRM_PGBIN ?? '';
  if (explicito !== '') return explicito;
  if (process.platform !== 'win32') return '';
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

const binario = (nombre) => (PGBIN === '' ? nombre : join(PGBIN, nombre));

/**
 * Credenciales del hijo por **entorno** (nunca por argumentos: en la línea de comandos las
 * vería cualquiera de la máquina). Es el mismo criterio que `verify-backup.mjs`.
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

/**
 * SHA-256 de un archivo, **por trozos**. Un volcado —y sobre todo el almacén— puede pesar
 * cientos de megas: leerlo entero en memoria solo para hashearlo no tiene sentido (y con el
 * almacén dentro de la copia, se nota).
 */
const sha256 = async (archivo) => {
  const hash = createHash('sha256');
  for await (const trozo of createReadStream(archivo)) hash.update(trozo);
  return hash.digest('hex');
};

/** Cabecera de un volcado de `pg_dump -Fc`: los 5 primeros bytes son «PGDMP». */
const tieneCabecera = (archivo) => {
  const descriptor = openSync(archivo, 'r');
  try {
    const cabecera = Buffer.alloc(5);
    const leidos = readSync(descriptor, cabecera, 0, 5, 0);
    return leidos === 5 && cabecera.toString('ascii') === 'PGDMP';
  } finally {
    closeSync(descriptor);
  }
};

/**
 * El motivo de un fallo de un proceso hijo: las últimas líneas de su salida, que es lo que
 * dice qué pasó de verdad (`pg_dump: error: …`).
 */
const motivoDe = (fallo, porDefecto) => {
  const salida = `${fallo?.stdout ?? ''}${fallo?.stderr ?? ''}`.trim();
  const detalle = salida
    .split('\n')
    .filter((linea) => linea.trim() !== '')
    .slice(-2)
    .join(' · ');
  if (detalle !== '') return detalle;
  return fallo instanceof Error ? fallo.message : porDefecto;
};

/**
 * ¿El catálogo del volcado se puede leer entero? Es la comprobación que hace la copia nocturna
 * (`pg_restore --list`): un `.dump` cortado a medias pasa la cabecera `PGDMP` y se cae aquí. Si
 * no hay `pg_restore` a mano se devuelve `omitido`: no poder comprobarlo no lo vuelve malo.
 */
const revisarCatalogo = (archivo) => {
  try {
    execFileSync(binario('pg_restore'), ['--list', archivo], { stdio: ['ignore', 'pipe', 'pipe'] });
    return { estado: 'ok' };
  } catch (fallo) {
    if (fallo?.code === 'ENOENT') return { estado: 'omitido' };
    return { estado: 'malo', motivo: motivoDe(fallo, 'pg_restore no pudo leer el catálogo') };
  }
};

/**
 * Carpeta temporal de los volcados que se mandan por Telegram. En Windows el bot corre como
 * `LocalService` y `%TEMP%` (`C:\Windows\TEMP`) NO es escribible por esa cuenta, así que el
 * instalador fija `ODONTOCRM_ADMIN_TMP_DIR` a una carpeta con permiso de escritura.
 */
const carpetaTemporal = () => {
  const base = process.env.ODONTOCRM_ADMIN_TMP_DIR ?? join(tmpdir(), 'odontocrm');
  const dir = join(base, `admin-respaldos-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

/**
 * Un volcado (o un fallo) de UNA base. En los dos casos el disco queda limpio: un `.dump` a
 * medias no se queda en la carpeta, que es peor que no tenerlo (alguien lo daría por bueno).
 */
const volcarBase = async (dir, base, url, verificar) => {
  const destino = join(dir, `${base}.dump`);
  try {
    execFileSync(
      binario('pg_dump'),
      ['--format=custom', '--compress=6', '--no-owner', '--no-privileges', `--file=${destino}`],
      { env: entornoPg(url), stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (fallo) {
    rmSync(destino, { force: true });
    return { fallo: { base, motivo: motivoDe(fallo, 'pg_dump falló') } };
  }

  if (!tieneCabecera(destino)) {
    rmSync(destino, { force: true });
    return { fallo: { base, motivo: 'el volcado no empieza por PGDMP' } };
  }

  if (verificar) {
    const catalogo = revisarCatalogo(destino);
    if (catalogo.estado === 'malo') {
      rmSync(destino, { force: true });
      return { fallo: { base, motivo: `el catálogo no se pudo leer: ${catalogo.motivo}` } };
    }
  }

  return {
    archivo: {
      base,
      path: destino,
      nombre: `${base}.dump`,
      bytes: statSync(destino).size,
      sha256: await sha256(destino),
    },
  };
};

/**
 * La base de la cola de eventos (`pg-boss`). No es de ningún servicio —la comparten todos—,
 * así que no aparece en `SERVICIOS`: se saca del `EVENTS_DATABASE_URL` del entorno de la raíz
 * o del `.env` del primer servicio que lo declare.
 */
const urlEventos = () => {
  const delEntorno = (
    process.env.EVENTS_DATABASE_URL ??
    entornoRaiz().EVENTS_DATABASE_URL ??
    ''
  ).trim();
  if (delEntorno !== '') return delEntorno;
  for (const servicio of SERVICIOS) {
    const url = (leerEnv(rutaEnvDe(servicio)).EVENTS_DATABASE_URL ?? '').trim();
    if (url !== '') return url;
  }
  return '';
};

/**
 * Volca las bases a `dir`, una por servicio (y la cola, si se pide).
 *
 * Devuelve `{ archivos, fallos, sinCredenciales }`:
 *   · `archivos[i] = { base, path, nombre, bytes, sha256 }`
 *   · `fallos[i] = { base, motivo }`
 *   · `sinCredenciales` = servicios sin `DATABASE_URL` (no se pudo intentar).
 */
const volcarBases = async (dir, opciones = {}) => {
  const fuentes = SERVICIOS.map((servicio) => ({
    base: servicio.database,
    nombre: servicio.name,
    url: (leerEnv(rutaEnvDe(servicio)).DATABASE_URL ?? '').trim(),
  }));
  // La copia completa la lleva: el respaldo nocturno también la incluye, y sin ella se pierde
  // el estado de la cola (avisos aún sin entregar) al recuperar.
  if (opciones.incluirEventos === true) {
    fuentes.push({ base: 'odonto_events', nombre: 'events', url: urlEventos() });
  }

  const archivos = [];
  const fallos = [];
  const sinCredenciales = [];

  for (const fuente of fuentes) {
    if (fuente.url === '') {
      sinCredenciales.push(fuente.nombre);
      continue;
    }
    const resultado = await volcarBase(dir, fuente.base, fuente.url, opciones.verificar === true);
    if (resultado.fallo !== undefined) fallos.push(resultado.fallo);
    else archivos.push(resultado.archivo);
  }

  return { archivos, fallos, sinCredenciales };
};

/**
 * Toma un respaldo **ad-hoc** de las bases (una por servicio) y lo deja en una carpeta
 * temporal con sus sumas y su manifiesto, listo para mandarlo por Telegram.
 *
 * Devuelve `{ dir, archivos, fallos, sinCredenciales, sumas, manifest }`.
 */
export const tomarRespaldos = async () => {
  const dir = carpetaTemporal();
  const { archivos, fallos, sinCredenciales } = await volcarBases(dir);

  // Sumas y manifiesto, como el respaldo nocturno: lo que viaja se puede comprobar.
  const sumas = archivos.map((archivo) => `${archivo.sha256}  ${archivo.nombre}`).join('\n');
  writeFileSync(join(dir, 'SHA256SUMS'), `${sumas}\n`, 'ascii');

  const manifest = [
    'odontocrm_admin_backup_version=1',
    `fecha=${new Date().toISOString()}`,
    `equipo=${process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? 'desconocido'}`,
    `bases=${archivos.map((archivo) => archivo.base).join(' ')}`,
    `archivos=${archivos.length}`,
    `fallos=${fallos.length}`,
  ].join('\n');
  writeFileSync(join(dir, 'manifest.txt'), `${manifest}\n`);

  return { dir, archivos, fallos, sinCredenciales, sumas, manifest };
};

/** Texto del resumen del respaldo, para Telegram (los archivos van aparte). */
export const formatearRespaldos = (resultado) => {
  const lineas = ['OdontoCRM · respaldo', ''];
  lineas.push(`bases volcadas: ${resultado.archivos.length}`);
  for (const archivo of resultado.archivos) {
    const mb = (archivo.bytes / (1024 * 1024)).toFixed(1);
    lineas.push(`· ${archivo.base} — ${mb} MB`);
  }
  if (resultado.fallos.length > 0) {
    lineas.push('');
    lineas.push(`⚠ ${resultado.fallos.length} base(s) fallaron:`);
    for (const fallo of resultado.fallos) lineas.push(`· ${fallo.base}: ${fallo.motivo}`);
  }
  if (resultado.sinCredenciales.length > 0) {
    lineas.push('');
    lineas.push(`⚠ sin DATABASE_URL: ${resultado.sinCredenciales.join(', ')}`);
  }
  return recortar(lineas.join('\n'));
};

/** Borra la carpeta temporal (los volcados ya se enviaron o el operador los recogió). */
export const limpiarRespaldos = (dir) => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Si no se puede borrar, no es motivo para fallar: queda en la carpeta temporal.
  }
};

/* ── Respaldo completo a demanda (se queda en el servidor) ─────────────────── */

/** `AAAA-MM-DD_HHMMSS` en hora local, la misma marca que usa el respaldo nocturno. */
export const marcaDeTiempo = (fecha = new Date()) => {
  const dos = (numero) => String(numero).padStart(2, '0');
  return (
    `${fecha.getFullYear()}-${dos(fecha.getMonth() + 1)}-${dos(fecha.getDate())}` +
    `_${dos(fecha.getHours())}${dos(fecha.getMinutes())}${dos(fecha.getSeconds())}`
  );
};

/**
 * Carpeta raíz de los respaldos manuales.
 *
 * Es **propia** y no `BACKUP_DIR` por dos motivos. Uno: en Windows `BACKUP_DIR` es de solo
 * Administradores (la tarea nocturna corre como SYSTEM) y el bot corre como `LocalService`, así
 * que escribir ahí exigiría ampliarle permisos. Y dos: su retención tiene que ser aparte, porque
 * cada copia lleva el **almacén entero** dentro y no caben treinta como en la carpeta del
 * temporizador.
 *
 * Se puede cambiar con `ODONTOCRM_BACKUP_MANUAL_DIR` (lo usan el CLI y las pruebas).
 */
export const carpetaManualDeRespaldos = () => {
  const dicho = (process.env.ODONTOCRM_BACKUP_MANUAL_DIR ?? '').trim();
  if (dicho !== '') return dicho;
  return process.platform === 'win32'
    ? join(process.env.ODONTOCRM_CODE_DIR ?? 'C:\\OdontoCRM', 'data', 'respaldo-manual')
    : '/var/lib/odontocrm/respaldo-manual';
};

/**
 * Dónde vive el almacén (radiografías y PDFs). El entorno manda —como en `recifrar-almacen`—;
 * si no lo dice nadie se lee el `STORAGE_DIR` de `backup.env` (el archivo que escribe el
 * instalador y que lee la copia nocturna) y, en último caso, la convención del sistema.
 */
export const carpetaDelAlmacen = () => {
  const delEntorno = (process.env.STORAGE_DIR ?? entornoRaiz().STORAGE_DIR ?? '').trim();
  if (delEntorno !== '') return delEntorno;
  const dir = dirDeEntornos();
  const delBackup = dir === null ? '' : (leerEnv(join(dir, 'backup.env')).STORAGE_DIR ?? '').trim();
  if (delBackup !== '') return delBackup;
  return process.platform === 'win32'
    ? join(process.env.ODONTOCRM_CODE_DIR ?? 'C:\\OdontoCRM', 'data', 'storage')
    : '/var/lib/odontocrm/storage';
};

/**
 * Nombres de los dos bloques opcionales, con la forma que **espera la restauración**: son los
 * mismos que produce el respaldo nocturno de cada plataforma, así que `odontocrm recuperar
 * --from DIR` y `npm run verify:backup -- --from DIR` los entienden tal cual. Puras (y
 * exportadas) para poder probarlas sin tocar el disco.
 */
export const nombreAlmacenDeRespaldo = (plataforma = process.platform, marca = '') =>
  plataforma === 'win32' ? 'storage.zip' : `storage_${marca}.tar.gz`;

export const nombreConfigDeRespaldo = (plataforma = process.platform, marca = '') =>
  plataforma === 'win32' ? 'config.zip' : `etc-odontocrm_${marca}.tar.gz`;

/**
 * Comprime una carpeta en un archivo. `envolver` decide si dentro va la **carpeta** o solo su
 * **contenido**, y esa diferencia la dicta la restauración de cada plataforma: el almacén va
 * siempre por contenido (`tar … -C $STORAGE_DIR` / `Expand-Archive … $OdontoStorage`) y la
 * configuración de Fedora va **envuelta** (se extrae en `/etc`), mientras que el `config.zip` de
 * Windows lleva el contenido de `env` (se extrae EN `env`).
 */
const comprimirCarpeta = (origen, destino, { envolver = false } = {}) => {
  if (process.platform === 'win32') {
    // En Windows no hay `tar` garantizado; sí PowerShell. `\*` = el CONTENIDO de la carpeta.
    const patron = join(origen, '*');
    execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Compress-Archive -Path '${patron}' -DestinationPath '${destino}' -Force`,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return;
  }
  const argumentos = envolver
    ? ['--create', '--gzip', '--file', destino, '--directory', dirname(origen), basename(origen)]
    : ['--create', '--gzip', '--file', destino, '--directory', origen, '.'];
  execFileSync('tar', argumentos, { stdio: ['ignore', 'pipe', 'pipe'] });
};

/** Cuántas copias manuales se conservan (las más nuevas): `ODONTOCRM_BACKUP_MANUAL_KEEP`, 5. */
export const conservarRespaldosManuales = () => {
  const valor = Number.parseInt(process.env.ODONTOCRM_BACKUP_MANUAL_KEEP ?? '5', 10);
  return Number.isInteger(valor) && valor > 0 ? valor : 5;
};

/**
 * Qué carpetas hay que borrar de la raíz: todas menos las `conservar` más nuevas. Los nombres
 * son marcas `AAAA-MM-DD_HHMMSS`, así que ordenar es ordenarlas por fecha. Pura.
 */
export const podarRespaldoManual = (nombres, conservar) =>
  [...nombres].sort().reverse().slice(conservar);

/** Aplica la retención y devuelve los nombres borrados (si no se puede borrar uno, se queda). */
const podarManuales = (raiz, conservar) => {
  if (!existsSync(raiz)) return [];
  const nombres = readdirSync(raiz, { withFileTypes: true })
    .filter((entrada) => entrada.isDirectory() && /^\d{4}-\d{2}-\d{2}_\d{6}$/.test(entrada.name))
    .map((entrada) => entrada.name);

  const borradas = [];
  for (const nombre of podarRespaldoManual(nombres, conservar)) {
    try {
      rmSync(join(raiz, nombre), { recursive: true, force: true });
      borradas.push(nombre);
    } catch {
      // Sin permiso para borrar, la copia vieja se queda: no es motivo para fallar la nueva.
    }
  }
  return borradas;
};

/**
 * **Respaldo completo y a demanda, que se queda en el servidor** (`/respaldo` en Telegram y
 * `npm run respaldo:manual`).
 *
 * Existe porque el respaldo nocturno solo se puede lanzar como Administrador (Windows) o root
 * (Fedora) —`odontocrm-backup.ps1` lo exige y lee el `.pgpass`, que es de Administradores— y el
 * bot de administración no lo es. Aquí se reusa lo que ya sabe hacer `/respaldos` (un
 * `pg_dump -Fc` por base con el `DATABASE_URL` de su propio servicio) y se le añaden la
 * **configuración** (con sus secretos: ahí va el `STORAGE_ENCRYPTION_KEY` con el que se lee el
 * almacén cifrado) y el **almacén**, en la forma que entienden `odontocrm recuperar --from DIR`
 * y `npm run verify:backup -- --from DIR`.
 *
 * Devuelve `{ dir, marca, archivos, extras, fallos, sinCredenciales, avisos, podadas, bytes,
 * bytesBases }`.
 */
export const tomarRespaldoCompleto = async (opciones = {}) => {
  const marca = opciones.marca ?? marcaDeTiempo();
  const raiz = opciones.destino ?? carpetaManualDeRespaldos();
  const dir = join(raiz, marca);
  mkdirSync(dir, { recursive: true });

  const avisos = [];
  const extras = [];
  const { archivos, fallos, sinCredenciales } = await volcarBases(dir, {
    verificar: true,
    // El respaldo nocturno también lleva la cola: sin ella se pierde el estado de los avisos
    // que aún no se habían entregado.
    incluirEventos: true,
  });

  /** Comprime un bloque y lo deja anotado; si falla, se avisa y la copia sigue sin él. */
  const anadirBloque = async (etiqueta, origen, destino, opciones = {}) => {
    try {
      comprimirCarpeta(origen, destino, { envolver: opciones.envolver === true });
      // La configuración lleva los secretos: nace en 0600, como la de la copia nocturna (en
      // Windows la ACL la pone el instalador sobre la carpeta).
      if (opciones.privado === true && process.platform !== 'win32') chmodSync(destino, 0o600);
      extras.push({
        etiqueta,
        nombre: basename(destino),
        bytes: statSync(destino).size,
        sha256: await sha256(destino),
      });
    } catch (fallo) {
      rmSync(destino, { force: true });
      avisos.push(`no pude copiar ${etiqueta} (${motivoDe(fallo, 'la compresión falló')})`);
    }
  };

  // 1) El almacén. Sin él, un fallo físico deja la base recuperable y las radiografías perdidas:
  //    es justo el hueco que cerró la copia nocturna.
  const almacen = carpetaDelAlmacen();
  if (!existsSync(almacen)) {
    avisos.push(`no existe el almacén ${almacen}: la copia va sin radiografías ni PDFs`);
  } else {
    await anadirBloque(
      'almacenamiento',
      almacen,
      join(dir, nombreAlmacenDeRespaldo(process.platform, marca)),
    );
  }

  // 2) La configuración, que trae los secretos. En desarrollo no hay carpeta de configuración
  //    (los `.env` viven en el repositorio y en cada servicio): se avisa y se sigue.
  const config = dirDeEntornos();
  if (config === null) {
    avisos.push('sin ODONTOCRM_ENV_DIR: no hay carpeta de configuración que copiar');
  } else if (!existsSync(config)) {
    avisos.push(`no existe la carpeta de configuración ${config}`);
  } else {
    await anadirBloque(
      'configuración (CON SECRETOS)',
      config,
      join(dir, nombreConfigDeRespaldo(process.platform, marca)),
      { envolver: process.platform !== 'win32', privado: true },
    );
  }

  // 3) Sumas y manifiesto, como la copia nocturna: lo que hay aquí se puede comprobar. La línea
  //    `bases=` es la que lee el simulacro (`verify-backup.mjs`) para saber qué restaurar.
  const todos = [...archivos, ...extras];
  const sumas = todos.map((archivo) => `${archivo.sha256}  ${archivo.nombre}`).join('\n');
  writeFileSync(join(dir, 'SHA256SUMS'), `${sumas}\n`, 'ascii');

  const manifest = [
    'odontocrm_respaldo_version=1',
    `fecha=${new Date().toISOString()}`,
    `equipo=${process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? 'desconocido'}`,
    `origen=manual`,
    `bases=${archivos.map((archivo) => archivo.base).join(' ')}`,
    `archivos=${archivos.length}`,
    `extras=${extras.map((archivo) => archivo.nombre).join(' ')}`,
    `fallos=${fallos.length}`,
  ].join('\n');
  writeFileSync(join(dir, 'manifest.txt'), `${manifest}\n`);

  const bytesBases = archivos.reduce((suma, archivo) => suma + archivo.bytes, 0);
  const podadas = podarManuales(raiz, opciones.conservar ?? conservarRespaldosManuales());

  return {
    dir,
    raiz,
    marca,
    archivos,
    extras,
    fallos,
    sinCredenciales,
    avisos,
    podadas,
    sumas,
    manifest,
    bytesBases,
    bytes: bytesBases + extras.reduce((suma, archivo) => suma + archivo.bytes, 0),
  };
};

/** Texto del resumen del respaldo completo, para Telegram. */
export const formatearRespaldoCompleto = (resultado) => {
  const lineas = ['OdontoCRM · respaldo completo', '', `carpeta: ${resultado.dir}`, ''];
  lineas.push(`Bases (${resultado.archivos.length}): ${bytes(resultado.bytesBases)}`);
  for (const archivo of resultado.archivos) {
    lineas.push(`· ${archivo.base} — ${bytes(archivo.bytes)}`);
  }
  for (const extra of resultado.extras) {
    lineas.push(`· ${extra.etiqueta} — ${bytes(extra.bytes)}`);
  }
  lineas.push('');
  lineas.push(`Total: ${bytes(resultado.bytes)}`);

  if (resultado.sinCredenciales.length > 0) {
    lineas.push('');
    lineas.push(`⚠ sin DATABASE_URL: ${resultado.sinCredenciales.join(', ')}`);
  }
  if (resultado.fallos.length > 0) {
    lineas.push('');
    lineas.push(`⚠ ${resultado.fallos.length} base(s) fallaron:`);
    for (const fallo of resultado.fallos) lineas.push(`· ${fallo.base}: ${fallo.motivo}`);
  }
  for (const aviso of resultado.avisos) {
    lineas.push('');
    lineas.push(`⚠ ${aviso}`);
  }
  if (resultado.extras.some((extra) => extra.etiqueta.startsWith('configuración'))) {
    lineas.push('');
    lineas.push('⚠ la configuración lleva SECRETOS: guarda esta carpeta en un medio protegido.');
  }
  if (resultado.podadas.length > 0) {
    lineas.push('');
    lineas.push(`retención: borradas ${resultado.podadas.length} copia(s) anterior(es)`);
  }

  lineas.push('');
  lineas.push('Comprobar:  npm run verify:backup -- --from "<carpeta>"');
  lineas.push('Reponer:    odontocrm recuperar --from "<carpeta>" --yes');
  return recortar(lineas.join('\n'));
};
