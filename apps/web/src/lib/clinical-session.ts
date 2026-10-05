import {
  CLINICAL_STATES,
  OCCLUSION_STATES,
  ORAL_HYGIENE_LEVELS,
  REGION_EVALUATIONS,
  SESSION_MATERIALS,
  SESSION_PROCEDURES,
  clinicalSessionCanClose,
  clinicalSessionHasContent,
  emptyClinicalSessionContent,
  formatSessionNumber,
  isToothNumber,
  materialLabel,
  procedureLabel,
  sessionMaterialText,
  sessionProcedureText,
  toothKind,
  TOOTH_SURFACES_BY_KIND,
  type ClinicalSessionContent,
  type ClinicalSessionVitals,
  type SessionMaterial,
  type SessionProcedure,
  type ToothSurface,
} from '@odontocrm/contracts';

import { t, type TranslationKey } from './i18n';

/**
 * Metadatos del formulario de sesión clínica (Fase 7, sesión A).
 *
 * Igual que la historia clínica, el formulario es **dirigido por datos**: los
 * signos vitales y el examen declaran sus campos una vez y el mismo componente
 * los pinta y los valida con los mismos rangos que aplica el servidor.
 */

export interface SessionFieldSpec {
  /** Nombre del campo en el contrato de la sesión (se usa para indexar). */
  name: keyof ClinicalSessionVitals;
  /** Clave de traducción: el compilador comprueba que existe. */
  labelKey: TranslationKey;
  /** Unidad visible («mmHg», «°C»…), si la tiene. */
  unit?: string;
  decimals?: number;
  placeholder?: string;
}

/** Signos vitales: tensión (dos números), pulso, temperatura, SpO₂ y peso. */
export const SESSION_VITAL_FIELDS: readonly SessionFieldSpec[] = [
  {
    name: 'taSistolica',
    labelKey: 'clinica.sesion.vital.taSistolica',
    unit: 'mmHg',
    placeholder: '120',
  },
  {
    name: 'taDiastolica',
    labelKey: 'clinica.sesion.vital.taDiastolica',
    unit: 'mmHg',
    placeholder: '80',
  },
  { name: 'fc', labelKey: 'clinica.sesion.vital.fc', unit: 'lpm', placeholder: '72' },
  {
    name: 'temperatura',
    labelKey: 'clinica.sesion.vital.temperatura',
    unit: '°C',
    decimals: 1,
    placeholder: '36.5',
  },
  { name: 'spo2', labelKey: 'clinica.sesion.vital.spo2', unit: '%', placeholder: '98' },
  {
    name: 'peso',
    labelKey: 'clinica.sesion.vital.peso',
    unit: 'kg',
    decimals: 1,
    placeholder: '68',
  },
];

/** Examen de la sesión: intraoral y periodontal. */
export const SESSION_EXAM_FIELDS = {
  selects: [
    { name: 'tejidosBlandos', group: 'evaluacion', options: REGION_EVALUATIONS },
    { name: 'encias', group: 'evaluacion', options: REGION_EVALUATIONS },
    { name: 'oclusion', group: 'oclusion', options: OCCLUSION_STATES },
    { name: 'higiene', group: 'higiene', options: ORAL_HYGIENE_LEVELS },
  ],
} as const;

export const SESSION_PROCEDURE_OPTIONS = SESSION_PROCEDURES;
export const SESSION_MATERIAL_OPTIONS = SESSION_MATERIALS;
export const SESSION_STATES = CLINICAL_STATES;

/** Sesión recién abierta: el estado inicial del formulario. */
export const emptySessionDraft = (): ClinicalSessionContent => emptyClinicalSessionContent();

export const sessionStatusLabel = (status: string): string =>
  t(`clinica.sesion.estado.${status}` as TranslationKey);

export const sessionHasContent = clinicalSessionHasContent;
export const sessionCanClose = clinicalSessionCanClose;

export const sessionNumberLabel = (sessionNumber: number): string =>
  formatSessionNumber(sessionNumber);

export const sessionProcedureLabel = procedureLabel;
export const sessionMaterialLabel = materialLabel;
export const sessionProcedureLine = sessionProcedureText;
export const sessionMaterialLine = sessionMaterialText;

/** Un procedimiento vacío: catálogo, sin pieza y sin caras. */
export const emptyProcedure = (): SessionProcedure => ({
  code: 'consulta_evaluacion',
  detalle: null,
  toothNumber: null,
  surfaces: [],
  notas: null,
});

/** Un material vacío, listo para elegir del catálogo. */
export const emptyMaterial = (): SessionMaterial => ({
  code: 'anestesia_lidocaina',
  detalle: null,
  cantidad: null,
});

/** Caras que admite una pieza en FDI (una temporal no tiene los mismos molares). */
export const surfacesForTooth = (toothNumber: number | null): readonly ToothSurface[] => {
  if (toothNumber === null || !isToothNumber(toothNumber)) return [];
  return TOOTH_SURFACES_BY_KIND[toothKind(toothNumber)];
};

/** Cómo va el guardado: es lo que mira el doctor mientras escribe. */
export type SessionSaveState = 'limpio' | 'pendiente' | 'guardando' | 'guardado' | 'error';

export const sessionSaveLabel = (state: SessionSaveState, hora: string | null): string => {
  if (state === 'guardando') return t('clinica.sesion.guardado.guardando');
  if (state === 'pendiente') return t('clinica.sesion.guardado.pendiente');
  if (state === 'error') return t('clinica.sesion.guardado.error');
  if (hora === null) return t('clinica.sesion.guardado.limpio');
  return t('clinica.sesion.guardado.hecho', { hora });
};
