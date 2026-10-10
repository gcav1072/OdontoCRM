import {
  chairListSchema,
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

/**
 * Catálogo de **consultorios activos**, leído al servicio de agenda por la red interna.
 * La pantalla del consultorio es una sola TV compartida: pinta un tile por sillón, así
 * que necesita saber **cuáles** hay. Es un dato que cambia poco, así que se cachea.
 */
export interface ChairLite {
  id: string;
  label: string;
  shortLabel: string | null;
  sortOrder: number;
}

export type ChairCatalog = () => Promise<readonly ChairLite[]>;

const CHAIRS_TTL_MS = 60_000;

export const createChairCatalog = (
  config: Pick<ScreensConfig, 'SCHEDULING_URL' | 'INTERNAL_SERVICE_SECRET'>,
): ChairCatalog => {
  const base = config.SCHEDULING_URL;
  const secret = config.INTERNAL_SERVICE_SECRET;

  let cache: { at: number; value: ChairLite[] } | null = null;
  let inFlight: Promise<ChairLite[]> | null = null;

  const fetchChairs = async (): Promise<ChairLite[]> => {
    try {
      const response = await fetch(`${base}/internal/v1/agenda/chairs`, {
        headers: { 'x-internal-token': secret ?? '' },
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) return cache?.value ?? [];

      const body = (await response.json()) as { items?: unknown };
      if (!Array.isArray(body.items)) return cache?.value ?? [];

      const parsed = chairListSchema.safeParse(body);
      if (!parsed.success) return cache?.value ?? [];

      return parsed.data.items
        .filter((chair) => chair.isActive)
        .sort((left, right) => left.sortOrder - right.sortOrder)
        .map((chair) => ({
          id: chair.id,
          label: chair.label,
          shortLabel: chair.shortLabel,
          sortOrder: chair.sortOrder,
        }));
    } catch {
      return cache?.value ?? [];
    }
  };

  return async () => {
    if (secret === undefined) return [];
    const now = Date.now();
    if (cache !== null && now - cache.at < CHAIRS_TTL_MS) return cache.value;
    if (inFlight !== null) return inFlight;

    inFlight = fetchChairs()
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
