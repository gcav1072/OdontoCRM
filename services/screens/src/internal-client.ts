import {
  clinicalAlertsSchema,
  criticalFlagsFromAlerts,
  type CriticalFlag,
  type PatientDetail,
} from '@odontocrm/contracts';

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

/**
 * Datos críticos del paciente **en curso**, leídos de la historia clínica.
 *
 * La pantalla del consultorio los pinta con semáforo de riesgo, y se leen al
 * construir el estado (no se empujan desde el servicio clínico) porque el dato
 * tiene que estar bien **en el momento de mirarlo**: el doctor puede llenar la
 * anamnesis con el paciente ya sentado, y una alergia recién escrita no puede
 * quedarse esperando a que alguien la empuje.
 *
 * Devuelve `null` —y no una lista vacía— cuando no se pudo preguntar: la pantalla
 * distingue «no tiene alergias» de «no pude comprobarlo».
 */
export type ClinicalAlertLookup = (patientId: string) => Promise<CriticalFlag[] | null>;

export const createAlertLookup = (
  config: Pick<ScreensConfig, 'CLINICAL_URL' | 'INTERNAL_SERVICE_SECRET'>,
): ClinicalAlertLookup => {
  const base = config.CLINICAL_URL;
  const secret = config.INTERNAL_SERVICE_SECRET;

  return async (patientId: string) => {
    if (secret === undefined) return null;

    try {
      const response = await fetch(
        `${base}/internal/v1/clinical/patients/${encodeURIComponent(patientId)}/alerts`,
        { headers: { 'x-internal-token': secret }, signal: AbortSignal.timeout(5_000) },
      );
      if (!response.ok) return null;

      const parsed = clinicalAlertsSchema.safeParse(await response.json());
      return parsed.success ? criticalFlagsFromAlerts(parsed.data.alerts) : null;
    } catch {
      return null;
    }
  };
};
