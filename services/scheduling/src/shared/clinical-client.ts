import {
  clinicalSessionStatusLookupSchema,
  type ClinicalSessionStatusLookup,
} from '@odontocrm/contracts';

import type { SchedulingConfig } from '../config.js';

/**
 * Consulta del estado de una sesión clínica por la **red interna** (con el
 * secreto compartido, sin pasar por el gateway).
 *
 * Existe por una razón concreta: `POST /appointments/:id/attend` aceptaba un
 * `clinicalSessionId` que venía del cliente y **no comprobaba nada**, así que
 * cualquiera podía saltarse el motivo obligatorio mandando un identificador
 * inventado. Ahora la agenda pregunta al servicio clínico si esa sesión existe,
 * es del mismo paciente y está **cerrada**; si no puede comprobarlo, no lo cree.
 */
export type ClinicalSessionLookup = (
  sessionId: string,
) => Promise<ClinicalSessionStatusLookup | null>;

export const createClinicalSessionLookup = (
  config: Pick<SchedulingConfig, 'CLINICAL_URL' | 'INTERNAL_SERVICE_SECRET'>,
): ClinicalSessionLookup => {
  const base = config.CLINICAL_URL;
  const secret = config.INTERNAL_SERVICE_SECRET;

  return async (sessionId: string) => {
    // Sin secreto compartido las rutas internas están apagadas: no se puede
    // comprobar la sesión, así que se trata como «no verificada».
    if (secret === undefined) return null;

    try {
      const response = await fetch(
        `${base}/internal/v1/clinical/sessions/${encodeURIComponent(sessionId)}/status`,
        { headers: { 'x-internal-token': secret }, signal: AbortSignal.timeout(5_000) },
      );
      if (!response.ok) return null;

      const parsed = clinicalSessionStatusLookupSchema.safeParse(await response.json());
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  };
};
