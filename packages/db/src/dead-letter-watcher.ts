import pg from 'pg';

import type { PgBoss } from 'pg-boss';

import { DEAD_LETTER_QUEUE, registerDeadLetterHandler } from './boss.js';
import {
  ensureDeadLetterTable,
  insertDeadLetter,
  toDeadLetterRecord,
  type DeadLetterRecord,
} from './dead-letter.js';

/**
 * **Vigilante de la cola de descarte**: convierte los eventos perdidos en algo que se puede
 * mirar y de lo que uno se entera.
 *
 * Sin él, un evento que agota sus reintentos se queda en el buzón de `pg-boss` y nadie lo
 * sabe hasta que alguien echa de menos un dato: el consumo se hizo a medias y la única
 * señal era mirar las tablas de la cola a mano. El vigilante hace dos cosas por cada
 * evento perdido: lo **apunta** en `events.dead_letter_events` (con el sobre, el motivo y
 * los reintentos) y llama a quien le hayan pasado para que dé el **aviso**.
 *
 * Se registra en los servicios que ya consumen eventos: `pg-boss` da cada trabajo a **un
 * solo** trabajador, así que un evento perdido se apunta y se avisa **una vez** aunque seis
 * servicios estén vigilando. Si el aviso falla, el apunte ya está hecho y el reintento del
 * trabajo no duplica la fila (la clave es el id del trabajo) ni repite el aviso.
 */
export interface StartDeadLetterWatcherOptions {
  /** Cola de `pg-boss` (la comparte con el consumidor de eventos del servicio). */
  boss: PgBoss;
  /** Base de **eventos**: donde vive la tabla del registro. */
  connectionString: string;
  /** Nombre para `pg_stat_activity`: se ve de un golpe qué proceso mira el buzón. */
  applicationName: string;
  /**
   * Qué hacer con cada evento perdido. Aquí va el aviso al administrador; lo que llegue
   * tiene la fila ya escrita y `esNuevo` dice si este proceso es el que la apuntó (y por
   * tanto el que debe avisar).
   */
  onDeadLetter: (record: DeadLetterRecord, esNuevo: boolean) => Promise<void> | void;
  /** Fallo al leer o escribir el registro: se registra, no tumba el servicio. */
  onError?: (error: unknown) => void;
}

export interface DeadLetterWatcher {
  /** Cuántos eventos ha apuntado este proceso (diagnóstico y pruebas). */
  apuntados: () => number;
  /** Cuántos trabajos ha visto (incluidos los que ya estaban apuntados). */
  vistos: () => number;
  stop: () => Promise<void>;
}

export const startDeadLetterWatcher = async (
  options: StartDeadLetterWatcherOptions,
): Promise<DeadLetterWatcher> => {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    application_name: options.applicationName,
    max: 1,
  });
  // Un error de una conexión inactiva no debe tumbar el proceso (mismo criterio que el
  // pool de los servicios).
  pool.on('error', (error) => {
    options.onError?.(error);
  });

  await ensureDeadLetterTable(pool);

  let apuntados = 0;
  let vistos = 0;

  const workerId = await registerDeadLetterHandler(options.boss, async (jobs) => {
    for (const job of jobs) {
      vistos += 1;
      const record = toDeadLetterRecord(job);

      let esNuevo: boolean;
      try {
        esNuevo = await insertDeadLetter(pool, record);
      } catch (error) {
        options.onError?.(error);
        // Si no se puede apuntar, se avisa igual: perder el aviso por no poder escribir la
        // fila sería dejar el fallo en silencio, que es lo que se venía a arreglar.
        esNuevo = true;
      }
      if (esNuevo) apuntados += 1;

      try {
        await options.onDeadLetter(record, esNuevo);
      } catch (error) {
        options.onError?.(error);
      }
    }
  });

  return {
    apuntados: () => apuntados,
    vistos: () => vistos,
    stop: async () => {
      // `offWork` se identifica por **cola y trabajador**: en este proceso puede haber otros
      // trabajadores de la misma cola, y solo se quiere parar este.
      await options.boss
        .offWork(DEAD_LETTER_QUEUE, { id: workerId, wait: true })
        .catch(() => undefined);
      await pool.end().catch(() => undefined);
    },
  };
};

/* ── La variante que avisa al administrador ────────────────────────────────── */

/**
 * A dónde se manda el aviso. Es el servicio de **notificaciones**, que es el único que tiene
 * el bot de administración: los demás servicios no conocen ningún token, solo la dirección
 * por la que se pide el aviso.
 */
export interface AdminAlertTarget {
  /** `NOTIFICATIONS_URL` del servicio. */
  notificationsUrl: string;
  /** Secreto compartido de las rutas internas. */
  internalSecret: string | undefined;
  /** Quién avisa (`screens`, `billing`…): lo imprime el mensaje. */
  source: string;
  timeoutMs?: number;
}

/**
 * Manda el aviso al administrador por el canal interno. Devuelve si salió.
 *
 * **Nunca lanza**: quien avisa está atendiendo un evento perdido y un fallo al avisar no
 * puede convertirse en un segundo problema. Si notificaciones está caído, el apunte duradero
 * ya está hecho y el tablero de estado lo dirá.
 */
export const postAdminAlert = async (
  target: AdminAlertTarget,
  alert: {
    level: 'critical' | 'warning' | 'info';
    title: string;
    detail: string | null;
    context: Record<string, unknown>;
  },
): Promise<boolean> => {
  try {
    const respuesta = await fetch(
      `${target.notificationsUrl.replace(/\/+$/, '')}/internal/v1/notifications/admin-alert`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-token': target.internalSecret ?? '',
        },
        body: JSON.stringify({ ...alert, source: target.source }),
        signal: AbortSignal.timeout(target.timeoutMs ?? 5_000),
      },
    );
    if (!respuesta.ok) return false;
    const resultado = (await respuesta.json()) as { enviado?: boolean };
    return resultado.enviado === true;
  } catch {
    return false;
  }
};

/** Lo que cuenta el aviso de un evento perdido, a partir de su registro. */
export const deadLetterAlert = (record: DeadLetterRecord) => ({
  level: 'critical' as const,
  title: `Evento perdido: ${record.eventType ?? 'desconocido'}`,
  detail:
    'Un evento de dominio agotó sus reintentos y no se pudo entregar a ningún consumidor: ' +
    'lo que ese evento pedía —una auditoría, un reporte, un aviso— no se hizo.\n' +
    `Motivo: ${record.error ?? 'sin detalle'}`,
  context: {
    cola: record.sourceQueue,
    evento: record.eventType,
    productor: record.producer,
    reintentos: record.retryCount,
    agregado: record.aggregateId,
  },
});

export interface StartAlertingDeadLetterWatcherOptions extends Omit<
  StartDeadLetterWatcherOptions,
  'onDeadLetter'
> {
  /** A dónde va el aviso (el servicio de notificaciones). */
  alert: AdminAlertTarget;
  /** Registro del apunte y del aviso, para el logger del servicio. */
  onRecorded?: (record: DeadLetterRecord) => void;
}

/**
 * El vigilante que **avisa**: apunta el evento perdido y manda el aviso al administrador.
 *
 * Es la variante que usan los servicios que consumen eventos (todos menos notificaciones,
 * que tiene el bot y llama al emisor directamente, sin pasar por HTTP).
 */
export const startAlertingDeadLetterWatcher = async (
  options: StartAlertingDeadLetterWatcherOptions,
): Promise<DeadLetterWatcher> =>
  startDeadLetterWatcher({
    boss: options.boss,
    connectionString: options.connectionString,
    applicationName: options.applicationName,
    ...(options.onError === undefined ? {} : { onError: options.onError }),
    onDeadLetter: async (record, esNuevo) => {
      options.onRecorded?.(record);
      // Si la fila ya estaba (otro servicio la apuntó y avisó, o `pg-boss` reentrega el
      // trabajo), no se repite el mensaje: el administrador no necesita el mismo aviso dos
      // veces.
      if (!esNuevo) return;
      await postAdminAlert(options.alert, deadLetterAlert(record));
    },
  });
