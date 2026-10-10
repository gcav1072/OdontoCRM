import type {
  ClearSurfaceInput,
  CompleteProcedureInput,
  DeleteFindingInput,
  Dentition,
  OdontogramDetail,
  OdontogramHistoryResult,
  OdontogramLookup,
  OdontogramMutationResult,
  PrintOdontogramResult,
  ProsthesisArch,
  ProsthesisRecord,
  RecordFindingInput,
  RecordFindingsBatchInput,
  RecordProsthesisInput,
  ToothFindingRecord,
  ToothSurface,
} from '@odontocrm/contracts';
import { CLINICAL_STATE_COLORS } from '@odontocrm/contracts';

import { api } from './api';
import { t } from './i18n';

/**
 * Odontograma (Fase 6, sesión B). Leer e imprimir exigen `odontogram:read` —la
 * secretaría imprime el odontograma— y escribir exige `odontogram:write`
 * (odontólogo y admin). La comprobación la hace el servidor en cada ruta.
 *
 * El contrato vive en `@odontocrm/contracts`; aquí solo están las llamadas.
 */

/**
 * Nombre de la dentición en la interfaz: permanente, temporal o **mixta** (el paciente
 * que está mudando; ver [ADR 0051](../../../../docs/adr/0051-denticion-mixta-en-el-odontograma.md)).
 */
export const dentitionLabel = (dentition: Dentition): string => {
  if (dentition === 'temporal') return t('odonto.denticion.temporal');
  if (dentition === 'mixta') return t('odonto.denticion.mixta');
  return t('odonto.denticion.permanente');
};

/* ── Ayudas puras sobre el detalle (las usan el gráfico y las páginas) ──────── */

/** Hallazgos vigentes de una pieza; `[]` si está sana (patrón por excepción). */
export const findingsForTooth = (
  detail: Pick<OdontogramDetail, 'findings'> | null | undefined,
  toothNumber: number,
): ToothFindingRecord[] => detail?.findings[String(toothNumber)] ?? [];

/** Prótesis removibles vigentes del odontograma; `[]` si no hay ninguna. */
export const prosthesesOf = (
  detail: Pick<OdontogramDetail, 'prostheses'> | null | undefined,
): ProsthesisRecord[] => detail?.prostheses ?? [];

/** Prótesis removibles de una arcada concreta. */
export const prosthesesForArch = (
  detail: Pick<OdontogramDetail, 'prostheses'> | null | undefined,
  arch: ProsthesisArch,
): ProsthesisRecord[] => prosthesesOf(detail).filter((prosthesis) => prosthesis.arch === arch);

/** `true` si la pieza tiene algún hallazgo registrado (y por tanto no está sana). */
export const toothIsAffected = (
  detail: Pick<OdontogramDetail, 'findings'> | null | undefined,
  toothNumber: number,
): boolean => findingsForTooth(detail, toothNumber).length > 0;

/** Condición de pieza completa vigente de una pieza, si la tiene. */
export const wholeToothFinding = (
  detail: Pick<OdontogramDetail, 'findings'> | null | undefined,
  toothNumber: number,
): ToothFindingRecord | null =>
  findingsForTooth(detail, toothNumber).find((finding) => finding.surface === null) ?? null;

/**
 * Estado clínico dominante de la pieza: `pendiente` manda sobre `completado` —una
 * boca con trabajo por hacer se pinta en rojo— y `null` significa **sana**.
 */
export const toothState = (
  detail: Pick<OdontogramDetail, 'findings'> | null | undefined,
  toothNumber: number,
): ToothFindingRecord['state'] | null => {
  const hallazgos = findingsForTooth(detail, toothNumber);
  if (hallazgos.length === 0) return null;
  return hallazgos.some((finding) => finding.state === 'pendiente') ? 'pendiente' : 'completado';
};

/** Hallazgo de una cara concreta, o `null` si esa cara está sana. */
export const surfaceFinding = (
  detail: Pick<OdontogramDetail, 'findings'> | null | undefined,
  toothNumber: number,
  surface: ToothSurface,
): ToothFindingRecord | null =>
  findingsForTooth(detail, toothNumber).find((finding) => finding.surface === surface) ?? null;

/**
 * Color de una cara siguiendo el doc §7.2: rojo si está pendiente, azul si está
 * completada y **sin relleno si está sana** (la ausencia de hallazgo es el estado
 * sano). Devuelve `undefined` para que el componente aplique su relleno base.
 */
export const surfaceFill = (
  detail: Pick<OdontogramDetail, 'findings'> | null | undefined,
  toothNumber: number,
  surface: ToothSurface,
): string | undefined => findingFill(findingsForTooth(detail, toothNumber), surface);

/**
 * Igual que `surfaceFill`, pero a partir de los hallazgos **ya filtrados** de una
 * pieza: el gráfico pinta cada pieza con su lista y no necesita volver a buscar
 * en el odontograma entero.
 */
export const findingFill = (
  findings: readonly ToothFindingRecord[],
  surface: ToothSurface,
): string | undefined => {
  const finding = findings.find((item) => item.surface === surface);
  if (finding === undefined) return undefined;
  return CLINICAL_STATE_COLORS[finding.state];
};

/* ── Cliente ───────────────────────────────────────────────────────────────── */

export const odontogramApi = {
  /** Odontograma del paciente, o `exists: false` si todavía no tiene ninguno. */
  byPatient: (patientId: string, signal?: AbortSignal): Promise<OdontogramLookup> =>
    api.get<OdontogramLookup>(`/odontogram/patients/${patientId}`, { signal }),

  /** Registra o actualiza un hallazgo (crea el odontograma si es el primero). */
  recordFinding: (
    patientId: string,
    input: RecordFindingInput,
  ): Promise<OdontogramMutationResult> =>
    api.request<OdontogramMutationResult>('PUT', `/odontogram/patients/${patientId}/findings`, {
      body: input,
    }),

  /** Varios hallazgos en una sola transacción (carga rápida y pegados). */
  recordFindings: (
    patientId: string,
    input: RecordFindingsBatchInput,
  ): Promise<OdontogramMutationResult> =>
    api.post<OdontogramMutationResult>(`/odontogram/patients/${patientId}/findings/batch`, input),

  /**
   * Cumple un **procedimiento** del plan (spec anexo ADR 0032 §5): extracción
   * realizada, caries obturada o corona sobre implante. El servidor resuelve el origen
   * e inserta el destino en una sola transacción, así que la pieza no queda a medias.
   */
  completeProcedure: (
    patientId: string,
    input: CompleteProcedureInput,
  ): Promise<OdontogramMutationResult> =>
    api.post<OdontogramMutationResult>(`/odontogram/patients/${patientId}/procedures`, input),

  /** Borra esa clave natural: la pieza vuelve a estar sana. */
  removeFinding: (
    patientId: string,
    input: DeleteFindingInput,
  ): Promise<OdontogramMutationResult> =>
    api.delete<OdontogramMutationResult>(`/odontogram/patients/${patientId}/findings`, {
      query: {
        toothNumber: input.toothNumber,
        surface: input.surface ?? undefined,
        condition: input.condition,
      },
    }),

  /** Deja la cara sana limpiando todas sus condiciones. */
  clearSurface: (patientId: string, input: ClearSurfaceInput): Promise<OdontogramMutationResult> =>
    api.delete<OdontogramMutationResult>(
      `/odontogram/patients/${patientId}/surfaces/${String(input.toothNumber)}/${input.surface}`,
    ),

  /**
   * Registra o corrige una **prótesis removible** (PPR/PRT). La clave natural es
   * tipo + arcada: volver a registrar la de una arcada la actualiza (la PRT se
   * normaliza a la arcada completa en el servicio).
   */
  recordProsthesis: (
    patientId: string,
    input: RecordProsthesisInput,
  ): Promise<OdontogramMutationResult> =>
    api.request<OdontogramMutationResult>('PUT', `/odontogram/patients/${patientId}/prostheses`, {
      body: input,
    }),

  /** Retira una prótesis removible por su identificador. */
  removeProsthesis: (patientId: string, id: string): Promise<OdontogramMutationResult> =>
    api.delete<OdontogramMutationResult>(`/odontogram/patients/${patientId}/prostheses/${id}`),

  /** Histórico append-only de cambios, para la vista de evolución y el informe. */
  history: (
    patientId: string,
    signal?: AbortSignal,
    limit?: number,
  ): Promise<OdontogramHistoryResult> =>
    api.get<OdontogramHistoryResult>(
      `/odontogram/patients/${patientId}/history${limit === undefined ? '' : `?limit=${String(limit)}`}`,
      { signal },
    ),

  /** Deja constancia de la impresión (también la secretaría, que solo lee). */
  registerPrint: (patientId: string): Promise<PrintOdontogramResult> =>
    api.post<PrintOdontogramResult>(`/odontogram/patients/${patientId}/printed`, {}),
};
