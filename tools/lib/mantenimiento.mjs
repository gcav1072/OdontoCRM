/**
 * Bloqueo de mantenimiento: evita que se arranque la pila **mientras** una
 * operación destructiva (`db:reset`) está borrando y recreando bases.
 *
 * Es un archivo con el PID de quien lo creó, no un candado ciego: al leerlo se
 * comprueba si ese proceso **sigue vivo**. Si murió (una terminal cerrada de golpe,
 * un Ctrl+C), el bloqueo está caducado y se puede seguir — así no se repite el
 * problema que el [ADR 0037](../../docs/adr/0037-una-sola-pila-a-la-vez.md) evitó con
 * los puertos: un archivo de candado que se queda pegado y bloquea el trabajo
 * legítimo.
 *
 * Existe por un caso real (2026-10-04): se arrancó `npm run dev` con `db:reset` a
 * medias; los servicios que apuntaban a una base que ya no existía murieron al
 * conectar (`patients` y `scheduling`) y el bot empezó a fallar con
 * `ECONNREFUSED 127.0.0.1:4002`. Con el bloqueo, el arranque se niega con un mensaje
 * claro en vez de dejar media pila en pie.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** `tmp/` está ignorado por Git: es el sitio de los archivos de trabajo del proyecto. */
export const RUTA_BLOQUEO = join(ROOT, 'tmp', 'mantenimiento.lock');

/**
 * Escribe el bloqueo. Si ya había uno, se reemplaza (el llamador decide antes).
 *
 * @param {string} tarea
 * @returns {{ tarea: string, pid: number, desde: string, host: string }}
 */
export const escribirBloqueo = (tarea) => {
  const bloqueo = {
    tarea,
    pid: process.pid,
    desde: new Date().toISOString(),
    host: process.env['COMPUTERNAME'] ?? process.env['HOSTNAME'] ?? 'desconocido',
  };
  mkdirSync(dirname(RUTA_BLOQUEO), { recursive: true });
  writeFileSync(RUTA_BLOQUEO, `${JSON.stringify(bloqueo, null, 2)}\n`, 'utf8');
  return bloqueo;
};

/**
 * ¿Sigue existiendo ese proceso? `process.kill(pid, 0)` no mata nada: solo pregunta.
 *
 * @param {number} pid
 * @returns {boolean}
 */
export const procesoVivo = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM significa que existe pero es de otro usuario: sigue vivo.
    return /** @type {{ code?: string }} */ (error).code === 'EPERM';
  }
};

/**
 * Bloqueo actual, con la comprobación de si quien lo creó sigue vivo.
 *
 * @returns {{ tarea: string, pid: number, desde: string, host: string, vivo: boolean } | null}
 */
export const bloqueoVigente = () => {
  if (!existsSync(RUTA_BLOQUEO)) return null;

  try {
    const crudo = JSON.parse(readFileSync(RUTA_BLOQUEO, 'utf8'));
    const pid = Number(crudo?.pid ?? 0);
    return {
      tarea: String(crudo?.tarea ?? 'operación desconocida'),
      pid,
      desde: String(crudo?.desde ?? ''),
      host: String(crudo?.host ?? ''),
      vivo: procesoVivo(pid),
    };
  } catch {
    // Archivo ilegible o a medio escribir: se trata como caducado, no se bloquea nada.
    return { tarea: 'operación desconocida', pid: 0, desde: '', host: '', vivo: false };
  }
};

export const limpiarBloqueo = () => {
  rmSync(RUTA_BLOQUEO, { force: true });
};
