import type { PatientDetail } from '@odontocrm/contracts';

import type { BillingConfig } from '../config.js';

/**
 * La **instantánea** del paciente que se copia al documento (ADR 0048): el papel no cambia si mañana
 * el paciente corrige sus datos.
 *
 * El RIF y la dirección fiscal van vacíos porque la ficha del paciente **no los guarda** todavía (el
 * RIF es opcional: consumidor final salvo que lo pidan). El día que se capturen, se rellenan aquí.
 */
export interface BillingPatientSnapshot {
  patientId: string;
  fullName: string;
  docType: string;
  docNumber: string;
  taxId: string | null;
  fiscalAddress: string | null;
}

export type BillingPatientLookup = (patientId: string) => Promise<BillingPatientSnapshot | null>;

/**
 * Ficha mínima del paciente por la **red interna** (127.0.0.1) con el secreto compartido, nunca por el
 * gateway. Devuelve `null` si el servicio no responde o la ficha no es válida: quien decide qué hacer
 * con eso es el consumidor (que reintenta), no este cliente.
 */
export const createBillingPatientLookup = (
  config: Pick<BillingConfig, 'PATIENTS_URL' | 'INTERNAL_SERVICE_SECRET'>,
): BillingPatientLookup => {
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

      return {
        patientId: ficha.id,
        fullName: ficha.fullName,
        docType: typeof ficha.docType === 'string' ? ficha.docType : 'V',
        docNumber: typeof ficha.docNumber === 'string' ? ficha.docNumber : '',
        taxId: null,
        fiscalAddress: null,
      };
    } catch {
      return null;
    }
  };
};
