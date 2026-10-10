import { dentistViewSchema, type DentistView } from '@odontocrm/contracts';
import { z } from 'zod';

import type { SchedulingConfig } from '../config.js';

const dentistsResponseSchema = z.object({
  items: z.array(dentistViewSchema),
  total: z.number().int().min(0),
});

/**
 * Catálogo `dentistId → nombre` de los odontólogos con perfil, leído al servicio de
 * identidad por la **red interna** (sin pasar por el gateway).
 *
 * La cita guarda solo `dentist_id` (un uuid del usuario), no su nombre: el nombre es
 * un dato vivo —se corrige en «Mi perfil» y cambia el membrete de todo— así que se
 * resuelve al vuelo y no se duplica en la agenda. Como cambia poco, el catálogo se
 * **cachea** unos minutos y se refresca solo; si identity no responde, se sirve lo
 * último bueno (o un mapa vacío) y las citas salen sin nombre de odontólogo, nunca
 * rotas.
 */
export interface DentistCatalog {
  /** Mapa `id → nombre`; vacío si nunca se pudo leer. */
  (): Promise<ReadonlyMap<string, string>>;
}

const TTL_MS = 5 * 60_000;
const TIMEOUT_MS = 5_000;

export const createDentistCatalog = (
  config: Pick<SchedulingConfig, 'IDENTITY_URL' | 'INTERNAL_SERVICE_SECRET'>,
): DentistCatalog => {
  const base = config.IDENTITY_URL;
  const secret = config.INTERNAL_SERVICE_SECRET;

  let cache: { at: number; value: Map<string, string> } | null = null;
  // Deduplica lecturas simultáneas: la jornada pide el catálogo una vez por request
  // y sin esto serían N llamadas al mismo endpoint en el mismo instante.
  let inFlight: Promise<Map<string, string>> | null = null;

  const fetchCatalog = async (): Promise<Map<string, string>> => {
    try {
      const response = await fetch(`${base}/internal/v1/identity/dentists`, {
        headers: { 'x-internal-token': secret ?? '' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) return cache?.value ?? new Map();

      const parsed = dentistsResponseSchema.safeParse(await response.json());
      if (!parsed.success) return cache?.value ?? new Map();

      return new Map(
        parsed.data.items
          .filter((dentist): dentist is DentistView => dentist.fullName.length > 0)
          .map((dentist) => [dentist.id, dentist.fullName]),
      );
    } catch {
      return cache?.value ?? new Map();
    }
  };

  return async () => {
    // Sin secreto compartido las rutas internas están apagadas: mapa vacío.
    if (secret === undefined) return new Map();

    const now = Date.now();
    if (cache !== null && now - cache.at < TTL_MS) return cache.value;
    if (inFlight !== null) return inFlight;

    inFlight = fetchCatalog()
      .then((value) => {
        cache = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
};
