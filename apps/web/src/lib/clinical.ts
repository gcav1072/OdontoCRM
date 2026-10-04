import {
  ANAMNESIS_CATALOGS,
  CLINICAL_SECTION_KEYS,
  CLINICAL_SIGNATURE_SECTIONS,
  DENTAL_HISTORY_ITEMS,
  DENTAL_VISIT_FREQUENCIES,
  OCCLUSION_STATES,
  ORAL_HEALTH_STATES,
  ORAL_HYGIENE_LEVELS,
  REGION_EVALUATIONS,
  STUDY_ITEMS,
  TREATMENT_PRIORITIES,
  type ClinicalAlert,
  type ClinicalSectionKey,
} from '@odontocrm/contracts';

import { t, type TranslationKey } from './i18n';

/**
 * Metadatos del formulario de historia clínica. El formulario es **dirigido por
 * datos**: cada sección declara sus campos una vez y el mismo componente los
 * pinta, guarda y valida. Así una sección nueva (o un catálogo nuevo) no
 * requiere escribir una pantalla.
 */

export type ClinicalFieldSpec =
  | { kind: 'text'; name: string; labelKey: string; maxLength: number; required?: boolean }
  | { kind: 'textarea'; name: string; labelKey: string; rows?: number; required?: boolean }
  | { kind: 'date'; name: string; labelKey: string }
  | { kind: 'checkbox'; name: string; labelKey: string }
  | { kind: 'select'; name: string; labelKey: string; group: string; options: readonly string[] }
  | { kind: 'catalog'; name: string; labelKey: string; group: string; codes: readonly string[] }
  | { kind: 'procedures'; name: string; labelKey: string };

export const CLINICAL_SECTION_ORDER: readonly ClinicalSectionKey[] = CLINICAL_SECTION_KEYS;

/** Secciones que bloquean la firma mientras no estén completas. */
export const CLINICAL_REQUIRED_SECTIONS: readonly ClinicalSectionKey[] =
  CLINICAL_SIGNATURE_SECTIONS;

const REQUIRED_SECTION_SET = new Set<ClinicalSectionKey>(CLINICAL_REQUIRED_SECTIONS);

export const clinicalSectionIsRequired = (key: ClinicalSectionKey): boolean =>
  REQUIRED_SECTION_SET.has(key);

export const CLINICAL_SECTION_FIELDS: Readonly<
  Record<ClinicalSectionKey, readonly ClinicalFieldSpec[]>
> = {
  identificacion: [
    { kind: 'text', name: 'ocupacion', labelKey: 'clinica.campo.ocupacion', maxLength: 80 },
    {
      kind: 'text',
      name: 'responsableNombre',
      labelKey: 'clinica.campo.responsableNombre',
      maxLength: 120,
    },
    {
      kind: 'text',
      name: 'responsableParentesco',
      labelKey: 'clinica.campo.responsableParentesco',
      maxLength: 60,
    },
    {
      kind: 'text',
      name: 'responsableTelefono',
      labelKey: 'clinica.campo.responsableTelefono',
      maxLength: 30,
    },
    { kind: 'textarea', name: 'observaciones', labelKey: 'clinica.campo.observaciones', rows: 2 },
  ],
  motivo_consulta: [
    {
      kind: 'textarea',
      name: 'relato',
      labelKey: 'clinica.campo.relato',
      rows: 4,
      required: true,
    },
    {
      kind: 'text',
      name: 'tiempoEvolucion',
      labelKey: 'clinica.campo.tiempoEvolucion',
      maxLength: 80,
    },
    { kind: 'date', name: 'inicioSintomas', labelKey: 'clinica.campo.inicioSintomas' },
  ],
  anamnesis: [
    { kind: 'checkbox', name: 'sinAntecedentes', labelKey: 'clinica.campo.sinAntecedentes' },
    ...ANAMNESIS_CATALOGS.map((group) => ({
      kind: 'catalog' as const,
      name: group.key,
      labelKey: `clinica.catalogo.${group.key}.titulo`,
      group: group.key,
      codes: group.codes,
    })),
    { kind: 'textarea', name: 'observaciones', labelKey: 'clinica.campo.observaciones', rows: 3 },
  ],
  antecedentes_odontologicos: [
    {
      kind: 'catalog',
      name: 'tratamientos',
      labelKey: 'clinica.catalogo.odontologicos.titulo',
      group: 'odontologicos',
      codes: DENTAL_HISTORY_ITEMS,
    },
    {
      kind: 'catalog',
      name: 'reaccionesAdversas',
      labelKey: 'clinica.catalogo.reacciones.titulo',
      group: 'reacciones',
      codes: ['anestesia_local', 'materiales', 'ninguna', 'otros'],
    },
    {
      kind: 'catalog',
      name: 'experiencias',
      labelKey: 'clinica.catalogo.experiencias.titulo',
      group: 'experiencias',
      codes: ['traumatica', 'ansiedad', 'ninguna', 'otros'],
    },
    {
      kind: 'select',
      name: 'frecuenciaVisitas',
      labelKey: 'clinica.campo.frecuenciaVisitas',
      group: 'frecuencia',
      options: DENTAL_VISIT_FREQUENCIES,
    },
    { kind: 'date', name: 'ultimaConsulta', labelKey: 'clinica.campo.ultimaConsulta' },
    {
      kind: 'select',
      name: 'higieneCepillado',
      labelKey: 'clinica.campo.higieneCepillado',
      group: 'cepillado',
      options: ['una_vez', 'dos_veces', 'tres_o_mas', 'esporadico'],
    },
    { kind: 'checkbox', name: 'usaHiloDental', labelKey: 'clinica.campo.usaHiloDental' },
    {
      kind: 'text',
      name: 'tratamientoEnCurso',
      labelKey: 'clinica.campo.tratamientoEnCurso',
      maxLength: 300,
    },
    { kind: 'textarea', name: 'observaciones', labelKey: 'clinica.campo.observaciones', rows: 3 },
  ],
  examen_extraoral: [
    {
      kind: 'select',
      name: 'tejidosBlandos',
      labelKey: 'clinica.campo.tejidosBlandos',
      group: 'evaluacion',
      options: REGION_EVALUATIONS,
    },
    {
      kind: 'select',
      name: 'ganglios',
      labelKey: 'clinica.campo.ganglios',
      group: 'evaluacion',
      options: REGION_EVALUATIONS,
    },
    {
      kind: 'select',
      name: 'atm',
      labelKey: 'clinica.campo.atm',
      group: 'evaluacion',
      options: REGION_EVALUATIONS,
    },
    {
      kind: 'select',
      name: 'musculatura',
      labelKey: 'clinica.campo.musculatura',
      group: 'evaluacion',
      options: REGION_EVALUATIONS,
    },
    { kind: 'textarea', name: 'hallazgos', labelKey: 'clinica.campo.hallazgos', rows: 3 },
    { kind: 'textarea', name: 'observaciones', labelKey: 'clinica.campo.observaciones', rows: 2 },
  ],
  examen_intraoral: [
    {
      kind: 'select',
      name: 'tejidosBlandos',
      labelKey: 'clinica.campo.tejidosBlandos',
      group: 'evaluacion',
      options: REGION_EVALUATIONS,
    },
    {
      kind: 'select',
      name: 'encias',
      labelKey: 'clinica.campo.encias',
      group: 'evaluacion',
      options: REGION_EVALUATIONS,
    },
    { kind: 'text', name: 'sondaje', labelKey: 'clinica.campo.sondaje', maxLength: 200 },
    {
      kind: 'select',
      name: 'oclusion',
      labelKey: 'clinica.campo.oclusion',
      group: 'oclusion',
      options: OCCLUSION_STATES,
    },
    {
      kind: 'select',
      name: 'higiene',
      labelKey: 'clinica.campo.higiene',
      group: 'higiene',
      options: ORAL_HYGIENE_LEVELS,
    },
    { kind: 'textarea', name: 'hallazgos', labelKey: 'clinica.campo.hallazgos', rows: 3 },
    { kind: 'textarea', name: 'observaciones', labelKey: 'clinica.campo.observaciones', rows: 2 },
  ],
  examenes_complementarios: [
    {
      kind: 'catalog',
      name: 'estudios',
      labelKey: 'clinica.catalogo.estudios.titulo',
      group: 'estudios',
      codes: STUDY_ITEMS,
    },
    { kind: 'textarea', name: 'observaciones', labelKey: 'clinica.campo.observaciones', rows: 3 },
  ],
  diagnostico: [
    {
      kind: 'text',
      name: 'principal',
      labelKey: 'clinica.campo.diagnosticoPrincipal',
      maxLength: 500,
      required: true,
    },
    {
      kind: 'textarea',
      name: 'secundarios',
      labelKey: 'clinica.campo.diagnosticosSecundarios',
      rows: 3,
    },
    { kind: 'textarea', name: 'porPieza', labelKey: 'clinica.campo.diagnosticoPorPieza', rows: 2 },
    {
      kind: 'select',
      name: 'saludBucalGeneral',
      labelKey: 'clinica.campo.saludBucalGeneral',
      group: 'salud',
      options: ORAL_HEALTH_STATES,
    },
    { kind: 'textarea', name: 'observaciones', labelKey: 'clinica.campo.observaciones', rows: 2 },
  ],
  plan_tratamiento: [
    { kind: 'procedures', name: 'procedimientos', labelKey: 'clinica.campo.procedimientos' },
    { kind: 'textarea', name: 'alternativas', labelKey: 'clinica.campo.alternativas', rows: 3 },
    { kind: 'checkbox', name: 'aceptacionPaciente', labelKey: 'clinica.campo.aceptacionPaciente' },
    { kind: 'textarea', name: 'observaciones', labelKey: 'clinica.campo.observaciones', rows: 2 },
  ],
  consentimiento: [
    {
      kind: 'textarea',
      name: 'riesgosInformados',
      labelKey: 'clinica.campo.riesgosInformados',
      rows: 4,
    },
    {
      kind: 'textarea',
      name: 'alternativasInformadas',
      labelKey: 'clinica.campo.alternativasInformadas',
      rows: 3,
    },
    { kind: 'textarea', name: 'observaciones', labelKey: 'clinica.campo.observaciones', rows: 2 },
  ],
  evolucion: [
    { kind: 'textarea', name: 'resumen', labelKey: 'clinica.campo.resumen', rows: 5 },
    { kind: 'textarea', name: 'observaciones', labelKey: 'clinica.campo.observaciones', rows: 2 },
  ],
};

/** Contenido inicial de una sección, con la forma que espera el contrato. */
export const emptyClinicalSection = (key: ClinicalSectionKey): Record<string, unknown> => {
  const content: Record<string, unknown> = {};
  for (const field of CLINICAL_SECTION_FIELDS[key]) {
    switch (field.kind) {
      case 'checkbox':
        content[field.name] = false;
        break;
      case 'catalog':
        content[field.name] = { items: [], otros: null };
        break;
      case 'procedures':
        content[field.name] = [];
        break;
      default:
        content[field.name] = null;
    }
  }
  return content;
};

/** Contenido de la historia combinando lo guardado con los valores por defecto. */
export const sectionContentFor = (
  key: ClinicalSectionKey,
  saved: Record<string, unknown> | undefined,
): Record<string, unknown> => ({
  ...emptyClinicalSection(key),
  ...(saved ?? {}),
});

/* ── Etiquetas (todas salen de `i18n`) ─────────────────────────────────────── */

export const clinicalSectionLabel = (key: ClinicalSectionKey): string =>
  t(`clinica.seccion.${key}` as TranslationKey);

export const clinicalSectionHint = (key: ClinicalSectionKey): string =>
  t(`clinica.seccion.${key}.ayuda` as TranslationKey);

export const clinicalFieldLabel = (labelKey: string): string => t(labelKey as TranslationKey);

export const clinicalCatalogTitle = (group: string): string =>
  t(`clinica.catalogo.${group}.titulo` as TranslationKey);

export const clinicalCatalogItemLabel = (group: string, code: string): string =>
  t(`clinica.catalogo.${group}.${code}` as TranslationKey);

export const clinicalOptionLabel = (group: string, code: string): string =>
  t(`clinica.opcion.${group}.${code}` as TranslationKey);

export const clinicalStatusLabel = (status: string): string =>
  t(`clinica.estado.${status}` as TranslationKey);

export const clinicalAlertLabel = (alert: ClinicalAlert): string =>
  alert.detail === null ? t(`clinica.alerta.${alert.code}` as TranslationKey) : alert.detail;

/** Severidad de una alerta clínica: las alergias y la anticoagulación en rojo. */
export const clinicalAlertVariant = (code: string): 'danger' | 'warning' | 'info' => {
  if (code.startsWith('alergia') || code === 'anticoagulante' || code === 'bifosfonato') {
    return 'danger';
  }
  if (code === 'diabetes' || code === 'hipertension' || code === 'cardiopatia') return 'warning';
  return 'info';
};

export const clinicalPriorityLabel = (priority: string): string =>
  t(`clinica.opcion.prioridad.${priority}` as TranslationKey);

export const CLINICAL_PRIORITIES = TREATMENT_PRIORITIES;
