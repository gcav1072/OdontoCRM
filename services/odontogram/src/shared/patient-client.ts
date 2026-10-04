import {
  ageFromBirthDate,
  formatDocument,
  type DocType,
  type OdontogramPatientSnapshot,
  type PatientDetail,
} from '@odontocrm/contracts';

import type { OdontogramConfig } from '../config.js';

export type PatientSnapshotLookup = (
  patientId: string,
) => Promise<OdontogramPatientSnapshot | null>;

/**
 * Ficha mínima del paciente para encabezar el odontograma (pantalla e impresión).
 *
 * Va por la red interna (127.0.0.1) con el secreto compartido, nunca por el
 * gateway, y **degrada limpio**: si el servicio de pacientes no responde, el
 * odontograma se lee igual (solo falta el encabezado).
 */
export const createPatientSnapshotLookup = (
  config: Pick<OdontogramConfig, 'PATIENTS_URL' | 'INTERNAL_SERVICE_SECRET'>,
): PatientSnapshotLookup => {
  const base = config.PATIENTS_URL;

  return async (patientId) => {
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
      if (typeof ficha.id !== 'string' || typeof ficha.fullName !== 'string') return null;

      const birthDate = typeof ficha.birthDate === 'string' ? ficha.birthDate : '';
      return {
        id: ficha.id,
        fullName: ficha.fullName,
        document:
          typeof ficha.document === 'string'
            ? ficha.document
            : formatDocument((ficha.docType ?? 'V') as DocType, ficha.docNumber ?? ''),
        birthDate,
        age: typeof ficha.age === 'number' ? ficha.age : ageFromBirthDate(birthDate || new Date()),
        sex: typeof ficha.sex === 'string' ? ficha.sex : '',
        phone: ficha.phone ?? null,
        address: ficha.address ?? null,
        occupation: ficha.occupation ?? null,
      };
    } catch {
      return null;
    }
  };
};
