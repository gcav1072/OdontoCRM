import type { SystemMeta } from '@odontocrm/contracts';

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
