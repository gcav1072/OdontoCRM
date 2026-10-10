import { channelCredentialsSchema, type ChannelCredentials } from '@odontocrm/contracts';

import type { NotificationsConfig } from './config.js';

/**
 * Las **credenciales de los canales** guardadas por el panel (ADR 0060), leídas de identity
 * por su ruta interna.
 *
 * Identity es el dueño de la configuración y el único con el almacén y la clave de cifrado;
 * notificaciones solo las **consume** para construir sus adaptadores. Se leen con la misma
 * caché y deduplicación que el membrete: un cambio en el panel llega en un minuto, sin
 * reiniciar.
 *
 * Sin secreto compartido (o si identity no responde) devuelve `null`: el servicio sigue con
 * su `.env`, que es el respaldo de siempre.
 */
export type ChannelCredentialsLookup = () => Promise<ChannelCredentials | null>;

export const createChannelCredentialsLookup = (
  config: NotificationsConfig,
): ChannelCredentialsLookup => {
  const secret = config.INTERNAL_SERVICE_SECRET;
  const timeoutMs = 5_000;

  let cache: { creds: ChannelCredentials; expiresAt: number } | null = null;
  let inFlight: Promise<ChannelCredentials | null> | null = null;

  const fetchOnce = async (): Promise<ChannelCredentials | null> => {
    if (secret === undefined) return null;
    try {
      const response = await fetch(new URL('/internal/v1/identity/channels', config.IDENTITY_URL), {
        headers: { 'x-internal-token': secret },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) return null;
      const parsed = channelCredentialsSchema.safeParse(await response.json());
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  };

  return async () => {
    if (cache !== null && cache.expiresAt > Date.now()) return cache.creds;

    inFlight ??= fetchOnce().finally(() => {
      inFlight = null;
    });
    const creds = await inFlight;
    if (creds !== null) cache = { creds, expiresAt: Date.now() + 60_000 };
    return creds;
  };
};
