import type {
  CreatePeriodontalExamInput,
  FinalizePeriodontalExamInput,
  FinalizePeriodontalExamResult,
  PeriodontalComparisonResult,
  PeriodontalExamDetail,
  PeriodontalExamListResult,
  PeriodontalExamLookup,
  PeriodontalExamMutationResult,
  PeriodontalExamStatus,
  PrintPeriodontalExamResult,
  SavePeriodontalExamInput,
} from '@odontocrm/contracts';

import { api } from './api';

/**
 * Periodontograma (v1.1): cliente de las rutas del servicio de odontograma.
 *
 * El contrato del dominio y de los DTOs vive en `@odontocrm/contracts`
 * (`domain/periodontogram.ts`); aquí solo están las llamadas. La base es
 * `/api/v1/odontogram` (la pone `api`) y el recurso, `/patients/:id/periodontograms`.
 *
 * Reglas del recurso que conviene tener presentes desde la interfaz:
 * - `latest` devuelve el examen más reciente, sea borrador o finalizado, y **no es un
 *   error** que el paciente aún no tenga ninguno (`exists: false`).
 * - El borrador se guarda con `PUT` y **revisión optimista**: si la revisión no es la
 *   vigente el servidor responde 409 y la interfaz recarga (nunca se pisan dos
 *   ediciones a ciegas).
 * - Finalizar es un cierre inmutable; descartar solo vale para borradores.
 * - Imprimir es **leer**, pero deja constancia (`printed`) para la auditoría.
 *
 * Las firmas las consume también la página de impresión: el `signal` de
 * `AbortSignal` va siempre al final para no romper las llamadas sin él.
 */

/** Filtros del listado de exámenes del paciente. */
export interface PeriodontalExamListQuery {
  status?: PeriodontalExamStatus;
  limit?: number;
}

/**
 * Clave de caché del periodontograma de un paciente. La comparten el panel, la
 * página de impresión y (si algún día lo necesita) el dossier: una sola entrada
 * para «el último examen», que es lo que se refresca tras cada mutación.
 */
export const periodontogramQueryKey = (patientId: string) =>
  ['periodontograma', patientId] as const;

/** Clave de caché de un examen concreto (vista de detalle/comparación). */
export const periodontogramExamQueryKey = (patientId: string, examId: string) =>
  ['periodontograma', patientId, examId] as const;

/** Clave del listado de exámenes: cuelga de la del paciente para invalidar en bloque. */
export const periodontogramListQueryKey = (patientId: string) =>
  [...periodontogramQueryKey(patientId), 'lista'] as const;

const base = (patientId: string): string => `/odontogram/patients/${patientId}/periodontograms`;

export const periodontogramApi = {
  /** Último examen del paciente, o `{ exists: false }` si todavía no tiene ninguno. */
  latest: (patientId: string, signal?: AbortSignal): Promise<PeriodontalExamLookup> =>
    api.get<PeriodontalExamLookup>(base(patientId) + '/latest', { signal }),

  /** Listado del más reciente al más antiguo (para la comparación y la impresión). */
  list: (
    patientId: string,
    query?: PeriodontalExamListQuery,
    signal?: AbortSignal,
  ): Promise<PeriodontalExamListResult> =>
    api.get<PeriodontalExamListResult>(base(patientId), {
      query: { status: query?.status, limit: query?.limit },
      signal,
    }),

  /** Examen completo (boca + factores de riesgo + diagnóstico firmado). */
  detail: (
    patientId: string,
    examId: string,
    signal?: AbortSignal,
  ): Promise<PeriodontalExamDetail> =>
    api.get<PeriodontalExamDetail>(`${base(patientId)}/${examId}`, { signal }),

  /**
   * Abre un examen nuevo. Las fuentes que entiende el contrato son tres:
   * `odontograma` (siembra las piezas ausentes e implantes del odontograma vigente),
   * `anterior` (clona la boca de `previousExamId`) y `blanco` (boca vacía).
   */
  create: (
    patientId: string,
    input: CreatePeriodontalExamInput,
  ): Promise<PeriodontalExamMutationResult> =>
    api.post<PeriodontalExamMutationResult>(base(patientId), input),

  /** Guarda el borrador completo con la revisión vigente (edición optimista). */
  save: (
    patientId: string,
    examId: string,
    input: SavePeriodontalExamInput,
  ): Promise<PeriodontalExamMutationResult> =>
    api.put<PeriodontalExamMutationResult>(`${base(patientId)}/${examId}`, input),

  /** Cierra el examen: a partir de aquí es inmutable. */
  finalize: (
    patientId: string,
    examId: string,
    input: FinalizePeriodontalExamInput,
  ): Promise<FinalizePeriodontalExamResult> =>
    api.post<FinalizePeriodontalExamResult>(`${base(patientId)}/${examId}/finalize`, input),

  /** Descarta un borrador (solo el borrador; el finalizado no se borra). */
  discard: (patientId: string, examId: string): Promise<void> =>
    api.delete<void>(`${base(patientId)}/${examId}`),

  /** Comparación longitudinal sitio a sitio contra `withExamId`. */
  compare: (
    patientId: string,
    examId: string,
    withExamId: string,
    signal?: AbortSignal,
  ): Promise<PeriodontalComparisonResult> =>
    api.get<PeriodontalComparisonResult>(`${base(patientId)}/${examId}/compare`, {
      query: { with: withExamId },
      signal,
    }),

  /** Deja constancia de la impresión (imprimir es leer, pero se audita). */
  registerPrint: (patientId: string, examId: string): Promise<PrintPeriodontalExamResult> =>
    api.post<PrintPeriodontalExamResult>(`${base(patientId)}/${examId}/printed`, {}),
};
