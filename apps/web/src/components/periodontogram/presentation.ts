import {
  PERIODONTAL_BOP_TARGET_MAX,
  PERIODONTAL_PLAQUE_TARGET_MAX,
  SITE_ANATOMY_SHORT_LABELS,
  archOfTooth,
  attachmentLevel,
  siteAnatomy,
  type DiabetesLevel,
  type FurcationEntrance,
  type FurcationGrade,
  type MobilityGrade,
  type PeriodontalArch,
  type PeriodontalComparisonSummary,
  type PeriodontalDiagnosisSuggestion,
  type PeriodontalEvidence,
  type PeriodontalExamStatus,
  type PeriodontalGrade,
  type PeriodontalMetrics,
  type PeriodontalRiskFactors,
  type PeriodontalSide,
  type PeriodontalSite,
  type PeriodontalSiteChange,
  type PeriodontalSiteIndex,
  type PeriodontalStage,
  type PeriodontalTooth,
  type SmokingLevel,
  type PeriodontalSiteAnatomy,
} from '@odontocrm/contracts';

import { formatDate, formatDecimal } from '../../lib/format';
import { t, type TranslationKey } from '../../lib/i18n';

/**
 * Textos y cifras del periodontograma: **una sola capa de presentación** para el
 * panel, el gráfico, la tabla y el documento impreso.
 *
 * Todo lo que se lee sale de aquí, y todo lo que se lee se traduce con `t(...)`. Las
 * cifras clínicas (milímetros, porcentajes, grados romanos) se formatean una vez para
 * que la pantalla y el papel no puedan discrepar. Los catálogos del contrato se
 * traducen con mapas tipados a `TranslationKey`: si se añade un estadio, un grado o
 * una evidencia nueva, el `typecheck` obliga a traducirla.
 */

/* ── Catálogos traducidos (tipados: una clave nueva rompe la compilación) ──── */

const SITE_ANATOMY_KEYS: Readonly<Record<PeriodontalSiteAnatomy, TranslationKey>> = {
  mesiovestibular: 'periodonto.sitio.mesiovestibular',
  vestibular: 'periodonto.sitio.vestibular',
  distovestibular: 'periodonto.sitio.distovestibular',
  mesiopalatino: 'periodonto.sitio.mesiopalatino',
  palatino: 'periodonto.sitio.palatino',
  distopalatino: 'periodonto.sitio.distopalatino',
  mesiolingual: 'periodonto.sitio.mesiolingual',
  lingual: 'periodonto.sitio.lingual',
  distolingual: 'periodonto.sitio.distolingual',
};

const STAGE_KEYS: Readonly<Record<PeriodontalStage, TranslationKey>> = {
  1: 'periodonto.estadio.1',
  2: 'periodonto.estadio.2',
  3: 'periodonto.estadio.3',
  4: 'periodonto.estadio.4',
};

const GRADE_KEYS: Readonly<Record<PeriodontalGrade, TranslationKey>> = {
  A: 'periodonto.grado.A',
  B: 'periodonto.grado.B',
  C: 'periodonto.grado.C',
};

const SMOKING_KEYS: Readonly<Record<SmokingLevel, TranslationKey>> = {
  no: 'periodonto.tabaco.no',
  menos10: 'periodonto.tabaco.menos10',
  mas10: 'periodonto.tabaco.mas10',
};

const DIABETES_KEYS: Readonly<Record<DiabetesLevel, TranslationKey>> = {
  no: 'periodonto.diabetes.no',
  controlada: 'periodonto.diabetes.controlada',
  descontrolada: 'periodonto.diabetes.descontrolada',
};

const CHANGE_KEYS: Readonly<Record<PeriodontalSiteChange, TranslationKey>> = {
  mejoro: 'periodonto.cambio.mejoro',
  empeoro: 'periodonto.cambio.empeoro',
  estable: 'periodonto.cambio.estable',
  sin_anterior: 'periodonto.cambio.sinAnterior',
  sin_actual: 'periodonto.cambio.sinActual',
  sin_dato: 'periodonto.cambio.sinDato',
};

const EVIDENCE_KEYS: Readonly<Record<PeriodontalEvidence['code'], TranslationKey>> = {
  nic_interproximal: 'periodonto.sugerencia.evidencia.nicInterproximal',
  bolsa_profunda: 'periodonto.sugerencia.evidencia.bolsaProfunda',
  furca_avanzada: 'periodonto.sugerencia.evidencia.furcaAvanzada',
  movilidad_avanzada: 'periodonto.sugerencia.evidencia.movilidadAvanzada',
  dientes_perdidos: 'periodonto.sugerencia.evidencia.dientesPerdidos',
  bolsas_5mm: 'periodonto.sugerencia.evidencia.bolsas5mm',
  tabaquismo: 'periodonto.sugerencia.evidencia.tabaquismo',
  diabetes: 'periodonto.sugerencia.evidencia.diabetes',
  hba1c: 'periodonto.sugerencia.evidencia.hba1c',
};

const STATUS_KEYS: Readonly<Record<PeriodontalExamStatus, TranslationKey>> = {
  borrador: 'periodonto.estado.borrador',
  finalizado: 'periodonto.estado.finalizado',
};

const FURCATION_ENTRANCE_KEYS: Readonly<Record<FurcationEntrance, TranslationKey>> = {
  vestibular: 'periodonto.furca.entrada.vestibular',
  lingual: 'periodonto.furca.entrada.lingual',
  mesiopalatina: 'periodonto.furca.entrada.mesiopalatina',
  distopalatina: 'periodonto.furca.entrada.distopalatina',
  mesial: 'periodonto.furca.entrada.mesial',
  distal: 'periodonto.furca.entrada.distal',
};

const FURCATION_GRADE_KEYS: Readonly<Record<FurcationGrade, TranslationKey>> = {
  1: 'periodonto.furca.grado1',
  2: 'periodonto.furca.grado2',
  3: 'periodonto.furca.grado3',
};

/** Grado romano de la furca (I, II, III) en la notación clínica de Hamp. */
const furcationRoman = (grade: FurcationGrade): string => t(FURCATION_GRADE_KEYS[grade]);

/* ── Nombres anatómicos y etiquetas accesibles ─────────────────────────────── */

/** Nombre completo del sitio (`Mesiovestibular`, `Palatino medio`…). */
export const siteAnatomyName = (
  toothNumber: number,
  side: PeriodontalSide,
  index: PeriodontalSiteIndex,
): string => t(SITE_ANATOMY_KEYS[siteAnatomy(toothNumber, side, index)]);

/** Sigla del sitio en la anatomía del paciente (`MV`, `P`, `DL`…). */
export const siteShortName = (
  toothNumber: number,
  side: PeriodontalSide,
  index: PeriodontalSiteIndex,
): string => SITE_ANATOMY_SHORT_LABELS[siteAnatomy(toothNumber, side, index)];

/** Nombre de la cara según la arcada: palatina arriba, lingual abajo. */
export const sideName = (toothNumber: number, side: PeriodontalSide): string => {
  if (side === 'vestibular') return t('periodonto.cara.vestibular');
  return archOfTooth(toothNumber) === 'maxilar'
    ? t('periodonto.cara.palatina')
    : t('periodonto.cara.lingual');
};

/**
 * Etiqueta lateral de una banda del gráfico (`VESTIBULAR`, `PALATINO`, `LINGUAL`).
 * Se escribe en mayúsculas porque va girada, junto a la rejilla, y tiene que leerse
 * de un vistazo sin confundirse con las cotas en milímetros.
 */
export const bandFaceLabel = (arch: PeriodontalArch, side: PeriodontalSide): string => {
  const cara =
    side === 'vestibular'
      ? t('periodonto.cara.vestibular')
      : arch === 'maxilar'
        ? t('periodonto.cara.palatina')
        : t('periodonto.cara.lingual');
  return cara.toUpperCase();
};

/** Etiqueta accesible de un sitio: «Diente 16, vestibular, mesiovestibular». */
export const siteAriaLabel = (
  toothNumber: number,
  side: PeriodontalSide,
  index: PeriodontalSiteIndex,
): string =>
  t('periodonto.sitio.aria', {
    pieza: toothNumber,
    cara: sideName(toothNumber, side).toLowerCase(),
    sitio: siteAnatomyName(toothNumber, side, index).toLowerCase(),
  });

/** Etiqueta accesible de una pieza del gráfico (número FDI + estado). */
export const toothAriaLabel = (tooth: PeriodontalTooth): string => {
  const estado = tooth.missing
    ? t('periodonto.pieza.ausente')
    : tooth.implant
      ? t('periodonto.pieza.implante')
      : t('periodonto.pieza.presente');
  return t('periodonto.pieza.aria', { pieza: tooth.fdi, estado: estado.toLowerCase() });
};

/* ── Cifras clínicas ───────────────────────────────────────────────────────── */

/** Número sin más; `null` = sin dato (nunca se pinta un 0 inventado). */
export const numberText = (value: number | null): string =>
  value === null ? t('comun.sinDato') : String(value);

/** Milímetros con su unidad; `null` = sin dato. */
export const millimetersText = (value: number | null): string =>
  value === null ? t('comun.sinDato') : `${formatDecimal(value)} mm`;

/** Margen gingival con signo: `+2` es hiperplasia y `−2`, recesión. */
export const gmText = (value: number | null): string => {
  if (value === null) return t('comun.sinDato');
  return value > 0 ? `+${String(value)}` : String(value);
};

/** Valor de un sitio en el canal pedido (`pd` o `gm`), listo para pintar. */
export const siteFieldText = (
  site: Pick<PeriodontalSite, 'pd' | 'gm'>,
  field: 'pd' | 'gm',
): string => (field === 'pd' ? numberText(site.pd) : gmText(site.gm));

/**
 * Texto de los tres sitios de una cara, en orden visual. Existe para que el pad
 * pinte **cada tarjeta con su propio valor**: leer el sitio activo en las tres hacía
 * que un 6 en DV se viera también en V y en MV.
 */
export const faceSiteTexts = (
  sites: readonly [
    Pick<PeriodontalSite, 'pd' | 'gm'>,
    Pick<PeriodontalSite, 'pd' | 'gm'>,
    Pick<PeriodontalSite, 'pd' | 'gm'>,
  ],
  field: 'pd' | 'gm',
): readonly [string, string, string] => [
  siteFieldText(sites[0], field),
  siteFieldText(sites[1], field),
  siteFieldText(sites[2], field),
];

/** NIC del sitio con la convención del contrato (`null` si no se sondó). */
export const calText = (site: Pick<PeriodontalSite, 'pd' | 'gm'>): string =>
  numberText(attachmentLevel(site));

/**
 * Porcentaje ya redondeado por el contrato (una décima), con el signo cuando es una
 * diferencia. El guion es «sin sitios medidos»: un 0 % sin sondear sería mentira.
 */
export const percentText = (value: number | null, signed = false): string => {
  if (value === null) return t('comun.sinDato');
  const texto = `${formatDecimal(value)} %`;
  return signed && value > 0 ? `+${texto}` : texto;
};

/** Diferencia en milímetros con signo explícito (`+2 mm`, `-1 mm`, `0 mm`). */
export const deltaText = (value: number | null): string => {
  if (value === null) return t('comun.sinDato');
  const texto = `${formatDecimal(value)} mm`;
  return value > 0 ? `+${texto}` : texto;
};

/** Movilidad de Miller legible (`M0`…) o «no evaluada». */
export const mobilityLabel = (grade: MobilityGrade | null): string =>
  grade === null
    ? t('periodonto.movilidad.ausente')
    : t('periodonto.movilidad.nivel', { grado: grade });

/** Grado de furca legible (`I`, `II`, `III`) o guion si no hay lesión registrada. */
export const furcationLabel = (grade: FurcationGrade | null): string =>
  grade === null ? t('comun.sinDato') : furcationRoman(grade);

/** Grado de furca cuando ya se sabe que hay lesión (para tablas y resúmenes). */
export const furcationGradeText = (grade: FurcationGrade): string => furcationRoman(grade);

/** Nombre de la arcada. */
export const archName = (arch: PeriodontalArch): string =>
  arch === 'maxilar' ? t('periodonto.arcada.maxilar') : t('periodonto.arcada.mandibula');

/** Nombre de la entrada de furca (vestibular, mesiopalatina…). */
export const furcationEntranceLabel = (entrance: FurcationEntrance): string =>
  t(FURCATION_ENTRANCE_KEYS[entrance]);

/** Estado del examen (`Borrador` / `Finalizado`). */
export const examStatusLabel = (status: PeriodontalExamStatus): string => t(STATUS_KEYS[status]);

/**
 * Fecha clínica del examen en el formato de la interfaz (`dd/mm/aaaa`).
 *
 * La fecha del examen es un **día sin hora** (`YYYY-MM-DD`): pasarla por `new Date()`
 * la interpreta como medianoche UTC y en Venezuela se imprime el día anterior. Se
 * formatea tal cual, sin convertir de zona.
 */
export const examDateLabel = (examDate: string | null | undefined): string => {
  if (examDate === null || examDate === undefined || examDate === '') {
    return t('comun.sinDato');
  }
  const partes = /^(\d{4})-(\d{2})-(\d{2})$/.exec(examDate);
  if (partes === null) return formatDate(examDate);
  const [, anio, mes, dia] = partes;
  return `${dia ?? ''}/${mes ?? ''}/${anio ?? ''}`;
};

/** Estadio AAP/EFP legible. */
export const stageLabel = (stage: PeriodontalStage): string => t(STAGE_KEYS[stage]);

/** Grado AAP/EFP legible. */
export const gradeLabel = (grade: PeriodontalGrade): string => t(GRADE_KEYS[grade]);

/** Estadio sugerido; `null` = la evidencia no alcanza para clasificar. */
export const suggestedStageLabel = (stage: PeriodontalStage | null): string =>
  stage === null ? t('periodonto.sugerencia.sinEstadio') : stageLabel(stage);

/** Tabaquismo declarado. */
export const smokingLabel = (level: SmokingLevel): string => t(SMOKING_KEYS[level]);

/** Diabetes declarada. */
export const diabetesLabel = (level: DiabetesLevel): string => t(DIABETES_KEYS[level]);

/** Dirección del cambio de un sitio en la comparación. */
export const changeLabel = (change: PeriodontalSiteChange): string => t(CHANGE_KEYS[change]);

/** Motivo concreto de la sugerencia, con su cifra. */
export const evidenceText = (evidence: PeriodontalEvidence): string =>
  t(EVIDENCE_KEYS[evidence.code], { valor: evidence.value });

/** Una línea con la sugerencia completa y sus evidencias, para el panel y el papel. */
export const suggestionText = (suggestion: PeriodontalDiagnosisSuggestion): string => {
  const partes = [
    suggestedStageLabel(suggestion.stage),
    gradeLabel(suggestion.grade),
    ...suggestion.evidence.map(evidenceText),
  ];
  return partes.join(' · ');
};

/** Notas del paciente con su riesgo declarado, en una línea para el informe. */
export const riskFactorsText = (riskFactors: PeriodontalRiskFactors): string => {
  const partes = [smokingLabel(riskFactors.smoking), diabetesLabel(riskFactors.diabetes)];
  if (riskFactors.hba1c !== null) {
    partes.push(t('periodonto.riesgo.hba1cValor', { valor: formatDecimal(riskFactors.hba1c) }));
  }
  return partes.join(' · ');
};

/* ── Tarjetas de indicadores (panel y documento comparten las mismas) ──────── */

export type KpiTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

/** Un indicador ya formateado: etiqueta traducida, valor y, si toca, aviso. */
export interface KpiItem {
  key: string;
  label: string;
  value: string;
  hint?: string;
  tone: KpiTone;
}

/**
 * Indicadores en vivo del examen. Se construyen en un solo sitio para que la pantalla
 * y el papel impriman **las mismas** cifras y los mismos umbrales.
 */
export const kpiItems = (metrics: PeriodontalMetrics): readonly KpiItem[] => {
  const bopFuera = metrics.bopPercent !== null && metrics.bopPercent > PERIODONTAL_BOP_TARGET_MAX;
  const placaFuera =
    metrics.plaquePercent !== null && metrics.plaquePercent > PERIODONTAL_PLAQUE_TARGET_MAX;
  return [
    {
      key: 'sitios',
      label: t('periodonto.kpi.sitiosSondados'),
      value: t('periodonto.kpi.sitiosValor', {
        sondados: metrics.sitesProbed,
        presentes: metrics.sitesPresent,
      }),
      tone: 'neutral',
    },
    {
      key: 'bop',
      label: t('periodonto.kpi.bop'),
      value: percentText(metrics.bopPercent),
      hint: t('periodonto.kpi.meta', { meta: PERIODONTAL_BOP_TARGET_MAX }),
      tone: bopFuera ? 'warning' : metrics.bopPercent === null ? 'neutral' : 'success',
    },
    {
      key: 'placa',
      label: t('periodonto.kpi.placa'),
      value: percentText(metrics.plaquePercent),
      hint: t('periodonto.kpi.meta', { meta: PERIODONTAL_PLAQUE_TARGET_MAX }),
      tone: placaFuera ? 'warning' : metrics.plaquePercent === null ? 'neutral' : 'success',
    },
    {
      key: 'supuracion',
      label: t('periodonto.kpi.supuracion'),
      value: String(metrics.suppurationSites),
      tone: metrics.suppurationSites > 0 ? 'danger' : 'neutral',
    },
    {
      key: 'psMedia',
      label: t('periodonto.kpi.psMedia'),
      value: millimetersText(metrics.meanPd),
      tone: 'neutral',
    },
    {
      key: 'nicMedio',
      label: t('periodonto.kpi.nicMedio'),
      value: millimetersText(metrics.meanCal),
      tone: 'neutral',
    },
    {
      key: 'psMaxima',
      label: t('periodonto.kpi.psMaxima'),
      value: millimetersText(metrics.deepestPd),
      tone: 'neutral',
    },
    {
      key: 'peorNic',
      label: t('periodonto.kpi.peorNic'),
      value: millimetersText(metrics.worstCal),
      tone: 'neutral',
    },
    {
      key: 'nicInterproximal',
      label: t('periodonto.kpi.nicInterproximal'),
      value: millimetersText(metrics.worstInterproximalCal),
      tone: 'neutral',
    },
    {
      key: 'bolsas4',
      label: t('periodonto.kpi.bolsas4'),
      value: String(metrics.pocketsGte4),
      tone: metrics.pocketsGte4 > 0 ? 'warning' : 'neutral',
    },
    {
      key: 'bolsas5',
      label: t('periodonto.kpi.bolsas5'),
      value: String(metrics.pocketsGte5),
      tone: metrics.pocketsGte5 > 0 ? 'warning' : 'neutral',
    },
    {
      key: 'bolsas6',
      label: t('periodonto.kpi.bolsas6'),
      value: String(metrics.pocketsGte6),
      tone: metrics.pocketsGte6 > 0 ? 'danger' : 'neutral',
    },
    {
      key: 'bolsasSangran',
      label: t('periodonto.kpi.bolsasSangran'),
      value: String(metrics.bleedingPocketsGte4),
      tone: metrics.bleedingPocketsGte4 > 0 ? 'danger' : 'neutral',
    },
    {
      key: 'retratamiento',
      label: t('periodonto.kpi.retratamiento'),
      value: String(metrics.retreatmentSites),
      tone: metrics.retreatmentSites > 0 ? 'warning' : 'success',
    },
    {
      key: 'furcas',
      label: t('periodonto.kpi.furcas'),
      value:
        metrics.furcationLesions === 0
          ? String(metrics.furcationLesions)
          : t('periodonto.kpi.furcasValor', {
              total: metrics.furcationLesions,
              peor: furcationLabel(metrics.worstFurcation),
            }),
      tone: metrics.furcationLesions > 0 ? 'warning' : 'neutral',
    },
    {
      key: 'movilidad',
      label: t('periodonto.kpi.movilidad'),
      value: t('periodonto.kpi.movilidadValor', {
        uno: metrics.mobilityGte1,
        dos: metrics.mobilityGte2,
      }),
      tone: metrics.mobilityGte2 > 0 ? 'warning' : 'neutral',
    },
    {
      key: 'piezas',
      label: t('periodonto.kpi.piezas'),
      value: t('periodonto.kpi.piezasValor', {
        presentes: metrics.teethPresent,
        ausentes: metrics.teethMissing,
        implantes: metrics.implants,
      }),
      tone: 'neutral',
    },
  ];
};

/** Resumen de la comparación longitudinal, con las mismas tarjetas que los KPIs. */
export const comparisonKpiItems = (summary: PeriodontalComparisonSummary): readonly KpiItem[] => [
  {
    key: 'comparados',
    label: t('periodonto.comparacion.sitiosComparados'),
    value: String(summary.sitesCompared),
    tone: 'neutral',
  },
  {
    key: 'mejoro',
    label: t('periodonto.cambio.mejoro'),
    value: String(summary.improved),
    tone: summary.improved > 0 ? 'success' : 'neutral',
  },
  {
    key: 'empeoro',
    label: t('periodonto.cambio.empeoro'),
    value: String(summary.worsened),
    tone: summary.worsened > 0 ? 'danger' : 'neutral',
  },
  {
    key: 'estable',
    label: t('periodonto.cambio.estable'),
    value: String(summary.stable),
    tone: 'neutral',
  },
  {
    key: 'deltaPs',
    label: t('periodonto.comparacion.deltaPs'),
    value: deltaText(summary.meanPdDelta),
    tone: 'neutral',
  },
  {
    key: 'deltaNic',
    label: t('periodonto.comparacion.deltaNic'),
    value: deltaText(summary.meanCalDelta),
    tone: 'neutral',
  },
  {
    key: 'deltaBop',
    label: t('periodonto.comparacion.deltaBop'),
    value: percentText(summary.bopPercentDelta, true),
    tone: 'neutral',
  },
  {
    key: 'bolsasNuevas',
    label: t('periodonto.comparacion.bolsasNuevas'),
    value: String(summary.newPocketsGte5),
    tone: summary.newPocketsGte5 > 0 ? 'danger' : 'neutral',
  },
  {
    key: 'bolsasResueltas',
    label: t('periodonto.comparacion.bolsasResueltas'),
    value: String(summary.resolvedPocketsGte5),
    tone: summary.resolvedPocketsGte5 > 0 ? 'success' : 'neutral',
  },
  {
    key: 'perdidos',
    label: t('periodonto.comparacion.dientesPerdidos'),
    value: String(summary.teethLost),
    tone: summary.teethLost > 0 ? 'danger' : 'neutral',
  },
  {
    key: 'ganados',
    label: t('periodonto.comparacion.dientesGanados'),
    value: String(summary.teethGained),
    tone: 'neutral',
  },
];

/** Texto del estado de una pieza (presente, ausente o implante), para la tabla. */
export const toothStateText = (tooth: PeriodontalTooth): string => {
  if (tooth.missing) return t('periodonto.pieza.ausente');
  if (tooth.implant) return t('periodonto.pieza.implante');
  return t('periodonto.pieza.presente');
};
