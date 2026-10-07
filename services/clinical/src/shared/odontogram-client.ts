import type { Dentition, ToothFindingRecord } from '@odontocrm/contracts';

import type { ClinicalConfig } from '../config.js';

/**
 * La boca del paciente, leída del servicio de **odontograma** para poder dibujarla.
 *
 * Va por la red interna (127.0.0.1) con el secreto compartido, nunca por el gateway —el
 * mismo camino que la ficha del paciente— y **degrada limpio**: si el odontograma no
 * responde, el dossier sale igual con el aviso de que no hay hallazgos registrados. Es
 * preferible un expediente sin el dibujo que un expediente que no se puede emitir.
 */
export interface OdontogramChart {
  dentition: Dentition | null;
  findings: Record<string, readonly ToothFindingRecord[]>;
}

export type OdontogramChartLookup = (patientId: string) => Promise<OdontogramChart>;

/** Lo que se devuelve cuando el odontograma no se pudo leer o el paciente no tiene. */
const SIN_ODONTOGRAMA: OdontogramChart = { dentition: null, findings: {} };

export const createOdontogramChartLookup = (
  config: Pick<ClinicalConfig, 'ODONTOGRAM_URL' | 'INTERNAL_SERVICE_SECRET'>,
): OdontogramChartLookup => {
  const base = config.ODONTOGRAM_URL;

  return async (patientId) => {
    try {
      const response = await fetch(
        `${base}/internal/v1/odontogram/patients/${encodeURIComponent(patientId)}/chart`,
        {
          headers: { 'x-internal-token': config.INTERNAL_SERVICE_SECRET ?? '' },
          signal: AbortSignal.timeout(5_000),
        },
      );
      if (!response.ok) return SIN_ODONTOGRAMA;

      const cuerpo = (await response.json()) as {
        hasOdontogram?: unknown;
        dentition?: unknown;
        findings?: unknown;
      };
      if (cuerpo.hasOdontogram !== true) return SIN_ODONTOGRAMA;

      return {
        dentition: (typeof cuerpo.dentition === 'string'
          ? cuerpo.dentition
          : null) as Dentition | null,
        findings:
          typeof cuerpo.findings === 'object' && cuerpo.findings !== null
            ? (cuerpo.findings as Record<string, readonly ToothFindingRecord[]>)
            : {},
      };
    } catch {
      return SIN_ODONTOGRAMA;
    }
  };
};
