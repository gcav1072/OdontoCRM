import type { PatientDetail } from '@odontocrm/contracts';

import type { ScreensConfig } from './config.js';
import type { PatientLookup } from './sala/estado-service.js';

/**
 * Lectura puntual de la ficha del paciente para la pantalla del consultorio.
 *
 * Va por la red interna (127.0.0.1) con el secreto compartido, no por el gateway:
 * es una lectura entre servicios. Si el servicio de pacientes no responde, la
 * cita entra igual: la pantalla simplemente no muestra edad ni sexo.
 */
export const createPatientLookup = (
  config: Pick<ScreensConfig, 'PATIENTS_URL' | 'INTERNAL_SERVICE_SECRET'>,
): ((patientId: string) => Promise<PatientLookup | null>) => {
  const base = config.PATIENTS_URL;

  return async (patientId: string) => {
    try {
      const response = await fetch(
        `${base}/internal/v1/patients/${encodeURIComponent(patientId)}`,
        {
          headers: { 'x-internal-token': config.INTERNAL_SERVICE_SECRET ?? '' },
          signal: AbortSignal.timeout(5_000),
        },
      );
      if (!response.ok) return null;

      const ficha = (await response.json()) as Partial<PatientDetail>;
      return {
        birthDate: typeof ficha.birthDate === 'string' ? ficha.birthDate : null,
        sex: typeof ficha.sex === 'string' ? ficha.sex : null,
      };
    } catch {
      return null;
    }
  };
};
