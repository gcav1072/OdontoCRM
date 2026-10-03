import type {
  ConsultationState,
  LobbyState,
  ScreenSettings,
  ScreenStreamEvent,
} from '@odontocrm/contracts';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';

import { isApiError } from '../../lib/api';
import { screensApi } from '../../lib/endpoints';
import {
  abrirFlujoKiosko,
  createKioskSession,
  readKioskToken,
  saveKioskToken,
  takeTokenFromUrl,
  type KioskSessionManager,
  type KioskState,
} from '../../lib/kiosko';
import { SCREEN_REFRESH_MS, screenKeys } from '../../lib/screens';

/**
 * Estado de una pantalla kiosko.
 *
 * La pantalla no tiene sesión de usuario: se configura una vez con su token de
 * dispositivo y a partir de ahí todo es automático. Este hook concentra ese
 * ciclo para que las dos pantallas (`lobby` y `consultorio`) se limiten a pintar:
 *
 * 1. toma el token de la URL (solo la primera vez) o del almacenamiento local;
 * 2. lo canjea por un JWT con `createKioskSession`;
 * 3. abre el flujo SSE con `abrirFlujoKiosko` y lo cierra al desmontar;
 * 4. refresca por HTTP cada `SCREEN_REFRESH_MS` **como respaldo**: si el SSE se
 *    cayó en silencio, el estado se corrige con la consulta siguiente. Se aplica
 *    el más reciente de los dos, comparando su `updatedAt`.
 */

/** Estado que entrega cada tipo de pantalla. */
export interface KioskStateMap {
  lobby: LobbyState;
  consultorio: ConsultationState;
}

export type KioskKind = Extract<ScreenStreamEvent, 'lobby' | 'consultorio'>;

export interface UseKioskStateResult<K extends KioskKind> {
  /** Último estado recibido (por SSE o por el refresco de respaldo). */
  estado: KioskStateMap[K] | null;
  /** La pantalla todavía no está configurada en este equipo (no hay token). */
  sinToken: boolean;
  /** Nombre de la pantalla según su token (`device.label`). */
  dispositivo: string | null;
  /** Ajustes del dispositivo (voz, volumen, resalte): los pone la administración. */
  ajustes: ScreenSettings | null;
  /** Hay flujo abierto: si no, la pantalla avisa de que está reintentando. */
  conectada: boolean;
  /** El token no sirve (revocado, desactivado o de otro tipo de pantalla). */
  sinPermiso: boolean;
  reintentar: () => void;
}

/**
 * Se queda con el estado más nuevo de los dos (SSE y respaldo HTTP pueden llegar
 * en cualquier orden y repetirse: el `updatedAt` decide).
 */
const masReciente = <T extends KioskState>(actual: T | null, nuevo: T): T =>
  actual === null || new Date(nuevo.updatedAt).getTime() >= new Date(actual.updatedAt).getTime()
    ? nuevo
    : actual;

/**
 * Consulta del respaldo HTTP, con el tipo atado al `kind`.
 *
 * El único `as` del hook está aquí, en una función de tres líneas con tipo de
 * retorno explícito: React Query no puede correlacionar el `kind` genérico con
 * el tipo que devuelve cada endpoint, y repartirlo por el hook sería peor.
 */
const opcionesRespaldo = <K extends KioskKind>(
  kind: K,
  activa: boolean,
): {
  queryKey: (typeof screenKeys)[K];
  queryFn: (contexto: { signal: AbortSignal }) => Promise<KioskStateMap[K]>;
  enabled: boolean;
  refetchInterval: number;
} => ({
  queryKey: screenKeys[kind],
  queryFn: ({ signal }) =>
    (kind === 'lobby' ? screensApi.lobby(signal) : screensApi.consultorio(signal)) as Promise<
      KioskStateMap[K]
    >,
  enabled: activa,
  refetchInterval: SCREEN_REFRESH_MS,
});

export const useKioskState = <K extends KioskKind>(kind: K): UseKioskStateResult<K> => {
  const [estado, setEstado] = useState<KioskStateMap[K] | null>(null);
  const [dispositivo, setDispositivo] = useState<string | null>(null);
  const [conectada, setConectada] = useState(false);
  const [sinPermiso, setSinPermiso] = useState(false);
  const [intento, setIntento] = useState(0);
  /**
   * Contador que sube cada vez que hay una sesión de dispositivo lista.
   *
   * El paso 1 guarda el gestor de sesión en un `ref` (fuera del render), así que
   * el paso 2 necesita algo que le avise: este contador es esa señal. Sin él, el
   * flujo podría abrirse en el mismo commit en el que la sesión todavía no está
   * y la pantalla se quedaría muda.
   */
  const [sesionLista, setSesionLista] = useState(0);

  /**
   * `undefined` = todavía no se sabe; `null` = no hay token configurado.
   *
   * Se resuelve **una sola vez** por montaje: el token de la URL se quita de la
   * barra de direcciones al guardarlo, así que no puede depender del render.
   * `takeTokenFromUrl` es idempotente (si ya no está, devuelve `null`), por eso
   * el doble montaje de StrictMode no deja la pantalla sin token.
   */
  const [token, setToken] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    const deUrl = takeTokenFromUrl(kind);
    if (deUrl !== null) {
      // El token solo viaja en la URL una vez: se guarda y se borra de ahí.
      saveKioskToken(kind, deUrl);
      setToken(deUrl);
      return;
    }
    setToken(readKioskToken(kind));
    // `kind` es fijo durante toda la vida de la pantalla.
  }, [kind]);

  // Respaldo por HTTP. Sin token no se pide: daría 401 y confundiría.
  const respaldoQuery = useQuery(opcionesRespaldo(kind, token !== undefined && token !== null));

  const respaldo = respaldoQuery.data;
  useEffect(() => {
    if (respaldo === undefined) return;
    setEstado((actual) => masReciente(actual, respaldo));
  }, [respaldo]);

  /**
   * Sesión del dispositivo, creada una vez por intento. Guardarla en un `ref`
   * evita volver a canjear el token en cada render (el JWT se renueva solo).
   */
  const sesionRef = useRef<KioskSessionManager | null>(null);

  // Paso 1: canjear el token. De aquí sale el `kind` real del dispositivo.
  useEffect(() => {
    if (token === undefined || token === null) return;

    let activo = true;
    sesionRef.current = null;
    const sesion = createKioskSession(token);
    setSinPermiso(false);

    void sesion
      .vigente()
      .then((actual) => {
        if (!activo) return;
        setDispositivo(actual.device.label);
        // El token de una pantalla de sala no sirve en el consultorio (ni al
        // revés): el servidor rechazaría el flujo, así que se avisa aquí.
        if (actual.device.kind !== kind) setSinPermiso(true);
        else {
          sesionRef.current = sesion;
          setSesionLista((valor) => valor + 1);
        }
      })
      .catch((error: unknown) => {
        // 401/403: el token fue revocado o la pantalla está desactivada.
        if (activo && isApiError(error) && (error.status === 401 || error.status === 403)) {
          setSinPermiso(true);
        }
      });

    return () => {
      activo = false;
    };
  }, [token, kind, intento]);

  // Paso 2: flujo en vivo. Se abre cuando la sesión ya es válida y se cierra al
  // desmontar (o al reintentar), que es lo que exige `abrirFlujoKiosko`.
  useEffect(() => {
    if (token === undefined || token === null) return;

    let cerrar: (() => void) | null = null;
    let cancelado = false;

    const arrancar = async (): Promise<void> => {
      const sesion = sesionRef.current;
      if (sesion === null) return;
      const actual = await sesion.vigente();
      if (cancelado || actual.device.kind !== kind) return;

      cerrar = abrirFlujoKiosko(kind, sesion, {
        onEstado: (nuevo) => setEstado((previo) => masReciente(previo, nuevo as KioskStateMap[K])),
        onConexion: (abierta) => {
          if (abierta) setSinPermiso(false);
          setConectada(abierta);
        },
        onError: (error) => {
          setConectada(false);
          // El token puede haberse revocado mientras la pantalla estaba abierta.
          if (isApiError(error) && (error.status === 401 || error.status === 403)) {
            setSinPermiso(true);
          }
        },
      });
    };

    void arrancar();

    return () => {
      cancelado = true;
      cerrar?.();
    };
    // `sesionLista` vuelve a lanzar este efecto cuando el paso 1 termina.
  }, [token, kind, intento, sesionLista]);

  const reintentar = useCallback(() => setIntento((valor) => valor + 1), []);

  /**
   * Ajustes del dispositivo (voz, volumen, segundos de resalte). Viven en el
   * servicio de pantallas, no en identity, así que se piden aparte en cuanto la
   * sesión está lista; sin ellos la pantalla usa los valores por defecto.
   */
  const { data: ficha } = useQuery({
    queryKey: screenKeys.dispositivo,
    queryFn: ({ signal }) => screensApi.actual(signal),
    enabled: sesionLista > 0,
  });

  return {
    estado,
    sinToken: token === null,
    dispositivo,
    ajustes: ficha?.settings ?? null,
    conectada,
    sinPermiso,
    reintentar,
  };
};
