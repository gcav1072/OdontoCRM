import type {
  ConsultationState,
  DeviceLoginResponse,
  LobbyState,
  ScreenStreamEvent,
} from '@odontocrm/contracts';

import { API_BASE } from './api';
import { authApi } from './endpoints';
import { leerTramas } from './sse';

/**
 * Cliente de las **pantallas kiosko** (Fase 5).
 *
 * Una pantalla no tiene usuario ni cookie: se configura una vez con su **token de
 * dispositivo** (`/pantalla/lobby?token=…`), lo guarda en el equipo y lo canjea
 * por un JWT de 15 minutos de rol `pantalla` (solo `screens:display`). El JWT se
 * renueva solo antes de caducar y el estado llega por **SSE**.
 *
 * El flujo se abre con `fetch` —y no con `EventSource`— porque `EventSource` no
 * permite mandar la cabecera `Authorization`; a cambio, aquí se maneja la
 * reconexión a mano (`retry`) y el `Last-Event-ID`.
 */

export type KioskKind = Extract<ScreenStreamEvent, 'lobby' | 'consultorio'>;

export type KioskState = LobbyState | ConsultationState;

const STORAGE_PREFIX = 'odontocrm:kiosko:';

export const kioskStorageKey = (kind: KioskKind): string => `${STORAGE_PREFIX}${kind}`;

export const readKioskToken = (kind: KioskKind): string | null => {
  try {
    return window.localStorage.getItem(kioskStorageKey(kind));
  } catch {
    return null;
  }
};

export const saveKioskToken = (kind: KioskKind, token: string): void => {
  try {
    window.localStorage.setItem(kioskStorageKey(kind), token);
  } catch {
    // Sin almacenamiento la pantalla funciona hasta que se recargue: no es crítico.
  }
};

export const clearKioskToken = (kind: KioskKind): void => {
  try {
    window.localStorage.removeItem(kioskStorageKey(kind));
  } catch {
    // Ignorado a propósito.
  }
};

/**
 * Toma el token de la barra de direcciones (una sola vez) y lo **guarda** en el
 * equipo: el enlace con el token acaba en el historial del navegador y en los
 * registros del proxy, así que se borra de la URL en cuanto se adopta.
 */
export const takeTokenFromUrl = (kind: KioskKind): string | null => {
  const url = new URL(window.location.href);
  const token = url.searchParams.get('token');
  if (token === null || token.trim() === '') return null;

  url.searchParams.delete('token');
  window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);

  const limpio = token.trim();
  saveKioskToken(kind, limpio);
  return limpio;
};

export interface KioskSession {
  token: string;
  expiresAt: number;
  device: DeviceLoginResponse['device'];
}

/** Canjea el token de dispositivo por un JWT (renovado con margen de 1 minuto). */
export const createKioskSession = (deviceToken: string) => {
  let current: KioskSession | null = null;

  const renovar = async (): Promise<KioskSession> => {
    const respuesta = await authApi.deviceLogin(deviceToken);
    current = {
      token: respuesta.accessToken,
      expiresAt: Date.now() + respuesta.expiresIn * 1000,
      device: respuesta.device,
    };
    return current;
  };

  return {
    /** Sesión válida, renovándola si hace falta. */
    vigente: async (): Promise<KioskSession> => {
      if (current !== null && current.expiresAt - Date.now() > 60_000) return current;
      return renovar();
    },
    olvidar: (): void => {
      current = null;
    },
  };
};

export type KioskSessionManager = ReturnType<typeof createKioskSession>;

export interface StreamHandlers {
  onEstado: (estado: KioskState) => void;
  /** La conexión se abrió (o se recuperó) o se perdió. */
  onConexion?: (conectada: boolean) => void;
  onError?: (error: unknown) => void;
}

/** Lee el `text/event-stream` de la pantalla y aplica cada estado. */
const consumirFlujo = async (
  respuesta: Response,
  kind: KioskKind,
  handlers: StreamHandlers,
  ultimoId: { valor: string | null },
): Promise<void> => {
  // El reparto de tramas lo hace `lib/sse.ts`, el mismo módulo que lee el canal del
  // personal: el protocolo se interpreta en un solo sitio.
  await leerTramas(respuesta, (trama) => {
    if (trama.id !== null) ultimoId.valor = trama.id;
    // La pantalla solo pinta su propio tipo: la trama de otro canal se ignora.
    if (trama.evento !== kind) return;

    try {
      handlers.onEstado(JSON.parse(trama.datos) as KioskState);
      handlers.onConexion?.(true);
    } catch (error) {
      handlers.onError?.(error);
    }
  });
};

export interface AbrirFlujoOptions extends StreamHandlers {
  /** Espera entre reconexiones (crece hasta 15 s). */
  esperaInicialMs?: number;
}

/**
 * Abre el flujo de la pantalla y lo mantiene abierto: si se cae, reintenta con
 * espera creciente hasta que se cancele. Devuelve la función para cerrarlo.
 */
export const abrirFlujoKiosko = (
  kind: KioskKind,
  sesion: KioskSessionManager,
  options: AbrirFlujoOptions,
): (() => void) => {
  const controlador = new AbortController();
  const ultimoId: { valor: string | null } = { valor: null };
  let espera = options.esperaInicialMs ?? 1_000;
  let cerrado = false;

  const ciclo = async (): Promise<void> => {
    while (!cerrado) {
      try {
        const actual = await sesion.vigente();
        const respuesta = await fetch(`${API_BASE}/screens/${kind}/stream`, {
          headers: {
            Authorization: `Bearer ${actual.token}`,
            Accept: 'text/event-stream',
            ...(ultimoId.valor === null ? {} : { 'Last-Event-ID': ultimoId.valor }),
          },
          signal: controlador.signal,
        });

        if (respuesta.status === 401 || respuesta.status === 403) {
          sesion.olvidar();
          options.onError?.(new Error('La pantalla no está autorizada'));
          await new Promise((resolve) => setTimeout(resolve, 5_000));
          continue;
        }
        if (!respuesta.ok) throw new Error(`El flujo respondió ${String(respuesta.status)}`);

        espera = options.esperaInicialMs ?? 1_000;
        await consumirFlujo(respuesta, kind, options, ultimoId);
        options.onConexion?.(false);
      } catch (error) {
        if (cerrado || controlador.signal.aborted) return;
        options.onConexion?.(false);
        options.onError?.(error);
      }

      if (cerrado) return;
      await new Promise((resolve) => setTimeout(resolve, espera));
      espera = Math.min(espera * 2, 15_000);
    }
  };

  void ciclo();

  return () => {
    cerrado = true;
    controlador.abort();
  };
};
