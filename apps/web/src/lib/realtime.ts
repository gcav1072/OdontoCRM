import { STAFF_CHANNEL, STAFF_READY_TOPIC, type StaffSignal } from '@odontocrm/contracts';

import { API_BASE, getAccessToken, refreshSession } from './api';
import { notificationKeys } from './notifications';
import { schedulingKeys } from './scheduling';
import { leerTramas } from './sse';

/**
 * Canal en vivo del **personal** (mejora 2 del plan post-Fase 11).
 *
 * Recepción (`/flujo`), caja (`/caja`) y consultorio trabajan sobre los mismos hechos: el
 * odontólogo cierra la sesión y la fila de la secretaría tiene que cambiar, la factura
 * nace y la caja tiene que verla. Hasta ahora eso dependía de recargar la página o de que
 * alguien cerrara un diálogo.
 *
 * El servidor **no manda datos** por este canal: manda avisos (`StaffSignal`) de qué
 * cambió. Aquí se traduce cada aviso en las consultas que quedaron viejas, y TanStack
 * Query se encarga de volver a pedir solo lo que está en pantalla. Es más liviano que
 * replicar el estado y no pone datos de pacientes en el cable.
 */

/* ── Qué invalidar cuando llega un aviso ───────────────────────────────────── */

/**
 * Un aviso se identifica por su **tema**, que es el evento de dominio tal cual:
 * `<dominio>.<entidad>.<acción>` (`clinical.session.closed`). Lo que interesa es el
 * **dominio**, porque dice qué módulo cambió sus datos, así que el mapa se escribe por
 * dominio y no por evento: un evento nuevo de un dominio conocido funciona sin tocar esto.
 */
const AGENDA = [
  schedulingKeys.daysRoot,
  schedulingKeys.appointmentsRoot,
  schedulingKeys.historyRoot,
  schedulingKeys.requestsRoot,
  // La sección de citas de la bandeja vive de la agenda (ADR 0052): confirmar una
  // cita tiene que refrescarla sin esperar a que el usuario recargue.
  notificationKeys.appointmentsRoot,
] as const;

/** Historia clínica, odontograma y —lo que se ve en la caja— el borrador que nace. */
const CLINICA = [['clinica'], ['odontograma'], ['billing']] as const;

const CAJA = [['billing']] as const;

const PACIENTES = [['pacientes'], ['paciente']] as const;

const NOTIFICACIONES = [
  notificationKeys.listRoot,
  notificationKeys.status,
  notificationKeys.channelsRoot,
] as const;

const POR_DOMINIO: Readonly<Record<string, readonly (readonly unknown[])[]>> = {
  scheduling: AGENDA,
  /**
   * Cerrar una sesión cierra la visita: cambia la historia (`clinica`), el odontograma que
   * se registró dentro de ella, el estado de la cita en la jornada y del lado de la caja
   * aparece un borrador por cobrar. Todo eso se invalida junto.
   */
  clinical: [...CLINICA, ...AGENDA],
  billing: CAJA,
  odontogram: [['odontograma'], ['clinica']],
  patients: PACIENTES,
  notifications: NOTIFICACIONES,
  identity: [['usuarios']],
  screens: [],
};

/** El dominio del tema: `clinical.session.closed` → `clinical`. */
export const dominioDe = (topic: string): string => topic.split('.')[0] ?? '';

/**
 * Claves raíz que un aviso deja obsoletas. Un tema desconocido devuelve la lista vacía
 * —no se inventa nada: si el servidor avisa de algo que esta versión no entiende, no se
 * recarga por recargar—.
 */
export const invalidacionesDe = (topic: string): readonly (readonly unknown[])[] =>
  POR_DOMINIO[dominioDe(topic)] ?? [];

/* ── El flujo en vivo ──────────────────────────────────────────────────────── */

/** Ruta del canal del personal a través del gateway. */
export const STAFF_STREAM_PATH = '/screens/staff/stream';

export interface StaffStreamHandlers {
  /** Un aviso del servidor: qué cambió (el «listo» inicial también entra por aquí). */
  onSenal: (senal: StaffSignal) => void;
  /** La conexión se abrió (o se recuperó) o se perdió, para poder avisar en pantalla. */
  onConexion?: (conectada: boolean) => void;
  /** Fallo al leer el flujo (no corta la reconexión: se vuelve a intentar). */
  onError?: (error: unknown) => void;
}

/** Lee defensivamente el cuerpo de un aviso: lo escribe el servidor, no se da por hecho. */
const leerSenal = (datos: string): StaffSignal | null => {
  try {
    const valor = JSON.parse(datos) as Partial<StaffSignal>;
    if (typeof valor.topic !== 'string' || valor.topic === '') return null;
    return {
      topic: valor.topic,
      at: typeof valor.at === 'string' ? valor.at : new Date().toISOString(),
      aggregateId: typeof valor.aggregateId === 'string' ? valor.aggregateId : null,
    };
  } catch {
    return null;
  }
};

const ESPERA_MAXIMA_MS = 15_000;

/** Espera que se corta en seco si el flujo se cierra: el cierre no tarda 15 s. */
const esperar = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const despertar = (): void => {
      clearTimeout(tic);
      resolve();
    };
    const tic = setTimeout(() => {
      signal.removeEventListener('abort', despertar);
      resolve();
    }, ms);
    signal.addEventListener('abort', despertar, { once: true });
  });

/**
 * Abre el canal del personal y lo mantiene abierto: si se cae, reintenta con espera
 * creciente hasta que se cierre. Devuelve la función para cerrarlo.
 *
 * Se pide **con la sesión**: el token de acceso vive en memoria (`getAccessToken`), así
 * que cada intento lo vuelve a leer y una renovación por el camino se nota sola. Si el
 * servidor responde 401/403 se intenta **una** renovación de la sesión antes de reintentar
 * —un token vencido con la cookie viva es lo normal, no un fallo—, y la espera crece
 * también en ese caso: si la cookie está muerta, no se martillea el servidor.
 */
export const abrirFlujoStaff = (handlers: StaffStreamHandlers): (() => void) => {
  const controlador = new AbortController();
  let espera = 1_000;
  let cerrado = false;

  /** Un intento: abre el flujo y lo consume hasta que el servidor lo cierra. */
  const intento = async (): Promise<void> => {
    const token = getAccessToken();
    if (token === null) {
      // Sin sesión no hay canal que abrir; se reintenta por si la sesión vuelve.
      handlers.onConexion?.(false);
      return;
    }

    const respuesta = await fetch(`${API_BASE}${STAFF_STREAM_PATH}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'text/event-stream',
      },
      signal: controlador.signal,
    });

    if (respuesta.status === 401 || respuesta.status === 403) {
      handlers.onConexion?.(false);
      // Token vencido: se renueva (deduplicado); si tampoco, la espera hace su trabajo.
      await refreshSession().catch(() => undefined);
      return;
    }

    if (!respuesta.ok) {
      handlers.onConexion?.(false);
      return;
    }

    // Conectado: la próxima reconexión vuelve a empezar con la espera corta.
    espera = 1_000;
    await leerTramas(respuesta, (trama) => {
      if (trama.evento !== STAFF_CHANNEL) return;
      const senal = leerSenal(trama.datos);
      if (senal === null) return;
      handlers.onConexion?.(true);
      // El aviso de «listo» confirma la conexión, pero no invalida nada.
      if (senal.topic === STAFF_READY_TOPIC) return;
      handlers.onSenal(senal);
    });
    handlers.onConexion?.(false);
  };

  const ciclo = async (): Promise<void> => {
    while (!cerrado) {
      try {
        await intento();
      } catch (error) {
        handlers.onConexion?.(false);
        // Un `abort` es el cierre pedido, no un fallo: se sale sin ruido.
        if (controlador.signal.aborted) return;
        handlers.onError?.(error);
      }

      await esperar(espera, controlador.signal);
      espera = Math.min(espera * 2, ESPERA_MAXIMA_MS);
    }
  };

  void ciclo();

  return () => {
    cerrado = true;
    controlador.abort();
  };
};
