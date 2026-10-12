/**
 * Informes del **bot de administración**: el estado del sistema y un respaldo a demanda.
 *
 * **El estado no se recalcula aquí**: se ejecuta el MISMO tablero (`tools/estado.mjs --json`)
 * y se compone un texto compacto (Telegram no pinta colores y corta a 4096 caracteres). Las
 * reglas de «qué es un problema» salen de `alertas.mjs`, la fuente única; así el bot nunca dice
 * algo distinto de `npm run estado`.
 *
 * **El respaldo sí vive aquí**: hace `pg_dump` de cada base con las credenciales de su propio
 * servicio (las mismas que usa el tablero para leerlas). No toca el `.pgpass` del respaldo
 * nocturno a propósito: en Windows ese archivo es de solo Administradores y el bot corre como
 * `LocalService`, así que no podría leerlo. El rol de cada servicio es dueño de su base y
 * puede volcarla, y `--no-owner` deja el volcado listo para restaurar en cualquier sitio.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { alertasDe, bytes } from './alertas.mjs';
import { leerEnv, ROOT, rutaEnvDe, SERVICIOS } from './servicios.mjs';

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

const sha256 = (archivo) => createHash('sha256').update(readFileSync(archivo)).digest('hex');

/** Cabecera de un volcado de `pg_dump -Fc`: los 5 primeros bytes son «PGDMP». */
const tieneCabecera = (archivo) =>
  readFileSync(archivo).subarray(0, 5).toString('ascii') === 'PGDMP';

/**
 * Carpeta temporal de los volcados. En Windows el bot corre como `LocalService` y `%TEMP%`
 * (`C:\Windows\TEMP`) NO es escribible por esa cuenta, así que el instalador fija
 * `ODONTOCRM_ADMIN_TMP_DIR` a una carpeta con permiso de escritura.
 */
const carpetaTemporal = () => {
  const base = process.env.ODONTOCRM_ADMIN_TMP_DIR ?? join(tmpdir(), 'odontocrm');
  const dir = join(base, `admin-respaldos-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

/**
 * Toma un respaldo **ad-hoc** de las bases (una por servicio) y lo deja en una carpeta
 * temporal con sus sumas y su manifiesto.
 *
 * Devuelve `{ dir, archivos, fallos, sinCredenciales, sumas, manifest }`:
 *   · `archivos[i] = { base, path, nombre, bytes, sha256 }`
 *   · `fallos[i] = { base, motivo }`
 *   · `sinCredenciales` = servicios sin `DATABASE_URL` (no se pudo intentar).
 */
export const tomarRespaldos = () => {
  const dir = carpetaTemporal();
  const archivos = [];
  const fallos = [];
  const sinCredenciales = [];

  for (const servicio of SERVICIOS) {
    const url = leerEnv(rutaEnvDe(servicio)).DATABASE_URL;
    if (url === undefined || url === '') {
      sinCredenciales.push(servicio.name);
      continue;
    }

    const destino = join(dir, `${servicio.database}.dump`);
    try {
      execFileSync(
        binario('pg_dump'),
        ['--format=custom', '--compress=6', '--no-owner', '--no-privileges', `--file=${destino}`],
        { env: entornoPg(url), stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch (fallo) {
      const salida = `${fallo.stdout ?? ''}${fallo.stderr ?? ''}`.trim();
      fallos.push({
        base: servicio.database,
        motivo: salida.split('\n').slice(-2).join(' · ') || 'pg_dump falló',
      });
      rmSync(destino, { force: true });
      continue;
    }

    if (!tieneCabecera(destino)) {
      fallos.push({ base: servicio.database, motivo: 'el volcado no empieza por PGDMP' });
      rmSync(destino, { force: true });
      continue;
    }

    archivos.push({
      base: servicio.database,
      path: destino,
      nombre: `${servicio.database}.dump`,
      bytes: statSync(destino).size,
      sha256: sha256(destino),
    });
  }

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
