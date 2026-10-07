import type { SystemHealthReport, SystemMeta } from '@odontocrm/contracts';

import { api } from './api';

/**
 * `GET /api/v1/meta` — estado del sistema: versión, entorno y modo test.
 *
 * Es **público** (no manda token y no intenta renovar la sesión): el banner de
 * MODO TEST tiene que verse en la pantalla de acceso y en las pantallas kiosko,
 * donde no hay sesión de usuario.
 */
export const fetchSystemMeta = (signal?: AbortSignal): Promise<SystemMeta> =>
  api.get<SystemMeta>('/meta', {
    anonymous: true,
    skipRefresh: true,
    ...(signal === undefined ? {} : { signal }),
  });

/** Clave de TanStack Query del estado del sistema (una sola vez por pestaña). */
export const SYSTEM_META_QUERY_KEY = ['sistema', 'meta'] as const;

/**
 * `GET /api/v1/system/health/detailed` — estado **consolidado** de los servicios.
 *
 * Solo el administrador la puede pedir (el gateway responde 403 a los demás), así que se
 * consulta únicamente cuando el panel va a pintarse. Se refresca cada medio minuto: es un
 * panel de diagnóstico que se deja abierto, y cada consulta hace que la puerta pregunte a
 * los nueve servicios.
 */
export const fetchSystemHealth = (signal?: AbortSignal): Promise<SystemHealthReport> =>
  api.get<SystemHealthReport>('/system/health/detailed', {
    ...(signal === undefined ? {} : { signal }),
  });

/** Clave de TanStack Query del panel de estado (solo la usa el administrador). */
export const SYSTEM_HEALTH_QUERY_KEY = ['sistema', 'health'] as const;

/** Cada cuánto se refresca el panel mientras está abierto. */
export const SYSTEM_HEALTH_REFRESH_MS = 30_000;
