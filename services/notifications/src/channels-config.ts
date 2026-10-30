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
export interface ChannelCredentialsLookup {
  (): Promise<ChannelCredentials | null>;
  /**
   * Tira la caché para que la próxima lectura pregunte a identity. Lo usa la
   * recarga **forzada**: cuando el admin acaba de guardar el interruptor de
   * WhatsApp, no se puede esperar al minuto de caché + el minuto del sondeo.
   */
  invalidar: () => void;
}

export const createChannelCredentialsLookup = (
  config: NotificationsConfig,
): ChannelCredentialsLookup => {
  const secret = config.INTERNAL_SERVICE_SECRET;
  const timeoutMs = 5_000;

  let cache: { creds: ChannelCredentials; expiresAt: number } | null = null;
  let inFlight: Promise<ChannelCredentials | null> | null = null;
  /** Generación de la caché: una lectura vieja no puede repoblarla tras invalidar. */
  let generacion = 0;

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

  const lookup = (async () => {
    if (cache !== null && cache.expiresAt > Date.now()) return cache.creds;

    const lectura = generacion;
    if (inFlight === null) {
      inFlight = fetchOnce().finally(() => {
        // Si mientras tanto se invalidó, la promesa nueva es otra: no la pisa.
        if (lectura === generacion) inFlight = null;
      });
    }
    const creds = await inFlight;
    if (creds !== null && lectura === generacion) {
      cache = { creds, expiresAt: Date.now() + 60_000 };
    }
    return creds;
  }) as ChannelCredentialsLookup;

  lookup.invalidar = () => {
    generacion += 1;
    cache = null;
    // La lectura en vuelo pertenece a la generación anterior: la próxima
    // llamada debe empezar una nueva.
    inFlight = null;
  };

  return lookup;
};
