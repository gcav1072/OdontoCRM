import { z } from 'zod';

import { cleanText } from './patient.js';
import { archOfTooth, archTeeth } from './prosthesis.js';
import { quadrantOfTooth, type OdontogramPatientSnapshot } from './odontogram.js';

/**
 * Periodontograma (v1.1): mapa biométrico y **longitudinal** del periodonto.
 *
 * Se implementa `docs/v1.1_periodontograma/` con las decisiones de arquitectura
 * del repositorio:
 *  - **Sonda por sitios**: cada pieza permanente tiene 6 sitios (3 vestibulares y 3
 *    linguales/palatinos). La cara vestibular se guarda en **tuplas posicionales**
 *    de 3 sitios en orden **visual de izquierda a derecha** (`[izq, centro, der]`),
 *    y `siteAnatomy` traduce cada posición a su nombre anatómico (MV, V, DV…) según
 *    el cuadrante. El servidor y la interfaz **nunca** interpretan la posición a
 *    mano: usan los ayudantes de este módulo, que están probados.
 *  - **Sin dato no es cero**: `pd` y `gm` arrancan en `null` (sitio no sondado).
 *    Inventar un 2 mm de profundidad por defecto falsearía el examen; los índices
 *    se calculan solo sobre sitios **medidos** y el denominador queda explícito.
 *  - **El `NIC` se deriva, nunca se captura**: `NIC = max(0, PS − MG)`, con
 *    `MG = 0` cuando el margen no se registró (convención documentada en
 *    `docs/PERIODONTOGRAMA_BASES_CLINICAS.md`).
 *  - **Una fila por examen, JSONB** (`periodontogram_exams.teeth_data`), con
 *    `revision` para edición optimista y finalización inmutable.
 *
 * Reglas clínicas que este contrato garantiza (y las pruebas demuestran):
 *  - Las furcas existen solo donde la anatomía las admite (`ALLOWED_FURCATIONS_BY_FDI`):
 *    3 entradas en molares superiores, 2 en molares inferiores y 2 en los primeros
 *    premolares superiores. En implantes y piezas ausentes no hay furca ni movilidad.
 *  - La pieza ausente no tiene sitios ni movilidad; el implante sí se sonda (seis
 *    sitios, para mucositis/periimplantitis) pero no se le evalúa movilidad ni furca.
 *  - El orden de las 32 piezas del arreglo es **canónico** (maxilar 18→28 y después
 *    mandíbula 48→38): un JSON con piezas desordenadas o repetidas se rechaza.
 *  - La clasificación AAP/EFP 2018 se **sugiere** con la evidencia disponible. El
 *    estadio se apoya en el NIC interproximal, la profundidad máxima, la furca y la
 *    movilidad; el grado, en los factores de riesgo declarados. La decisión final
 *    la firma el odontólogo: el servicio guarda la clasificación elegida, no la
 *    sugerida.
 */

/* ── Constantes clínicas ───────────────────────────────────────────────────── */

/** Tope de la profundidad de sondaje que admite el contrato (mm). */
export const PERIODONTAL_PD_MAX = 15;

/** Recesión máxima registrable (mm, valor negativo de `gm`). */
export const PERIODONTAL_GM_MIN = -15;

/** Hiperplasia máxima registrable (mm, valor positivo de `gm`). */
export const PERIODONTAL_GM_MAX = 10;

/** Sitios por pieza: 3 vestibulares + 3 linguales/palatinos. */
export const PERIODONTAL_SITES_PER_TOOTH = 6;

/**
 * Versión del esquema de `teeth_data` (JSONB). Se guarda en cada examen para poder
 * migrar documentos viejos sin adivinar su forma cuando el contrato evolucione.
 */
export const PERIODONTAL_SCHEMA_VERSION = 1;

/** Umbral clínico de BOP: por debajo del 10 % se considera inflamación controlada. */
export const PERIODONTAL_BOP_TARGET_MAX = 10;

/** Meta de placa de O'Leary: por debajo del 20 % se considera higiene compatible. */
export const PERIODONTAL_PLAQUE_TARGET_MAX = 20;

/** Profundidad de sondaje que define una bolsa profunda (mm). */
export const PERIODONTAL_DEEP_POCKET = 6;

/** Bolsa que exige retratamiento junto al sangrado (mm). */
export const PERIODONTAL_RETREATMENT_POCKET = 4;

/** Diferencia de PS/NIC, en mm, que la comparación considera cambio real. */
export const PERIODONTAL_DELTA_THRESHOLD = 2;

/* ── Piezas y arcadas ──────────────────────────────────────────────────────── */

/** Arcadas del periodontograma (siempre dentición permanente). */
export const PERIODONTAL_ARCHES = ['maxilar', 'mandibula'] as const;
export type PeriodontalArch = (typeof PERIODONTAL_ARCHES)[number];

/** Piezas del maxilar en orden visual: `18, 17, …, 28`. */
export const PERIODONTAL_UPPER_TEETH: readonly number[] = archTeeth('maxilar');

/** Piezas de la mandíbula en orden visual: `48, 47, …, 38`. */
export const PERIODONTAL_LOWER_TEETH: readonly number[] = archTeeth('mandibula');

/**
 * Orden **canónico** de las piezas de un examen: primero el maxilar y después la
 * mandíbula, cada uno en orden visual. El arreglo `teeth_data` se guarda así y el
 * esquema lo verifica, de modo que la posición del arreglo nunca se desalinea.
 */
export const PERIODONTAL_TEETH: readonly number[] = [
  ...PERIODONTAL_UPPER_TEETH,
  ...PERIODONTAL_LOWER_TEETH,
];

const PERIODONTAL_TOOTH_SET: ReadonlySet<number> = new Set(PERIODONTAL_TEETH);

/** `true` si la pieza forma parte del periodontograma (permanente 11–48). */
export const isPeriodontalTooth = (toothNumber: number): boolean =>
  PERIODONTAL_TOOTH_SET.has(toothNumber);

/** Número FDI admisible en un periodontograma (solo piezas permanentes). */
export const periodontalToothNumberSchema = z.number().int().refine(isPeriodontalTooth, {
  message: 'El periodontograma solo admite piezas permanentes (11–48)',
});

/** Arcada de una pieza permanente, o `null` si el número no es permanente. */
export const periodontalArchOf = (toothNumber: number): PeriodontalArch | null =>
  archOfTooth(toothNumber);

/* ── Sitios: lados, posiciones y anatomía ──────────────────────────────────── */

/** Caras donde se sonda: externa (vestibular) e interna (lingual/palatina). */
export const PERIODONTAL_SIDES = ['vestibular', 'lingual'] as const;
export type PeriodontalSide = (typeof PERIODONTAL_SIDES)[number];
export const periodontalSideSchema = z.enum(PERIODONTAL_SIDES);

/** Posición dentro de la tupla, en orden visual de izquierda a derecha. */
export const PERIODONTAL_SITE_INDEXES = [0, 1, 2] as const;
export type PeriodontalSiteIndex = (typeof PERIODONTAL_SITE_INDEXES)[number];
export const periodontalSiteIndexSchema = z.union([z.literal(0), z.literal(1), z.literal(2)]);

/** Nombre anatómico de un sitio (los 9 nombres posibles de la dentición permanente). */
export const PERIODONTAL_SITE_ANATOMIES = [
  'mesiovestibular',
  'vestibular',
  'distovestibular',
  'mesiopalatino',
  'palatino',
  'distopalatino',
  'mesiolingual',
  'lingual',
  'distolingual',
] as const;
export type PeriodontalSiteAnatomy = (typeof PERIODONTAL_SITE_ANATOMIES)[number];

/** Sigla del sitio, para la tabla numérica y los encabezados del gráfico. */
export const SITE_ANATOMY_SHORT_LABELS: Readonly<Record<PeriodontalSiteAnatomy, string>> = {
  mesiovestibular: 'MV',
  vestibular: 'V',
  distovestibular: 'DV',
  mesiopalatino: 'MP',
  palatino: 'P',
  distopalatino: 'DP',
  mesiolingual: 'ML',
  lingual: 'L',
  distolingual: 'DL',
};

/** Nombre completo del sitio, para la leyenda del informe impreso. */
export const SITE_ANATOMY_NAMES: Readonly<Record<PeriodontalSiteAnatomy, string>> = {
  mesiovestibular: 'Mesiovestibular',
  vestibular: 'Vestibular medio',
  distovestibular: 'Distovestibular',
  mesiopalatino: 'Mesiopalatino',
  distopalatino: 'Distopalatino',
  palatino: 'Palatino medio',
  mesiolingual: 'Mesiolingual',
  distolingual: 'Distolingual',
  lingual: 'Lingual medio',
};

/** Nombre de la cara interna según la arcada: palatina arriba, lingual abajo. */
export const sideLabelFor = (toothNumber: number, side: PeriodontalSide): string => {
  if (side === 'vestibular') return 'Vestibular';
  return periodontalArchOf(toothNumber) === 'maxilar' ? 'Palatino' : 'Lingual';
};

/**
 * Traduce una posición **visual** (`0` = izquierda de la pantalla) a su nombre
 * anatómico. En los cuadrantes derechos del paciente (1 y 4) la izquierda de la
 * pantalla es el lado **distal**; en los izquierdos (2 y 3), el **mesial**.
 *
 * Es la única función que conoce esa correspondencia: el gráfico, la tabla y la
 * impresión la usan en vez de repetir el `if`.
 */
export const siteAnatomy = (
  toothNumber: number,
  side: PeriodontalSide,
  index: PeriodontalSiteIndex,
): PeriodontalSiteAnatomy => {
  const arch = periodontalArchOf(toothNumber);
  const interna: 'palatino' | 'lingual' = arch === 'maxilar' ? 'palatino' : 'lingual';
  const cara = side === 'vestibular' ? 'vestibular' : interna;

  if (index === 1) return cara === 'vestibular' ? 'vestibular' : interna;

  const cuadrante = quadrantOfTooth(toothNumber);
  const esCuadranteDerecho = cuadrante === 1 || cuadrante === 4;
  const esMesial = esCuadranteDerecho ? index === 2 : index === 0;

  // «mesio»/«disto» + «vestibular»/«palatino»/«lingual» forman siempre uno de los
  // nombres del catálogo; el cast queda respaldado por las pruebas de los 32 dientes.
  return `${esMesial ? 'mesio' : 'disto'}${cara}` as PeriodontalSiteAnatomy;
};

/** Sigla anatómica del sitio (`MV`, `P`, `DL`…). */
export const siteShortLabel = (
  toothNumber: number,
  side: PeriodontalSide,
  index: PeriodontalSiteIndex,
): string => SITE_ANATOMY_SHORT_LABELS[siteAnatomy(toothNumber, side, index)];

/** `true` si el sitio es interproximal (mesial o distal, nunca el centro de la cara). */
export const isInterproximalSite = (index: PeriodontalSiteIndex): boolean => index !== 1;

/**
 * `true` si el sitio es **mesial** en la boca (no en la pantalla). Lo necesita la
 * clasificación: el estadio se apoya en el NIC interproximal, y el gráfico ordena
 * los sitios por posición visual, no por anatomía.
 */
export const siteIsMesial = (toothNumber: number, index: PeriodontalSiteIndex): boolean => {
  const cuadrante = quadrantOfTooth(toothNumber);
  return cuadrante === 1 || cuadrante === 4 ? index === 2 : index === 0;
};

/* ── Furcas y movilidad ────────────────────────────────────────────────────── */

/** Entradas de furca que existen anatómicamente en la dentición permanente. */
export const FURCATION_ENTRANCES = [
  'vestibular',
  'lingual',
  'mesiopalatina',
  'distopalatina',
  'mesial',
  'distal',
] as const;
export type FurcationEntrance = (typeof FURCATION_ENTRANCES)[number];
export const furcationEntranceSchema = z.enum(FURCATION_ENTRANCES);

/** Grado de lesión de furca (Hamp): la ausencia de lesión es la **ausencia de clave**. */
export const FURCATION_GRADES = [1, 2, 3] as const;
export type FurcationGrade = (typeof FURCATION_GRADES)[number];
export const furcationGradeSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);

/** Nombre de la entrada de furca en la interfaz. */
export const FURCATION_ENTRANCE_LABELS: Readonly<Record<FurcationEntrance, string>> = {
  vestibular: 'Vestibular',
  lingual: 'Lingual',
  mesiopalatina: 'Mesiopalatina',
  distopalatina: 'Distopalatina',
  mesial: 'Mesial',
  distal: 'Distal',
};

/** Sigla de la entrada de furca para el gráfico. */
export const FURCATION_ENTRANCE_SHORT: Readonly<Record<FurcationEntrance, string>> = {
  vestibular: 'V',
  lingual: 'L',
  mesiopalatina: 'MP',
  distopalatina: 'DP',
  mesial: 'M',
  distal: 'D',
};

/**
 * Mapa anatómico estricto de furcas (regla de validación del dominio):
 *
 * - Molares superiores (3 raíces): `vestibular`, `mesiopalatina`, `distopalatina`.
 * - Molares inferiores (2 raíces): `vestibular`, `lingual`.
 * - Primeros premolares superiores (birradiculares en el 60–80 %): `mesial`, `distal`.
 * - Incisivos, caninos, segundos premolares y terceros molares superiores sin
 *   entrada anatómica: no aparecen en el mapa.
 */
export const ALLOWED_FURCATIONS_BY_FDI: Readonly<Record<number, readonly FurcationEntrance[]>> = {
  18: ['vestibular', 'mesiopalatina', 'distopalatina'],
  17: ['vestibular', 'mesiopalatina', 'distopalatina'],
  16: ['vestibular', 'mesiopalatina', 'distopalatina'],
  26: ['vestibular', 'mesiopalatina', 'distopalatina'],
  27: ['vestibular', 'mesiopalatina', 'distopalatina'],
  28: ['vestibular', 'mesiopalatina', 'distopalatina'],
  14: ['mesial', 'distal'],
  24: ['mesial', 'distal'],
  48: ['vestibular', 'lingual'],
  47: ['vestibular', 'lingual'],
  46: ['vestibular', 'lingual'],
  36: ['vestibular', 'lingual'],
  37: ['vestibular', 'lingual'],
  38: ['vestibular', 'lingual'],
};

const SIN_FURCAS: readonly FurcationEntrance[] = [];

/** Entradas de furca disponibles en una pieza (`[]` si no tiene ninguna). */
export const furcationEntrancesFor = (toothNumber: number): readonly FurcationEntrance[] =>
  ALLOWED_FURCATIONS_BY_FDI[toothNumber] ?? SIN_FURCAS;

/** `true` si la pieza admite alguna lesión de furca. */
export const allowsFurcation = (toothNumber: number): boolean =>
  furcationEntrancesFor(toothNumber).length > 0;

/** Grados de movilidad de Miller: 0 = fisiológica; `null` = no evaluada. */
export const MOBILITY_GRADES = [0, 1, 2, 3] as const;
export type MobilityGrade = (typeof MOBILITY_GRADES)[number];
export const mobilityGradeSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
]);

/* ── Esquemas de sitio, pieza y examen ─────────────────────────────────────── */

/**
 * Un sitio sondado. `pd` y `gm` son `null` hasta que se miden: **no hay valor por
 * defecto** porque un 0 o un 2 inventados se leerían como hallazgo clínico.
 */
export const periodontalSiteSchema = z.object({
  /** Profundidad de sondaje (mm): del margen gingival al fondo del surco. */
  pd: z.number().int().min(0).max(PERIODONTAL_PD_MAX).nullable().default(null),
  /** Posición del margen gingival (mm): negativo = recesión, positivo = hiperplasia. */
  gm: z.number().int().min(PERIODONTAL_GM_MIN).max(PERIODONTAL_GM_MAX).nullable().default(null),
  /** Sangrado al sondaje (BOP). */
  bop: z.boolean().default(false),
  /** Placa bacteriana visible en el sitio. */
  plaque: z.boolean().default(false),
  /** Supuración al sondear. */
  suppuration: z.boolean().default(false),
});
export type PeriodontalSite = z.infer<typeof periodontalSiteSchema>;

/** Tres sitios de una cara, en orden **visual** de izquierda a derecha. */
export const periodontalSitesSchema = z.tuple([
  periodontalSiteSchema,
  periodontalSiteSchema,
  periodontalSiteSchema,
]);
export type PeriodontalSites = z.infer<typeof periodontalSitesSchema>;

/** Sitio sin sondar (lo que se pinta como «—»). */
export const emptyPeriodontalSite = (): PeriodontalSite => ({
  pd: null,
  gm: null,
  bop: false,
  plaque: false,
  suppuration: false,
});

const emptyPeriodontalSites = (): PeriodontalSites => [
  emptyPeriodontalSite(),
  emptyPeriodontalSite(),
  emptyPeriodontalSite(),
];

/** Texto opcional normalizado: recorta, y la cadena vacía se guarda como `null`. */
const optionalText = (max: number) =>
  z
    .string()
    .max(max)
    .transform(cleanText)
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .default(null);

/** Una pieza del periodontograma. */
export const periodontalToothSchema = z.object({
  /** Número FDI de la pieza (solo permanentes). */
  fdi: periodontalToothNumberSchema,
  /** Pieza ausente: sin sitios, sin movilidad y sin furca. */
  missing: z.boolean().default(false),
  /** Implante: se sonda, no tiene furca ni movilidad. */
  implant: z.boolean().default(false),
  /** Movilidad de Miller; `null` = no evaluada. */
  mobility: mobilityGradeSchema.nullable().default(null),
  /** Lesiones de furca por entrada; la ausencia de clave es el grado 0. */
  furcation: z.partialRecord(furcationEntranceSchema, furcationGradeSchema).default({}),
  /** Tres sitios vestibulares, en orden visual. */
  vestibular: periodontalSitesSchema,
  /** Tres sitios linguales/palatinos, en orden visual. */
  lingual: periodontalSitesSchema,
  notes: optionalText(500),
});
export type PeriodontalTooth = z.infer<typeof periodontalToothSchema>;

/** Los 6 sitios de una pieza con su identidad, para recorrerla sin repetir `if`. */
export interface PeriodontalSiteRef {
  fdi: number;
  side: PeriodontalSide;
  index: PeriodontalSiteIndex;
  site: PeriodontalSite;
}

/** Los 6 sitios de una pieza, primero vestibular y después lingual, en orden visual. */
export const sitesOfTooth = (tooth: PeriodontalTooth): PeriodontalSiteRef[] => [
  { fdi: tooth.fdi, side: 'vestibular', index: 0, site: tooth.vestibular[0] },
  { fdi: tooth.fdi, side: 'vestibular', index: 1, site: tooth.vestibular[1] },
  { fdi: tooth.fdi, side: 'vestibular', index: 2, site: tooth.vestibular[2] },
  { fdi: tooth.fdi, side: 'lingual', index: 0, site: tooth.lingual[0] },
  { fdi: tooth.fdi, side: 'lingual', index: 1, site: tooth.lingual[1] },
  { fdi: tooth.fdi, side: 'lingual', index: 2, site: tooth.lingual[2] },
];

/** Pieza del gráfico por su FDI, o `null` si no está en el arreglo. */
export const findPeriodontalTooth = (
  chart: readonly PeriodontalTooth[],
  toothNumber: number,
): PeriodontalTooth | null => chart.find((tooth) => tooth.fdi === toothNumber) ?? null;

/** Sitio concreto del examen, o `null` si la pieza no está. */
export const findPeriodontalSite = (
  chart: readonly PeriodontalTooth[],
  toothNumber: number,
  side: PeriodontalSide,
  index: PeriodontalSiteIndex,
): PeriodontalSite | null => {
  const tooth = findPeriodontalTooth(chart, toothNumber);
  if (tooth === null) return null;
  return side === 'vestibular' ? tooth.vestibular[index] : tooth.lingual[index];
};

/**
 * Verifica la coherencia que el `superRefine` del arreglo no puede expresar por
 * pieza suelta: orden canónico, pieza ausente/implante sin datos imposibles y
 * furcas solo donde la anatomía las admite.
 */
const refinePeriodontalChart = (chart: readonly PeriodontalTooth[], ctx: z.RefinementCtx): void => {
  chart.forEach((tooth, index) => {
    const esperada = PERIODONTAL_TEETH[index];
    if (tooth.fdi !== esperada) {
      ctx.addIssue({
        code: 'custom',
        path: [index, 'fdi'],
        message: `Pieza fuera de orden: se esperaba ${String(esperada)} y llegó ${String(tooth.fdi)}`,
      });
    }

    if (tooth.missing && tooth.implant) {
      ctx.addIssue({
        code: 'custom',
        path: [index, 'implant'],
        message: 'Una pieza no puede estar ausente y ser un implante a la vez',
      });
    }

    const sitios = sitesOfTooth(tooth);
    if (tooth.missing) {
      const conDatos = sitios.filter(
        ({ site }) =>
          site.pd !== null || site.gm !== null || site.bop || site.plaque || site.suppuration,
      );
      if (conDatos.length > 0) {
        ctx.addIssue({
          code: 'custom',
          path: [index, 'missing'],
          message: `La pieza ${String(tooth.fdi)} está ausente: no admite sitios con datos`,
        });
      }
      if (tooth.mobility !== null) {
        ctx.addIssue({
          code: 'custom',
          path: [index, 'mobility'],
          message: `La pieza ${String(tooth.fdi)} está ausente: no admite movilidad`,
        });
      }
    }

    if (tooth.implant) {
      if (tooth.mobility !== null) {
        ctx.addIssue({
          code: 'custom',
          path: [index, 'mobility'],
          message: `La pieza ${String(tooth.fdi)} es un implante: no se le evalúa movilidad`,
        });
      }
      if (Object.keys(tooth.furcation).length > 0) {
        ctx.addIssue({
          code: 'custom',
          path: [index, 'furcation'],
          message: `La pieza ${String(tooth.fdi)} es un implante: no tiene furca`,
        });
      }
    }

    if (!tooth.missing) {
      const permitidas = furcationEntrancesFor(tooth.fdi);
      for (const entrada of Object.keys(tooth.furcation) as FurcationEntrance[]) {
        if (!permitidas.includes(entrada)) {
          ctx.addIssue({
            code: 'custom',
            path: [index, 'furcation', entrada],
            message:
              permitidas.length === 0
                ? `La pieza ${String(tooth.fdi)} no tiene entradas de furca: ${entrada} no existe`
                : `La pieza ${String(tooth.fdi)} solo admite las furcas ${permitidas.join(', ')}`,
          });
        }
      }
    }
  });
};

/**
 * Boca completa del periodontograma: **32 piezas permanentes** en orden canónico.
 * Es el documento que se guarda en `teeth_data` y se pinta en pantalla.
 */
export const periodontalChartSchema = z
  .array(periodontalToothSchema)
  .length(PERIODONTAL_TEETH.length, {
    message: `El periodontograma debe traer las ${String(PERIODONTAL_TEETH.length)} piezas permanentes`,
  })
  .superRefine(refinePeriodontalChart);
export type PeriodontalChart = z.infer<typeof periodontalChartSchema>;

/** Lo que aporta el odontograma vigente al abrir un periodontograma nuevo. */
export interface PeriodontalChartSeed {
  /** Piezas ausentes/extraídas según el odontograma. */
  missing?: readonly number[];
  /** Piezas con implante según el odontograma. */
  implants?: readonly number[];
}

/**
 * Arma la boca vacía de un examen nuevo: las 32 piezas, marcando las que el
 * odontograma da por ausentes o con implante. No copia mediciones: un examen
 * nuevo no puede heredar cifras que no se sondaron hoy.
 */
export const buildPeriodontalChart = (seed: PeriodontalChartSeed = {}): PeriodontalChart => {
  const ausentes = new Set(seed.missing ?? []);
  const implantes = new Set(seed.implants ?? []);

  return PERIODONTAL_TEETH.map((fdi) => {
    const missing = ausentes.has(fdi);
    return {
      fdi,
      missing,
      implant: !missing && implantes.has(fdi),
      mobility: null,
      furcation: {},
      vestibular: emptyPeriodontalSites(),
      lingual: emptyPeriodontalSites(),
      notes: null,
    };
  });
};

/* ── Factores de riesgo y diagnóstico ──────────────────────────────────────── */

/** Consumo de tabaco declarado (factor de riesgo del grado). */
export const SMOKING_LEVELS = ['no', 'menos10', 'mas10'] as const;
export type SmokingLevel = (typeof SMOKING_LEVELS)[number];
export const smokingLevelSchema = z.enum(SMOKING_LEVELS);

/** Estado de la diabetes declarado (factor de riesgo del grado). */
export const DIABETES_LEVELS = ['no', 'controlada', 'descontrolada'] as const;
export type DiabetesLevel = (typeof DIABETES_LEVELS)[number];
export const diabetesLevelSchema = z.enum(DIABETES_LEVELS);

/** Nombre del nivel de tabaquismo en la interfaz. */
export const SMOKING_LABELS: Readonly<Record<SmokingLevel, string>> = {
  no: 'No fuma',
  menos10: 'Fumador de menos de 10 cigarrillos al día',
  mas10: 'Fumador de 10 o más cigarrillos al día',
};

/** Nombre del estado de la diabetes en la interfaz. */
export const DIABETES_LABELS: Readonly<Record<DiabetesLevel, string>> = {
  no: 'No diabético',
  controlada: 'Diabetes controlada (HbA1c < 7 %)',
  descontrolada: 'Diabetes no controlada (HbA1c ≥ 7 %)',
};

/**
 * Factores de riesgo que la clasificación AAP/EFP necesita y que **no** se derivan
 * de la sonda: sin ellos el grado no se puede estimar.
 */
export const periodontalRiskFactorsSchema = z.object({
  smoking: smokingLevelSchema.default('no'),
  diabetes: diabetesLevelSchema.default('no'),
  /** HbA1c declarada (%), cuando se conoce. */
  hba1c: z.number().min(3).max(20).nullable().default(null),
});
export type PeriodontalRiskFactors = z.infer<typeof periodontalRiskFactorsSchema>;

/** Factores de riesgo sin declarar: no fuma, no diabético, sin HbA1c. */
export const emptyPeriodontalRiskFactors = (): PeriodontalRiskFactors => ({
  smoking: 'no',
  diabetes: 'no',
  hba1c: null,
});

/** Estadios de la clasificación AAP/EFP 2018. */
export const PERIODONTAL_STAGES = [1, 2, 3, 4] as const;
export type PeriodontalStage = (typeof PERIODONTAL_STAGES)[number];
export const periodontalStageSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
]);

/** Grados de progresión de la clasificación AAP/EFP 2018. */
export const PERIODONTAL_GRADES = ['A', 'B', 'C'] as const;
export type PeriodontalGrade = (typeof PERIODONTAL_GRADES)[number];
export const periodontalGradeSchema = z.enum(PERIODONTAL_GRADES);

/** Nombre del estadio en la interfaz y el informe. */
export const PERIODONTAL_STAGE_LABELS: Readonly<Record<PeriodontalStage, string>> = {
  1: 'Estadio I (inicial)',
  2: 'Estadio II (moderado)',
  3: 'Estadio III (severo)',
  4: 'Estadio IV (avanzado)',
};

/** Nombre del grado en la interfaz y el informe. */
export const PERIODONTAL_GRADE_LABELS: Readonly<Record<PeriodontalGrade, string>> = {
  A: 'Grado A (progresión lenta)',
  B: 'Grado B (progresión moderada)',
  C: 'Grado C (progresión rápida)',
};

/** Clasificación que firma el odontólogo (no la sugerencia del sistema). */
export const periodontalDiagnosisSchema = z
  .object({
    stage: periodontalStageSchema,
    grade: periodontalGradeSchema,
    /** Justificación o matices de la clasificación (fumador, hallazgos radiológicos…). */
    notes: optionalText(1000),
  })
  .strict();
export type PeriodontalDiagnosis = z.infer<typeof periodontalDiagnosisSchema>;

/* ── Medidas derivadas por sitio ───────────────────────────────────────────── */

/**
 * Nivel de inserción clínica (NIC/CAL) de un sitio: `max(0, PS − MG)`.
 *
 * Si el margen no se registró se asume **a nivel del LAC** (`MG = 0`) para poder
 * calcular el índice, pero el dato guardado sigue siendo `null`: la asunción es de
 * cálculo, no un valor implantado en la historia. Un sitio **no sondado** no tiene
 * NIC (`null`), porque no hay PS de la que partir.
 */
export const attachmentLevel = (site: Pick<PeriodontalSite, 'pd' | 'gm'>): number | null => {
  if (site.pd === null) return null;
  return Math.max(0, site.pd - (site.gm ?? 0));
};

/** `true` si el sitio tiene profundidad de sondaje medida. */
export const siteIsMeasured = (site: Pick<PeriodontalSite, 'pd'>): boolean => site.pd !== null;

/* ── Métricas agregadas del examen ─────────────────────────────────────────── */

/** Índices y conteos de los implantes (se informan aparte de la dentición natural). */
export interface PeriodontalImplantMetrics {
  implants: number;
  sitesProbed: number;
  bopSites: number;
  bopPercent: number | null;
  plaqueSites: number;
  plaquePercent: number | null;
  suppurationSites: number;
  meanPd: number | null;
  meanCal: number | null;
  deepestPd: number | null;
  pocketsGte5: number;
}

/**
 * KPIs de un examen. Los índices de la dentición **natural** usan como denominador
 * los sitios realmente medidos: un sitio sin sondar no cuenta ni a favor ni en
 * contra. Los implantes tienen su bloque (`implant`) porque sus umbrales
 * diagnósticos son otros (mucositis/periimplantitis).
 */
export interface PeriodontalMetrics {
  /** Piezas naturales presentes (ni ausentes ni implantes). */
  teethPresent: number;
  /** Piezas ausentes. */
  teethMissing: number;
  /** Piezas con implante. */
  implants: number;
  /** Sitios de las piezas naturales presentes (presentes × 6). */
  sitesPresent: number;
  /** Sitios naturales con PS medida (el denominador real de los índices). */
  sitesProbed: number;
  bopSites: number;
  /** % de sangrado sobre sitios medidos; `null` si no hay ninguno. */
  bopPercent: number | null;
  plaqueSites: number;
  /** % de placa sobre sitios medidos; `null` si no hay ninguno. */
  plaquePercent: number | null;
  suppurationSites: number;
  meanPd: number | null;
  meanCal: number | null;
  deepestPd: number | null;
  worstCal: number | null;
  /** Peor NIC de los sitios interproximales (mesial/distal): base del estadio. */
  worstInterproximalCal: number | null;
  pocketsGte4: number;
  pocketsGte5: number;
  pocketsGte6: number;
  /** Bolsas de 4 mm o más que además sangran. */
  bleedingPocketsGte4: number;
  /** Sitios que la guía EFP S3 considera pendientes de retratamiento. */
  retreatmentSites: number;
  furcationLesions: number;
  worstFurcation: FurcationGrade | null;
  /** Piezas con movilidad ≥ 1. */
  mobilityGte1: number;
  /** Piezas con movilidad ≥ 2. */
  mobilityGte2: number;
  implant: PeriodontalImplantMetrics;
}

const round1 = (value: number): number => Math.round(value * 10) / 10;

const meanOf = (values: readonly number[]): number | null =>
  values.length === 0
    ? null
    : round1(values.reduce((suma, value) => suma + value, 0) / values.length);

const percentOf = (count: number, total: number): number | null =>
  total === 0 ? null : round1((count / total) * 100);

/**
 * Calcula los índices del examen. Pura y sin dependencias: la usan el servidor
 * (para guardar el resumen y publicarlo) y la interfaz (para pintar los KPIs en
 * vivo mientras se carga la boca).
 */
export const periodontalMetrics = (chart: readonly PeriodontalTooth[]): PeriodontalMetrics => {
  let teethPresent = 0;
  let teethMissing = 0;
  let implants = 0;
  let sitesProbed = 0;
  let bopSites = 0;
  let plaqueSites = 0;
  let suppurationSites = 0;
  let deepestPd: number | null = null;
  let worstCal: number | null = null;
  let worstInterproximalCal: number | null = null;
  let pocketsGte4 = 0;
  let pocketsGte5 = 0;
  let pocketsGte6 = 0;
  let bleedingPocketsGte4 = 0;
  let retreatmentSites = 0;
  let furcationLesions = 0;
  let worstFurcation: FurcationGrade | null = null;
  let mobilityGte1 = 0;
  let mobilityGte2 = 0;

  const pdValues: number[] = [];
  const calValues: number[] = [];

  let implantSitesProbed = 0;
  let implantBopSites = 0;
  let implantPlaqueSites = 0;
  let implantSuppurationSites = 0;
  let implantDeepestPd: number | null = null;
  let implantPocketsGte5 = 0;
  const implantPdValues: number[] = [];
  const implantCalValues: number[] = [];

  for (const tooth of chart) {
    if (tooth.missing) {
      teethMissing += 1;
      continue;
    }

    if (tooth.implant) {
      implants += 1;
      for (const { site } of sitesOfTooth(tooth)) {
        if (site.pd === null) continue;
        implantSitesProbed += 1;
        implantPdValues.push(site.pd);
        if (site.bop) implantBopSites += 1;
        if (site.plaque) implantPlaqueSites += 1;
        if (site.suppuration) implantSuppurationSites += 1;
        if (implantDeepestPd === null || site.pd > implantDeepestPd) implantDeepestPd = site.pd;
        if (site.pd >= 5) implantPocketsGte5 += 1;
        const cal = attachmentLevel(site);
        if (cal !== null) implantCalValues.push(cal);
      }
      continue;
    }

    teethPresent += 1;
    if (tooth.mobility !== null) {
      if (tooth.mobility >= 1) mobilityGte1 += 1;
      if (tooth.mobility >= 2) mobilityGte2 += 1;
    }
    for (const entrada of Object.keys(tooth.furcation) as FurcationEntrance[]) {
      const grado = tooth.furcation[entrada];
      if (grado === undefined) continue;
      furcationLesions += 1;
      if (worstFurcation === null || grado > worstFurcation) worstFurcation = grado;
    }

    for (const { index, site } of sitesOfTooth(tooth)) {
      if (site.pd === null) continue;
      sitesProbed += 1;
      pdValues.push(site.pd);
      if (deepestPd === null || site.pd > deepestPd) deepestPd = site.pd;
      if (site.bop) bopSites += 1;
      if (site.plaque) plaqueSites += 1;
      if (site.suppuration) suppurationSites += 1;

      if (site.pd >= PERIODONTAL_RETREATMENT_POCKET) pocketsGte4 += 1;
      if (site.pd >= 5) pocketsGte5 += 1;
      if (site.pd >= PERIODONTAL_DEEP_POCKET) pocketsGte6 += 1;
      if (site.pd >= PERIODONTAL_RETREATMENT_POCKET && site.bop) bleedingPocketsGte4 += 1;
      // Objetivo EFP S3: ninguna bolsa ≥ 5 mm y ninguna bolsa de 4 mm que sangre.
      if (site.pd >= 5 || (site.pd === PERIODONTAL_RETREATMENT_POCKET && site.bop)) {
        retreatmentSites += 1;
      }

      const cal = attachmentLevel(site);
      if (cal !== null) {
        calValues.push(cal);
        if (worstCal === null || cal > worstCal) worstCal = cal;
        // La interproximalidad depende de la posición visual, no de la cara: el
        // índice 1 es el centro de la cara en las dos caras.
        if (
          isInterproximalSite(index) &&
          (worstInterproximalCal === null || cal > worstInterproximalCal)
        ) {
          worstInterproximalCal = cal;
        }
      }
    }
  }

  return {
    teethPresent,
    teethMissing,
    implants,
    sitesPresent: teethPresent * PERIODONTAL_SITES_PER_TOOTH,
    sitesProbed,
    bopSites,
    bopPercent: percentOf(bopSites, sitesProbed),
    plaqueSites,
    plaquePercent: percentOf(plaqueSites, sitesProbed),
    suppurationSites,
    meanPd: meanOf(pdValues),
    meanCal: meanOf(calValues),
    deepestPd,
    worstCal,
    worstInterproximalCal,
    pocketsGte4,
    pocketsGte5,
    pocketsGte6,
    bleedingPocketsGte4,
    retreatmentSites,
    furcationLesions,
    worstFurcation,
    mobilityGte1,
    mobilityGte2,
    implant: {
      implants,
      sitesProbed: implantSitesProbed,
      bopSites: implantBopSites,
      bopPercent: percentOf(implantBopSites, implantSitesProbed),
      plaqueSites: implantPlaqueSites,
      plaquePercent: percentOf(implantPlaqueSites, implantSitesProbed),
      suppurationSites: implantSuppurationSites,
      meanPd: meanOf(implantPdValues),
      meanCal: meanOf(implantCalValues),
      deepestPd: implantDeepestPd,
      pocketsGte5: implantPocketsGte5,
    },
  };
};

/* ── Clasificación AAP/EFP 2018 sugerida ───────────────────────────────────── */

/** Motivo de la sugerencia: la interfaz lo traduce y el informe lo imprime. */
export const PERIODONTAL_EVIDENCE_CODES = [
  'nic_interproximal',
  'bolsa_profunda',
  'furca_avanzada',
  'movilidad_avanzada',
  'dientes_perdidos',
  'bolsas_5mm',
  'tabaquismo',
  'diabetes',
  'hba1c',
] as const;
export type PeriodontalEvidenceCode = (typeof PERIODONTAL_EVIDENCE_CODES)[number];

/** Dato concreto que sostiene la sugerencia (código traducible + cifra). */
export interface PeriodontalEvidence {
  code: PeriodontalEvidenceCode;
  value: number;
}

/** Clasificación sugerida: el estadio puede no existir si no hay periodontitis. */
export interface PeriodontalDiagnosisSuggestion {
  /** `null` = no hay criterios medibles de periodontitis (no se clasifica). */
  stage: PeriodontalStage | null;
  grade: PeriodontalGrade;
  evidence: PeriodontalEvidence[];
}

/**
 * Sugiere **estadio** y **grado** con la evidencia del examen. Es una ayuda, no un
 * diagnóstico: la clasificación se firma en `PeriodontalDiagnosis`.
 *
 * Límites conocidos y asumidos (se explican en las bases clínicas): no hay
 * radiografía, así que el estadio usa el NIC clínico y la pérdida dental como
 * proxy; el grado se estima solo con factores de riesgo porque la ratio pérdida
 * ósea/edad no está en el sistema.
 */
export const suggestPeriodontalDiagnosis = (
  metrics: PeriodontalMetrics,
  riskFactors: PeriodontalRiskFactors,
): PeriodontalDiagnosisSuggestion => {
  const evidence: PeriodontalEvidence[] = [];
  const nicInterproximal = metrics.worstInterproximalCal ?? 0;
  const bolsaProfunda = metrics.deepestPd ?? 0;
  const peorFurca = metrics.worstFurcation ?? 0;

  let stage: PeriodontalStage | null = null;
  if (metrics.teethMissing >= 5) {
    stage = 4;
  } else if (
    nicInterproximal >= 5 ||
    bolsaProfunda >= PERIODONTAL_DEEP_POCKET ||
    peorFurca >= 2 ||
    metrics.mobilityGte2 >= 1
  ) {
    stage = 3;
  } else if (nicInterproximal >= 3) {
    stage = 2;
  } else if (nicInterproximal >= 1) {
    stage = 1;
  }

  if (nicInterproximal > 0) evidence.push({ code: 'nic_interproximal', value: nicInterproximal });
  if (bolsaProfunda >= PERIODONTAL_DEEP_POCKET) {
    evidence.push({ code: 'bolsa_profunda', value: bolsaProfunda });
  }
  if (peorFurca >= 2) evidence.push({ code: 'furca_avanzada', value: peorFurca });
  if (metrics.mobilityGte2 >= 1) {
    evidence.push({ code: 'movilidad_avanzada', value: metrics.mobilityGte2 });
  }
  if (metrics.teethMissing > 0) {
    evidence.push({ code: 'dientes_perdidos', value: metrics.teethMissing });
  }
  if (metrics.pocketsGte5 > 0) evidence.push({ code: 'bolsas_5mm', value: metrics.pocketsGte5 });

  const tabaco = riskFactors.smoking === 'mas10' ? 2 : riskFactors.smoking === 'menos10' ? 1 : 0;
  const diabetes =
    riskFactors.diabetes === 'descontrolada' ? 2 : riskFactors.diabetes === 'controlada' ? 1 : 0;
  const hba1c =
    riskFactors.hba1c === null || riskFactors.diabetes === 'no'
      ? 0
      : riskFactors.hba1c >= 7
        ? 2
        : riskFactors.hba1c >= 6.5
          ? 1
          : 0;

  if (tabaco > 0) evidence.push({ code: 'tabaquismo', value: tabaco });
  if (diabetes > 0) evidence.push({ code: 'diabetes', value: diabetes });
  if (hba1c > 0 && riskFactors.hba1c !== null) {
    evidence.push({ code: 'hba1c', value: riskFactors.hba1c });
  }

  const score = Math.max(tabaco, diabetes, hba1c);
  const grade: PeriodontalGrade = score >= 2 ? 'C' : score >= 1 ? 'B' : 'A';

  return { stage, grade, evidence };
};

/** Lo que la interfaz necesita para pintar los KPIs y la sugerencia de una boca. */
export interface PeriodontalChartAnalysis {
  metrics: PeriodontalMetrics;
  suggestion: PeriodontalDiagnosisSuggestion;
}

/** Analiza una boca completa con sus factores de riesgo. */
export const analyzePeriodontalChart = (
  chart: readonly PeriodontalTooth[],
  riskFactors: PeriodontalRiskFactors = emptyPeriodontalRiskFactors(),
): PeriodontalChartAnalysis => {
  const metrics = periodontalMetrics(chart);
  return { metrics, suggestion: suggestPeriodontalDiagnosis(metrics, riskFactors) };
};

/* ── Comparación longitudinal entre dos exámenes ───────────────────────────── */

/** Cómo cambió un sitio entre el examen anterior y el actual. */
export const PERIODONTAL_SITE_CHANGES = [
  'mejoro',
  'empeoro',
  'estable',
  'sin_anterior',
  'sin_actual',
  'sin_dato',
] as const;
export type PeriodontalSiteChange = (typeof PERIODONTAL_SITE_CHANGES)[number];

/** Lo que se compara de un sitio: PS, MG, NIC y sangrado. */
export interface PeriodontalSiteSnapshot {
  pd: number | null;
  gm: number | null;
  cal: number | null;
  bop: boolean;
}

/** Diferencia de un sitio entre dos exámenes. */
export interface PeriodontalSiteDiff {
  fdi: number;
  side: PeriodontalSide;
  index: PeriodontalSiteIndex;
  previous: PeriodontalSiteSnapshot | null;
  current: PeriodontalSiteSnapshot | null;
  deltaPd: number | null;
  deltaCal: number | null;
  change: PeriodontalSiteChange;
  /** Bolsa ≥ 5 mm que no estaba en el examen anterior. */
  newPocket: boolean;
  /** Bolsa ≥ 5 mm del examen anterior que ya no está. */
  resolvedPocket: boolean;
}

/** Resumen de la comparación (lo que se enseña arriba del gráfico). */
export interface PeriodontalComparisonSummary {
  sitesCompared: number;
  improved: number;
  worsened: number;
  stable: number;
  meanPdDelta: number | null;
  meanCalDelta: number | null;
  bopPercentDelta: number | null;
  newPocketsGte5: number;
  resolvedPocketsGte5: number;
  teethLost: number;
  teethGained: number;
}

/** Comparación longitudinal entre dos exámenes del mismo paciente. */
export interface PeriodontalComparison {
  previousExamId: string;
  currentExamId: string;
  summary: PeriodontalComparisonSummary;
  sites: PeriodontalSiteDiff[];
}

const toSiteSnapshot = (site: PeriodontalSite): PeriodontalSiteSnapshot => ({
  pd: site.pd,
  gm: site.gm,
  cal: attachmentLevel(site),
  bop: site.bop,
});

const pocketOf = (snapshot: PeriodontalSiteSnapshot | null): number | null =>
  snapshot === null ? null : snapshot.pd;

/**
 * Compara dos bocas sitio a sitio. La dirección del cambio se decide por la
 * diferencia de PS y de NIC: se considera cambio real cuando alguna de las dos
 * llega a `PERIODONTAL_DELTA_THRESHOLD` milímetros (el diente no cambia por 1 mm
 * entre exámenes, que es ruido de sondaje).
 */
export const comparePeriodontalCharts = (input: {
  previousExamId: string;
  previous: readonly PeriodontalTooth[];
  currentExamId: string;
  current: readonly PeriodontalTooth[];
}): PeriodontalComparison => {
  const sites: PeriodontalSiteDiff[] = [];
  const pares: Array<{
    deltaPd: number | null;
    deltaCal: number | null;
    change: PeriodontalSiteChange;
  }> = [];
  let improved = 0;
  let worsened = 0;
  let stable = 0;
  let newPocketsGte5 = 0;
  let resolvedPocketsGte5 = 0;
  let teethLost = 0;
  let teethGained = 0;

  for (const fdi of PERIODONTAL_TEETH) {
    const anterior = findPeriodontalTooth(input.previous, fdi);
    const actual = findPeriodontalTooth(input.current, fdi);

    if (anterior === null || actual === null) continue;

    if (!anterior.missing && actual.missing) teethLost += 1;
    if (anterior.missing && !actual.missing) teethGained += 1;

    for (const side of PERIODONTAL_SIDES) {
      for (const index of PERIODONTAL_SITE_INDEXES) {
        const sitioAnterior = anterior.missing
          ? null
          : side === 'vestibular'
            ? anterior.vestibular[index]
            : anterior.lingual[index];
        const sitioActual = actual.missing
          ? null
          : side === 'vestibular'
            ? actual.vestibular[index]
            : actual.lingual[index];

        const previo = sitioAnterior === null ? null : toSiteSnapshot(sitioAnterior);
        const corriente = sitioActual === null ? null : toSiteSnapshot(sitioActual);

        let deltaPd: number | null = null;
        let deltaCal: number | null = null;
        let change: PeriodontalSiteChange;

        if (previo === null && corriente === null) {
          change = 'sin_dato';
        } else if (previo === null) {
          change = 'sin_anterior';
        } else if (corriente === null) {
          change = 'sin_actual';
        } else if (previo.pd === null || corriente.pd === null) {
          change = 'sin_dato';
        } else {
          deltaPd = corriente.pd - previo.pd;
          deltaCal =
            previo.cal === null || corriente.cal === null ? null : corriente.cal - previo.cal;
          const empeora =
            deltaPd >= PERIODONTAL_DELTA_THRESHOLD ||
            (deltaCal ?? 0) >= PERIODONTAL_DELTA_THRESHOLD;
          const mejora =
            deltaPd <= -PERIODONTAL_DELTA_THRESHOLD ||
            (deltaCal ?? 0) <= -PERIODONTAL_DELTA_THRESHOLD;
          change = mejora ? 'mejoro' : empeora ? 'empeoro' : 'estable';
          if (change === 'mejoro') improved += 1;
          else if (change === 'empeoro') worsened += 1;
          else stable += 1;
          pares.push({ deltaPd, deltaCal, change });
        }

        const bolsaAnterior = pocketOf(previo);
        const bolsaActual = pocketOf(corriente);
        const newPocket =
          bolsaActual !== null && bolsaActual >= 5 && (bolsaAnterior === null || bolsaAnterior < 5);
        const resolvedPocket =
          bolsaAnterior !== null && bolsaAnterior >= 5 && (bolsaActual === null || bolsaActual < 5);
        if (newPocket) newPocketsGte5 += 1;
        if (resolvedPocket) resolvedPocketsGte5 += 1;

        sites.push({
          fdi,
          side,
          index,
          previous: previo,
          current: corriente,
          deltaPd,
          deltaCal,
          change,
          newPocket,
          resolvedPocket,
        });
      }
    }
  }

  const deltasPd = pares
    .map((par) => par.deltaPd)
    .filter((value): value is number => value !== null);
  const deltasCal = pares
    .map((par) => par.deltaCal)
    .filter((value): value is number => value !== null);
  const bopAnterior = periodontalMetrics(input.previous).bopPercent;
  const bopActual = periodontalMetrics(input.current).bopPercent;

  return {
    previousExamId: input.previousExamId,
    currentExamId: input.currentExamId,
    summary: {
      sitesCompared: improved + worsened + stable,
      improved,
      worsened,
      stable,
      meanPdDelta: meanOf(deltasPd),
      meanCalDelta: meanOf(deltasCal),
      bopPercentDelta:
        bopAnterior === null || bopActual === null ? null : round1(bopActual - bopAnterior),
      newPocketsGte5,
      resolvedPocketsGte5,
      teethLost,
      teethGained,
    },
    sites,
  };
};

/* ── Entradas de la API ────────────────────────────────────────────────────── */

/** De dónde sale la boca de un examen nuevo. */
export const PERIODONTAL_EXAM_SOURCES = ['odontograma', 'anterior', 'blanco'] as const;
export type PeriodontalExamSource = (typeof PERIODONTAL_EXAM_SOURCES)[number];

/** Estado del examen: borrador editable o finalizado inmutable. */
export const PERIODONTAL_EXAM_STATUSES = ['borrador', 'finalizado'] as const;
export type PeriodontalExamStatus = (typeof PERIODONTAL_EXAM_STATUSES)[number];
export const periodontalExamStatusSchema = z.enum(PERIODONTAL_EXAM_STATUSES);

/** Nombre del estado del examen en la interfaz. */
export const PERIODONTAL_EXAM_STATUS_LABELS: Readonly<Record<PeriodontalExamStatus, string>> = {
  borrador: 'Borrador',
  finalizado: 'Finalizado',
};

/** Cuerpo de `POST .../periodontograms`: abrir un examen nuevo. */
export const createPeriodontalExamSchema = z
  .object({
    /** Fecha clínica del examen; si falta, la pone el servidor (hoy). */
    examDate: z.iso.date().optional(),
    source: z.enum(PERIODONTAL_EXAM_SOURCES).default('odontograma'),
    /** Examen anterior del que se clona la boca (obligatorio con `source: 'anterior'`). */
    previousExamId: z.uuid().nullable().default(null),
    /** Sesión clínica en la que se registra (Fase 7). */
    sessionId: z.uuid().nullable().default(null),
    notes: optionalText(2000),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.source === 'anterior' && value.previousExamId === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['previousExamId'],
        message: 'Para clonar un examen anterior hay que indicar cuál',
      });
    }
    if (value.source !== 'anterior' && value.previousExamId !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['previousExamId'],
        message: 'Solo se clona un examen anterior con source «anterior»',
      });
    }
  });
export type CreatePeriodontalExamInput = z.infer<typeof createPeriodontalExamSchema>;

/**
 * Cuerpo de `PUT .../periodontograms/:examId`: guardar el borrador completo con
 * **revisión optimista**. Si la revisión no es la vigente, el servidor responde 409
 * y la interfaz recarga: nunca se pisan dos ediciones a ciegas.
 */
export const savePeriodontalExamSchema = z
  .object({
    revision: z.number().int().min(0),
    examDate: z.iso.date(),
    chart: periodontalChartSchema,
    riskFactors: periodontalRiskFactorsSchema.default(emptyPeriodontalRiskFactors()),
    diagnosis: periodontalDiagnosisSchema.nullable().default(null),
    notes: optionalText(2000),
  })
  .strict();
export type SavePeriodontalExamInput = z.infer<typeof savePeriodontalExamSchema>;

/** Cuerpo de `POST .../periodontograms/:examId/finalize`: cierre inmutable. */
export const finalizePeriodontalExamSchema = z
  .object({
    revision: z.number().int().min(0),
  })
  .strict();
export type FinalizePeriodontalExamInput = z.infer<typeof finalizePeriodontalExamSchema>;

/** Query del listado de exámenes de un paciente. */
export const periodontalExamListQuerySchema = z
  .object({
    status: periodontalExamStatusSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();
export type PeriodontalExamListQuery = z.infer<typeof periodontalExamListQuerySchema>;

/** Query de la comparación: `?with=<id del examen anterior>`. */
export const comparePeriodontalExamsQuerySchema = z
  .object({
    with: z.uuid(),
  })
  .strict();
export type ComparePeriodontalExamsQuery = z.infer<typeof comparePeriodontalExamsQuerySchema>;

/* ── DTOs de lectura ───────────────────────────────────────────────────────── */

/** Ficha mínima del paciente (la misma que usa el odontograma). */
export type PeriodontalPatientSnapshot = OdontogramPatientSnapshot;

/** Resumen de un examen (listados, comparador y reportes). */
export interface PeriodontalExamSummary {
  id: string;
  patientId: string;
  status: PeriodontalExamStatus;
  /** Fecha clínica del examen (`YYYY-MM-DD`). */
  examDate: string;
  revision: number;
  metrics: PeriodontalMetrics;
  diagnosis: PeriodontalDiagnosis | null;
  createdAt: string;
  updatedAt: string;
  finalizedAt: string | null;
  recordedByUsername: string | null;
  finalizedByUsername: string | null;
  /** Veces que el examen se ha impreso (la impresión es lectura auditada). */
  printCount: number;
  lastPrintedAt: string | null;
  notes: string | null;
}

/** Examen completo: el resumen más la boca y sus factores de riesgo. */
export interface PeriodontalExamDetail extends PeriodontalExamSummary {
  chart: PeriodontalChart;
  riskFactors: PeriodontalRiskFactors;
  /** Versión del esquema de `teeth_data` con la que se guardó. */
  schemaVersion: number;
  sessionId: string | null;
}

/** Lista de exámenes del paciente (del más reciente al más antiguo). */
export interface PeriodontalExamListResult {
  items: PeriodontalExamSummary[];
}

/**
 * Lectura del último examen del paciente. `exists: false` no es un error: el
 * paciente todavía no tiene periodontograma.
 *
 * La ficha del paciente viaja en las dos ramas porque el encabezado del informe
 * (membrete del consultorio) la necesita, y la ruta de impresión no debe depender
 * de un permiso clínico extra para conseguirla.
 */
export type PeriodontalExamLookup =
  | { exists: false; patientId: string; patient: PeriodontalPatientSnapshot | null }
  | {
      exists: true;
      patient: PeriodontalPatientSnapshot | null;
      exam: PeriodontalExamDetail;
      /** Último examen **finalizado** anterior, para ofrecer la comparación. */
      previousFinalized: PeriodontalExamSummary | null;
    };

/** Resultado de crear o guardar un examen. */
export interface PeriodontalExamMutationResult {
  exam: PeriodontalExamDetail;
  /** `true` si el cuerpo no cambiaba nada: no se escribió ni se auditó. */
  unchanged: boolean;
}

/** Resultado de finalizar: el examen inmutable y si ya lo estaba. */
export interface FinalizePeriodontalExamResult {
  exam: PeriodontalExamDetail;
  alreadyFinalized: boolean;
}

/** Resultado de comparar dos exámenes. */
export interface PeriodontalComparisonResult {
  previous: PeriodontalExamSummary;
  current: PeriodontalExamSummary;
  comparison: PeriodontalComparison;
}

/** Resultado de dejar constancia de una impresión. */
export interface PrintPeriodontalExamResult {
  examId: string;
  printCount: number;
  lastPrintedAt: string;
}

/** Resumen interno para el dossier y los reportes (fase posterior). */
export interface PeriodontalInternalSummary {
  patientId: string;
  hasExam: boolean;
  examId: string | null;
  examDate: string | null;
  status: PeriodontalExamStatus | null;
  metrics: PeriodontalMetrics | null;
  diagnosis: PeriodontalDiagnosis | null;
}

/* ── Ayudas de presentación ────────────────────────────────────────────────── */

/** Color del cambio de un sitio en el modo comparación (accesible por forma + tono). */
export const PERIODONTAL_CHANGE_COLORS: Readonly<Record<PeriodontalSiteChange, string>> = {
  mejoro: '#15803d',
  empeoro: '#b91c1c',
  estable: '#475569',
  sin_anterior: '#7c3aed',
  sin_actual: '#a16207',
  sin_dato: '#94a3b8',
};

/** `true` si el examen es editable (solo el borrador lo es). */
export const periodontalExamIsEditable = (status: PeriodontalExamStatus): boolean =>
  status === 'borrador';
