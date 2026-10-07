import { z } from 'zod';

import { cleanText } from './patient.js';

/**
 * Odontograma FDI (Fase 6, sesión B).
 *
 * Se implementa `docs/implementation_plan_odontogram_microservice.md`: nomenclatura
 * FDI de dos dígitos, **captura por excepción** (solo se guardan las anomalías: la
 * pieza sana es la **ausencia de fila**) y un **motor geométrico** de polígonos SVG
 * sin dependencias ni imágenes.
 *
 * Aquí viven tres cosas que comparten servidor e interfaz:
 *  1. el **dominio FDI** (numeración, dentición, cuadrantes, piezas vecinas);
 *  2. la **geometría** de §7 del doc: los cinco polígonos de una pieza en un lienzo
 *     de 100×100, la distribución de cuadrantes y qué cara hay bajo el cursor;
 *  3. la **máquina de teclado** de la carga rápida (tecla de pieza + tecla de
 *     hallazgo), que es lo que permite cargar la boca completa en < 30 s.
 *
 * Reglas clínicas:
 *  - Una cara admite **carles** u **obturación** por estado (`pendiente` = rojo,
 *    `completado` = azul, decisión del doc §7.2).
 *  - El estado de **pieza completa** (ausente, extracción indicada, corona,
 *    implante, endodoncia) **manda sobre las caras**: al registrarlo, las caras se
 *    dan por superadas (ver ADR 0031). El dato no se borra: queda en el histórico.
 */

/* ── Dominio FDI ───────────────────────────────────────────────────────────── */

/**
 * Las denticiones del odontograma.
 *
 * `permanente` y `temporal` describen una boca de una sola dentición. **`mixta`** es
 * la del paciente que está mudando: conviven piezas permanentes y temporales (los
 * incisivos y molares permanentes ya salieron y quedan molares de leche). No es una
 * dentición de una pieza —eso lo dice `dentitionOfTooth`— sino un **estado del
 * odontograma**, que se deriva de los hallazgos vigentes (ver
 * [ADR 0051](../../../../docs/adr/0051-denticion-mixta-en-el-odontograma.md)).
 *
 * La dentición de una **pieza** sigue deduciéndose de su número FDI: el 1.º dígito del
 * 11–48 es el cuadrante permanente y el del 51–85 el temporal, así que no pueden
 * contradecirse.
 */
export const DENTITIONS = ['permanente', 'temporal', 'mixta'] as const;
export type Dentition = (typeof DENTITIONS)[number];

export const dentitionSchema = z.enum(DENTITIONS);

/** Caras anatómicas de una pieza. */
export const TOOTH_SURFACES = ['vestibular', 'lingual', 'occlusal', 'mesial', 'distal'] as const;
export type ToothSurface = (typeof TOOTH_SURFACES)[number];
export const toothSurfaceSchema = z.enum(TOOTH_SURFACES);

/** Condiciones que se registran **por cara**. */
export const SURFACE_CONDITIONS = ['caries', 'restauracion'] as const;
export type SurfaceCondition = (typeof SURFACE_CONDITIONS)[number];
export const surfaceConditionSchema = z.enum(SURFACE_CONDITIONS);

/**
 * Condiciones que se registran **por pieza completa** (`surface: null`).
 *
 * ⚠️ «Por pieza completa» describe **cómo se guarda la fila**, no que la condición
 * invalide las caras: eso lo decide `WHOLE_TOOTH_RULES` (ver ADR 0032).
 */
export const WHOLE_TOOTH_CONDITIONS = [
  'ausente',
  'extraccion_indicada',
  'corona',
  'implante',
  'endodoncia',
] as const;
export type WholeToothCondition = (typeof WHOLE_TOOTH_CONDITIONS)[number];
export const wholeToothConditionSchema = z.enum(WHOLE_TOOTH_CONDITIONS);

/**
 * Regla de convivencia de cada condición de pieza completa ([ADR 0032](../../../../docs/adr/0032-convivencia-de-tratamientos-con-las-caras.md)).
 *
 * El odontograma se guarda por excepción y una pieza puede tener **varias** filas:
 * caries y obturación por cara, y los marcadores de tratamiento de la pieza
 * completa. La pregunta es cuáles pueden convivir, y la respuesta no es la misma
 * para todas:
 *
 * - `ausente` **supera** las caras que hubiera (se quedan marcadas como superadas, no
 *   se borran) **y las excluye**: no convive con un diente ni con su plan, así que no
 *   puede llevar corona, conducto ni extracción indicada.
 * - La **corona** también las supera, pero **no las excluye**: recubre el muñón y lo
 *   que hubiera debajo ya no se ve en boca (el dato se conserva superado), y una
 *   caries que aparezca **después** —la recurrente, en el margen— se registra encima
 *   y se ve en el dibujo.
 * - `endodoncia`, `implante` y el **plan** (`extraccion_indicada`) **conviven con las
 *   caras**: un conducto con su restauración encima, o una caries en un diente con la
 *   extracción indicada, son la boca normal, no una contradicción. Antes se trataban
 *   como `ausente` y eso impedía registrar la realidad.
 * - Entre ellos solo se bloquean las parejas **imposibles**: un implante no tiene
 *   raíz que endodonciar (`implante` × `endodoncia`) y nada convive con `ausente`
 *   **salvo el implante**: la corona natural puede no estar y el implante sostenerla,
 *   que es la fase quirúrgica real (ver la ampliación al final del ADR 0032).
 *   `implante` + `corona` (corona sobre implante) y `corona` + `endodoncia` (conducto
 *   y corona) también se admiten.
 */
export interface WholeToothRule {
  /**
   * Si al registrarla hay que **superar** las caras vigentes de esa pieza: quedan con
   * `resolved_at` y su entrada en el histórico, no se borran. El gráfico deja de
   * pintarlas porque en boca ya no se ven.
   */
  supersedesSurfaces: boolean;
  /**
   * Si la condición **excluye** las caras: no caben juntas de ninguna manera, ni antes
   * ni después. Es lo que hace `ausente` (una pieza que no está no tiene caries) y lo
   * que **no** hace `corona`: la corona tapa lo que había debajo, pero una **caries
   * recurrente** sobre la corona se registra después y se ve.
   *
   * Sin esta distinción, superar y excluir serían lo mismo y la filtración marginal
   * sobre una corona no se podría anotar.
   */
  excludesSurfaces: boolean;
  /** Condiciones de pieza completa con las que **no** puede convivir. */
  incompatibleWith: readonly WholeToothCondition[];
}

export const WHOLE_TOOTH_RULES: Readonly<Record<WholeToothCondition, WholeToothRule>> = {
  /**
   * La corona natural no está. Manda sobre las caras (no hay tejido que tratar) y no
   * convive con un diente que ya no está… **salvo con el implante**: el implante es el
   * soporte que ocupa su lugar. Son las dos fases reales del tratamiento:
   * quirúrgica (`ausente` + `implante`) y rehabilitada (`corona` + `implante`).
   */
  ausente: {
    supersedesSurfaces: true,
    excludesSurfaces: true,
    incompatibleWith: ['extraccion_indicada', 'corona', 'endodoncia'],
  },
  // Plan de tratamiento: describe lo que se va a hacer con una pieza que sigue ahí
  // (y que puede tener caries mientras tanto).
  extraccion_indicada: {
    supersedesSurfaces: false,
    excludesSurfaces: false,
    incompatibleWith: ['ausente'],
  },
  /**
   * La corona protésica **recubre el muñón en sus 360°**: en boca ya no se ve si
   * debajo había amalgama o resina, así que el gráfico no las enseña (si no, el
   * círculo de la corona sobre trapecios pintados se lee como «caries dentro de la
   * corona»). El dato **no se pierde**: las caras quedan superadas con `resolved_at`
   * y su entrada en el histórico, que es lo que sostiene la historia clínica.
   *
   * No las excluye: la **caries recurrente** que aparezca después se registra sobre la
   * corona y se ve, porque la superación solo mira lo que había cuando se puso.
   */
  corona: {
    supersedesSurfaces: true,
    excludesSurfaces: false,
    incompatibleWith: ['ausente'],
  },
  // El implante sustituye la raíz: convive con la corona ausente (fase quirúrgica) y
  // con la corona protésica (fase rehabilitada). Lo que no tiene es conducto.
  implante: {
    supersedesSurfaces: false,
    excludesSurfaces: false,
    incompatibleWith: ['endodoncia'],
  },
  endodoncia: {
    supersedesSurfaces: false,
    excludesSurfaces: false,
    incompatibleWith: ['ausente', 'implante'],
  },
};

/** `true` si la condición, al registrarse, deja superadas las caras de la pieza. */
export const supersedesSurfaces = (condition: ToothCondition): boolean =>
  isWholeToothCondition(condition) && WHOLE_TOOTH_RULES[condition].supersedesSurfaces;

/** `true` si la condición **excluye** las caras: no caben juntas, ni antes ni después. */
export const excludesSurfaces = (condition: ToothCondition): boolean =>
  isWholeToothCondition(condition) && WHOLE_TOOTH_RULES[condition].excludesSurfaces;

/**
 * `true` si las dos condiciones **no pueden estar a la vez** en la misma pieza.
 * Es una pregunta simétrica («¿caben juntas?») y la usa la validación de un lote,
 * donde no hay orden de aplicación.
 *
 * ⚠️ Para decidir si **se puede registrar** algo no sirve esta: ahí el orden
 * importa. Usa `recordingConflicts`.
 */
export const conditionsConflict = (a: ToothCondition, b: ToothCondition): boolean => {
  if (a === b) return false;

  const aEntera = isWholeToothCondition(a);
  const bEntera = isWholeToothCondition(b);
  // Dos condiciones de cara comparten ranura sin chocar (`caries` + `restauracion`
  // en el mismo diente es la boca normal).
  if (!aEntera && !bEntera) return false;

  // Cara × pieza completa: no caben juntas **si la condición excluye las caras**
  // (hoy, únicamente `ausente`). Ojo: **superarlas no es excluirlas** — la corona tapa
  // lo que había debajo, pero una caries recurrente sobre la corona es una boca real
  // y tiene que poder registrarse.
  if (aEntera !== bEntera) {
    const entera: WholeToothCondition = aEntera
      ? (a as WholeToothCondition)
      : (b as WholeToothCondition);
    return WHOLE_TOOTH_RULES[entera].excludesSurfaces;
  }

  // Dos condiciones de pieza completa: solo las parejas imposibles.
  const primera = a as WholeToothCondition;
  const segunda = b as WholeToothCondition;
  return (
    WHOLE_TOOTH_RULES[primera].incompatibleWith.includes(segunda) ||
    WHOLE_TOOTH_RULES[segunda].incompatibleWith.includes(primera)
  );
};

/**
 * `true` si registrar `next` **choca** con `existing`. A diferencia de
 * `conditionsConflict`, tiene dirección, y es la que decide de verdad:
 *
 * - `existing` = `ausente`, `next` = caries → **choca** (la pieza no está).
 * - `existing` = caries, `next` = `ausente` → **no choca**: `ausente` supera las
 *   caras, que es justo lo que hay que dejar hacer.
 * - `existing` = caries, `next` = `corona` → no choca: conviven (ADR 0032).
 * - Dos condiciones de pieza completa: choca solo en las parejas imposibles.
 */
export const recordingConflicts = (existing: ToothCondition, next: ToothCondition): boolean => {
  if (existing === next) return false;

  const nextEntera = isWholeToothCondition(next);
  const existingEntera = isWholeToothCondition(existing);

  if (!nextEntera && !existingEntera) return false;
  // Una condición de pieza completa se registra sobre las caras que haya: o las
  // supera (`ausente`) o convive con ellas (los tratamientos). Nunca choca con ellas.
  if (nextEntera && !existingEntera) return false;
  // Al revés solo choca si la condición vigente **excluye** las caras (una caries no
  // se registra sobre una pieza ausente). Sobre una corona sí: es la recurrente.
  if (!nextEntera && existingEntera) {
    return WHOLE_TOOTH_RULES[existing as WholeToothCondition].excludesSurfaces;
  }

  const siguiente = next as WholeToothCondition;
  const vigente = existing as WholeToothCondition;
  return (
    WHOLE_TOOTH_RULES[siguiente].incompatibleWith.includes(vigente) ||
    WHOLE_TOOTH_RULES[vigente].incompatibleWith.includes(siguiente)
  );
};

/** Todas las condiciones que puede tener una pieza. */
export const TOOTH_CONDITIONS = [...SURFACE_CONDITIONS, ...WHOLE_TOOTH_CONDITIONS] as const;
export type ToothCondition = (typeof TOOTH_CONDITIONS)[number];
export const toothConditionSchema = z.enum(TOOTH_CONDITIONS);

/** Estado clínico: `pendiente` (rojo, por hacer) o `completado` (azul, hecho). */
export const CLINICAL_STATES = ['pendiente', 'completado'] as const;
export type ClinicalState = (typeof CLINICAL_STATES)[number];
export const clinicalStateSchema = z.enum(CLINICAL_STATES);

/** Color del estado clínico (doc §7.2): rojo pendiente, azul completado. */
export const CLINICAL_STATE_COLORS: Readonly<Record<ClinicalState, string>> = {
  pendiente: '#ef4444',
  completado: '#3b82f6',
};

/** Nombre de la cara en la interfaz (etiquetas del componente SVG). */
export const SURFACE_LABELS: Readonly<Record<ToothSurface, string>> = {
  vestibular: 'Vestibular',
  lingual: 'Lingual',
  occlusal: 'Oclusal',
  mesial: 'Mesial',
  distal: 'Distal',
};

/**
 * Nombre de la **cara de masticación** en los dientes anteriores: del canino al
 * incisivo central no hay cara oclusal ancha, hay **borde incisal**.
 *
 * Se guarda igual que `occlusal` —el polígono es el mismo cuadrado central y no hay
 * dato nuevo— pero se **nombra** distinto, que es lo que el odontólogo lee y escribe
 * en la historia: una caries en el borde del 33 no se llama «oclusal».
 */
export const INCISAL_LABEL = 'Incisal';

/** Última posición del cuadrante que es diente anterior (canino). */
export const ANTERIOR_TOOTH_LAST_POSITION = 3;

/**
 * Etiqueta clínica de una cara **en una pieza concreta**: `Oclusal` en premolares y
 * molares, `Incisal` en incisivos y caninos (posiciones 1–3 del cuadrante).
 */
export const surfaceLabelFor = (toothNumber: number, surface: ToothSurface): string =>
  surface === 'occlusal' && positionOfTooth(toothNumber) <= ANTERIOR_TOOTH_LAST_POSITION
    ? INCISAL_LABEL
    : SURFACE_LABELS[surface];

/** Nombre de la condición en la interfaz (leyenda, cargas rápidas y avisos). */
export const CONDITION_LABELS: Readonly<Record<ToothCondition, string>> = {
  caries: 'Caries',
  restauracion: 'Obturación',
  ausente: 'Ausente',
  extraccion_indicada: 'Extracción indicada',
  corona: 'Corona',
  implante: 'Implante',
  endodoncia: 'Endodoncia',
};

/** Nombre del estado clínico en la interfaz. */
export const CLINICAL_STATE_LABELS: Readonly<Record<ClinicalState, string>> = {
  pendiente: 'Pendiente',
  completado: 'Completado',
};

/** Cuadrante FDI: 1 y 2 superiores (derecha e izquierda del paciente), 4 y 3 inferiores. */
export const FDI_QUADRANTS = [1, 2, 3, 4, 5, 6, 7, 8] as const;
export type FdiQuadrant = (typeof FDI_QUADRANTS)[number];

/** Posición dentro del cuadrante: 1 incisivo central … 8 tercer molar. */
export type FdiPosition = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

/** Tipo de pieza: cuatro grupos clínicos + los molares. */
export const TOOTH_KINDS = [
  'incisivo_central',
  'incisivo_lateral',
  'canino',
  'primer_premolar',
  'segundo_premolar',
  'primer_molar',
  'segundo_molar',
  'tercer_molar',
] as const;
export type ToothKind = (typeof TOOTH_KINDS)[number];

/** Piezas permanentes (32) y temporales (20), en orden de cuadrante y posición. */
export const PERMANENT_TOOTH_NUMBERS: readonly number[] = FDI_QUADRANTS.filter(
  (quadrant) => quadrant <= 4,
).flatMap((quadrant) =>
  ([1, 2, 3, 4, 5, 6, 7, 8] as const).map((position) => quadrant * 10 + position),
);

export const PRIMARY_TOOTH_NUMBERS: readonly number[] = FDI_QUADRANTS.filter(
  (quadrant) => quadrant >= 5,
).flatMap((quadrant) => ([1, 2, 3, 4, 5] as const).map((position) => quadrant * 10 + position));

export const TOOTH_NUMBERS: readonly number[] = [
  ...PERMANENT_TOOTH_NUMBERS,
  ...PRIMARY_TOOTH_NUMBERS,
];

const TOOTH_NUMBER_SET: ReadonlySet<number> = new Set(TOOTH_NUMBERS);

/** `true` si el número es una pieza FDI válida (permanente 11–48 o temporal 51–85). */
export const isToothNumber = (value: number): boolean => TOOTH_NUMBER_SET.has(value);

/** `true` si el número es una pieza temporal (cuadrantes 5–8). */
export const isPrimaryTooth = (value: number): boolean =>
  isToothNumber(value) && value >= 51 && value <= 85;

/** Dentición a la que pertenece una pieza válida. */
export const dentitionOfTooth = (toothNumber: number): Dentition =>
  isPrimaryTooth(toothNumber) ? 'temporal' : 'permanente';

/**
 * La pieza **permanente que sustituye** a una temporal (mismo cuadrante menos 4 y
 * misma posición): `51 → 11`, `54 → 14`, `55 → 15`, `85 → 45`.
 *
 * Es la anatomía del recambio —el primer molar temporal cae donde entra el primer
 * premolar— y por eso la dentición mixta coloca cada pieza temporal **en la ranura de
 * su sucesor**: así la arcada se lee como la transición que es (ADR 0051). Las piezas
 * permanentes 6–8 no tienen predecesor temporal.
 *
 * Solo tiene sentido con una pieza temporal: con una permanente devuelve una pieza
 * inexistente, así que conviene comprobar `isPrimaryTooth` antes.
 */
export const primarySuccessor = (toothNumber: number): number =>
  (quadrantOfTooth(toothNumber) - 4) * 10 + positionOfTooth(toothNumber);

/** Cuadrante FDI de una pieza (1–8). */
export const quadrantOfTooth = (toothNumber: number): FdiQuadrant =>
  Math.floor(toothNumber / 10) as FdiQuadrant;

/** Posición dentro del cuadrante (1–8). */
export const positionOfTooth = (toothNumber: number): FdiPosition =>
  (toothNumber % 10) as FdiPosition;

/** Cuadrante de la **derecha del paciente** (1 y 4) o de la izquierda (2 y 3). */
export const isPatientRightQuadrant = (quadrant: FdiQuadrant): boolean =>
  quadrant === 1 || quadrant === 4 || quadrant === 5 || quadrant === 8;

/** `true` si la arcada es la superior (cuadrantes 1, 2, 5 y 6). */
export const isUpperTooth = (toothNumber: number): boolean => {
  const quadrant = quadrantOfTooth(toothNumber);
  return quadrant === 1 || quadrant === 2 || quadrant === 5 || quadrant === 6;
};

/** Tipo de pieza según su posición en el cuadrante. */
export const toothKind = (toothNumber: number): ToothKind =>
  TOOTH_KINDS[positionOfTooth(toothNumber) - 1]!;

/** Máscara de caras que tiene una pieza: los molares no tienen cara oclusal simple,
 *  pero sí premolares y molares; los incisivos y caninos tienen borde incisal, que
 *  se registra en `occlusal` (la cara de masticación, sea borde o cara oclusal). */
export const TOOTH_SURFACES_BY_KIND: Readonly<Record<ToothKind, readonly ToothSurface[]>> = {
  incisivo_central: ['vestibular', 'lingual', 'occlusal', 'mesial', 'distal'],
  incisivo_lateral: ['vestibular', 'lingual', 'occlusal', 'mesial', 'distal'],
  canino: ['vestibular', 'lingual', 'occlusal', 'mesial', 'distal'],
  primer_premolar: ['vestibular', 'lingual', 'occlusal', 'mesial', 'distal'],
  segundo_premolar: ['vestibular', 'lingual', 'occlusal', 'mesial', 'distal'],
  primer_molar: ['vestibular', 'lingual', 'occlusal', 'mesial', 'distal'],
  segundo_molar: ['vestibular', 'lingual', 'occlusal', 'mesial', 'distal'],
  tercer_molar: ['vestibular', 'lingual', 'occlusal', 'mesial', 'distal'],
};

/**
 * Pieza vecina hacia mesial (acercándose a la línea media) y hacia distal. Devuelve
 * `null` al salir del cuadrante: el salto de cuadrante lo decide quien navega, para
 * no inventar vecinos que la arcada de esta dentición no tiene.
 */
export const neighborTooth = (
  toothNumber: number,
  direction: 'mesial' | 'distal',
): number | null => {
  const position = positionOfTooth(toothNumber);
  const next = direction === 'mesial' ? position - 1 : position + 1;
  if (next < 1) return null;
  const limite = isPrimaryTooth(toothNumber) ? 5 : 8;
  if (next > limite) return null;
  return quadrantOfTooth(toothNumber) * 10 + next;
};

/* ── Esquemas de entrada ───────────────────────────────────────────────────── */

export const toothNumberSchema = z
  .number()
  .int()
  .refine(isToothNumber, { message: 'Número de pieza FDI inválido (11–48 o 51–85)' });

/** Una cara admite o no la condición: `caries` y `restauracion` comparten ranura. */
export const isSurfaceCondition = (condition: ToothCondition): condition is SurfaceCondition =>
  (SURFACE_CONDITIONS as readonly string[]).includes(condition);

export const isWholeToothCondition = (
  condition: ToothCondition,
): condition is WholeToothCondition =>
  (WHOLE_TOOTH_CONDITIONS as readonly string[]).includes(condition);

/** Cuerpo de `PUT`/`DELETE .../findings`: una cara o una pieza completa. */
export const recordFindingSchema = z
  .object({
    toothNumber: toothNumberSchema,
    /** `null` = el hallazgo afecta a la pieza completa. */
    surface: toothSurfaceSchema.nullable().default(null),
    condition: toothConditionSchema,
    state: clinicalStateSchema.default('pendiente'),
    notes: z
      .string()
      .max(500)
      .transform(cleanText)
      .transform((value) => (value === '' ? null : value))
      .nullable()
      .default(null),
    /**
     * Sesión clínica en la que se registra (Fase 7). Opcional: el odontograma se
     * puede cargar sin sesión abierta.
     */
    sessionId: z.uuid().nullable().default(null),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.surface !== null && !isSurfaceCondition(value.condition)) {
      ctx.addIssue({
        code: 'custom',
        path: ['condition'],
        message: `La condición «${value.condition}» afecta a la pieza completa: surface debe ser null`,
      });
    }
    if (value.surface === null && isSurfaceCondition(value.condition)) {
      ctx.addIssue({
        code: 'custom',
        path: ['surface'],
        message: `La condición «${value.condition}» se registra por cara: indica la cara`,
      });
    }
  });

export type RecordFindingInput = z.infer<typeof recordFindingSchema>;

/* ── Selección: el mismo gesto para el teclado, el ratón y el dedo ─────────── */

/**
 * Lo que hay marcado en la interfaz antes de guardar: una pieza, las caras
 * elegidas, la condición y el estado. Es el modelo que comparten los tres modos de
 * entrada (teclado, ratón y pantalla táctil), para que ninguno tenga reglas
 * propias: la barra de teclado de la carga rápida y la hoja táctil de la pieza
 * producen la **misma** selección y el mismo resultado.
 */
export interface FindingSelection {
  toothNumber: number;
  /** Caras marcadas. Vacío con una condición de cara = se aplica a la oclusal. */
  surfaces: readonly ToothSurface[];
  condition: ToothCondition;
  state: ClinicalState;
  notes?: string | null;
  sessionId?: string | null;
}

/**
 * `true` si la selección se puede aplicar a una pieza que ya tiene esos
 * hallazgos: el número tiene que existir en FDI y ninguna condición puede chocar
 * con las vigentes (ADR 0032). Es lo que consulta la interfaz para desactivar un
 * botón con su motivo, y el servidor lo vuelve a comprobar por su cuenta.
 *
 * Ojo: una condición de pieza completa **ignora** las caras marcadas (ver
 * `findingsFromSelection`); no es un error tenerlas seleccionadas de antes.
 */
export const selectionIsApplicable = (
  selection: FindingSelection,
  existing: readonly { condition: ToothCondition }[] = [],
): boolean =>
  isToothNumber(selection.toothNumber) &&
  conflictingCondition(existing, selection.condition) === null;

/**
 * Hallazgos que produce una selección: **uno por cara marcada**, o uno solo de
 * pieza completa.
 *
 * Antes la carga rápida guardaba solo la primera cara marcada; con esto, marcar
 * tres caras y pulsar «caries» deja tres caries —que es lo que espera cualquiera
 * que las haya marcado, con teclado o con el dedo— y en una sola transacción
 * (`POST .../findings/batch`).
 */
export const findingsFromSelection = (selection: FindingSelection): RecordFindingInput[] => {
  const comun = {
    condition: selection.condition,
    state: selection.state,
    notes: selection.notes ?? null,
    sessionId: selection.sessionId ?? null,
  };

  if (isWholeToothCondition(selection.condition)) {
    return [{ toothNumber: selection.toothNumber, surface: null, ...comun }];
  }

  const caras = selection.surfaces.length > 0 ? selection.surfaces : (['occlusal'] as const);
  return caras.map((surface) => ({ toothNumber: selection.toothNumber, surface, ...comun }));
};

/**
 * Condición vigente de la pieza con la que **choca** la que se va a registrar, o
 * `null` si se puede registrar. La interfaz la usa para desactivar el botón y
 * explicarlo antes de llamar al servidor; el servidor vuelve a comprobarlo (no se
 * fía). Es direccional: registrar `ausente` sobre una caries **sí** se puede.
 */
export const conflictingCondition = (
  existing: readonly { condition: ToothCondition }[],
  next: ToothCondition,
): ToothCondition | null =>
  existing.find((finding) => recordingConflicts(finding.condition, next))?.condition ?? null;

/** Borrado por la clave natural: pieza + cara + condición (`null` = pieza completa). */
export const deleteFindingSchema = z
  .object({
    toothNumber: toothNumberSchema,
    surface: toothSurfaceSchema.nullable().default(null),
    condition: toothConditionSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.surface !== null && !isSurfaceCondition(value.condition)) {
      ctx.addIssue({
        code: 'custom',
        path: ['condition'],
        message: `La condición «${value.condition}» afecta a la pieza completa: surface debe ser null`,
      });
    }
    if (value.surface === null && isSurfaceCondition(value.condition)) {
      ctx.addIssue({
        code: 'custom',
        path: ['surface'],
        message: `La condición «${value.condition}» se registra por cara: indica la cara`,
      });
    }
  });

export type DeleteFindingInput = z.infer<typeof deleteFindingSchema>;

/**
 * Deja una **cara sana**: en el patrón por excepción la pieza sana es la ausencia
 * de fila, así que borrar el hallazgo es la forma de corregir un error de captura.
 * A diferencia del borrado por clave natural, aquí no hace falta decir qué
 * condición había: se limpia la cara entera.
 */
export const clearSurfaceSchema = z
  .object({
    toothNumber: toothNumberSchema,
    surface: toothSurfaceSchema,
  })
  .strict();

export type ClearSurfaceInput = z.infer<typeof clearSurfaceSchema>;

/**
 * Carga rápida: varios hallazgos en una sola petición transaccional. La interfaz
 * la usa al pegar una lista o al confirmar varios cambios seguidos del teclado.
 */
export const recordFindingsBatchSchema = z
  .object({
    findings: z.array(recordFindingSchema).min(1).max(200),
  })
  .strict();

export type RecordFindingsBatchInput = z.infer<typeof recordFindingsBatchSchema>;

/* ── Modelo persistido y DTOs ──────────────────────────────────────────────── */

/** Hallazgo tal como se guarda y se pinta: la fila del odontograma. */
export interface ToothFindingRecord {
  id: string;
  toothNumber: number;
  /** `null` = pieza completa. */
  surface: ToothSurface | null;
  condition: ToothCondition;
  state: ClinicalState;
  notes: string | null;
  recordedByUsername: string | null;
  recordedAt: string;
  updatedAt: string;
  /** Sesión clínica en la que se registró (Fase 7). */
  sessionId: string | null;
  /** Cuándo se dio por superado (por una condición de pieza completa). */
  resolvedAt: string | null;
}

/** Entrada del histórico append-only: alimenta la auditoría y la vista de evolución. */
export interface ToothFindingHistoryEntry {
  id: string;
  toothNumber: number;
  surface: ToothSurface | null;
  condition: ToothCondition;
  state: ClinicalState;
  /** `registrado` | `actualizado` | `eliminado` | `superado`. */
  event: ToothFindingHistoryEvent;
  reason: string | null;
  notes: string | null;
  actorUsername: string | null;
  occurredAt: string;
}

export const TOOTH_FINDING_HISTORY_EVENTS = [
  'registrado',
  'actualizado',
  'eliminado',
  'superado',
] as const;
export type ToothFindingHistoryEvent = (typeof TOOTH_FINDING_HISTORY_EVENTS)[number];

/** Ficha mínima del paciente para encabezar el odontograma (igual que en la historia). */
export interface OdontogramPatientSnapshot {
  id: string;
  fullName: string;
  document: string;
  birthDate: string;
  age: number;
  sex: string;
  phone: string | null;
  address: string | null;
  occupation: string | null;
}

/**
 * Estado del odontograma de un paciente. `findings` va indexado por pieza
 * (`"16"`) para que la lectura sea O(1) en la interfaz.
 */
export interface OdontogramDetail {
  id: string;
  patientId: string;
  /** Dentición de la boca: se deduce del FDI al registrar el primer hallazgo. */
  dentition: Dentition;
  findings: Record<string, ToothFindingRecord[]>;
  /** Piezas con al menos un hallazgo (lo que **no** está aquí está sano). */
  affectedTeeth: number[];
  /** `true` si la boca todavía no tiene ningún hallazgo registrado. */
  empty: boolean;
  recordedByUsername: string | null;
  recordedAt: string;
  updatedAt: string;
  lastPrintedAt: string | null;
  printCount: number;
  patient: OdontogramPatientSnapshot | null;
}

/** Resultado de la lectura por paciente: `exists: false` cuando no hay odontograma. */
export type OdontogramLookup =
  | { exists: false; patientId: string; patient: OdontogramPatientSnapshot | null }
  | { exists: true; odontogram: OdontogramDetail };

/** Resultado de crear/leer el odontograma desde una sesión de escritura. */
export interface OdontogramOpenResult {
  created: boolean;
  odontogram: OdontogramDetail;
}

/** Resultado de un cambio: el odontograma completo y qué se tocó. */
export interface OdontogramMutationResult {
  odontogram: OdontogramDetail;
  /** `true` si el cuerpo no cambiaba nada y no se escribió ni se auditó. */
  unchanged: boolean;
  /** Caras que se dieron por superadas al registrar una pieza completa. */
  resolvedSurfaces: ToothSurface[];
}

export interface OdontogramHistoryResult {
  odontogramId: string;
  patientId: string;
  entries: ToothFindingHistoryEntry[];
}

export interface PrintOdontogramResult {
  id: string;
  printCount: number;
  lastPrintedAt: string;
}

/** Cuántas piezas hay de cada condición (lo usa la leyenda y la vista impresa). */
export interface OdontogramSummary {
  teeth: number;
  permanentTeeth: number;
  primaryTeeth: number;
  affectedTeeth: number;
  conditionCounts: Partial<Record<ToothCondition, number>>;
  pendingCount: number;
  completedCount: number;
}

/* ── Resumen agregado (lectura clínica y futuros reportes) ──────────────────── */

/** Cuenta piezas por condición y estado a partir de los hallazgos vigentes. */
export const odontogramSummary = (detail: {
  findings: Record<string, readonly ToothFindingRecord[]>;
  dentition: Dentition;
}): OdontogramSummary => {
  const teeth = new Set<number>();
  const conditionCounts: Partial<Record<ToothCondition, number>> = {};
  let pendingCount = 0;
  let completedCount = 0;

  for (const list of Object.values(detail.findings)) {
    for (const finding of list) {
      teeth.add(finding.toothNumber);
      conditionCounts[finding.condition] = (conditionCounts[finding.condition] ?? 0) + 1;
      if (finding.state === 'pendiente') pendingCount += 1;
      else completedCount += 1;
    }
  }

  return {
    // Las piezas que la arcada **dibuja**: 32 en permanente, 20 en temporal y las dos
    // cosas en la mixta (la huella permanente más las temporales que quedan).
    teeth:
      detail.dentition === 'temporal'
        ? PRIMARY_TOOTH_NUMBERS.length
        : detail.dentition === 'mixta'
          ? PERMANENT_TOOTH_NUMBERS.length + PRIMARY_TOOTH_NUMBERS.length
          : PERMANENT_TOOTH_NUMBERS.length,
    permanentTeeth: detail.dentition === 'temporal' ? 0 : PERMANENT_TOOTH_NUMBERS.length,
    primaryTeeth: detail.dentition === 'permanente' ? 0 : PRIMARY_TOOTH_NUMBERS.length,
    affectedTeeth: teeth.size,
    conditionCounts,
    pendingCount,
    completedCount,
  };
};

/* ── Geometría SVG (doc §7) ────────────────────────────────────────────────── */

/**
 * Lienzo de una pieza: 100×100. Cada cara es un **polígono puro** con coordenadas
 * fijas —sin fuentes ni imágenes— porque de ahí sale también qué cara se pulsó.
 * Las coordenadas están escritas en el orden de una pieza **superior** (vestibular
 * arriba, cara oclusal en el centro, lingual abajo).
 */
export const SURFACE_POLYGONS: Readonly<Record<ToothSurface, string>> = {
  vestibular: '0,0 100,0 75,25 25,25',
  distal: '100,0 100,100 75,75 75,25',
  lingual: '100,100 0,100 25,75 75,75',
  mesial: '0,100 0,0 25,25 25,75',
  occlusal: '25,25 75,25 75,75 25,75',
};

/** Contorno de la pieza (unión de las cinco caras). */
export const TOOTH_OUTLINE_POINTS = '0,0 100,0 100,100 0,100';

/** Orden de pintado y de lectura: de la cara externa hacia el centro. */
export const SURFACE_DRAW_ORDER: readonly ToothSurface[] = [
  'vestibular',
  'distal',
  'lingual',
  'mesial',
  'occlusal',
];

/** Orden de las caras en la ficha de una pieza (formulario y accesos rápidos). */
export const SURFACE_FORM_ORDER: readonly ToothSurface[] = [
  'vestibular',
  'lingual',
  'occlusal',
  'mesial',
  'distal',
];

/** Laterales de la cara en una pieza superior; la mandíbula los intercambia. */
export const SURFACE_ORDER_MAXILLARY: readonly ToothSurface[] = [
  ...SURFACE_DRAW_ORDER,
  'vestibular',
];

export interface Point {
  x: number;
  y: number;
}

/** Lee una lista de puntos SVG (`"0,0 100,0 ..."`). */
export const parsePolygonPoints = (points: string): Point[] =>
  points
    .trim()
    .split(/\s+/)
    .map((pair) => {
      const [x, y] = pair.split(',').map(Number);
      return { x: x ?? 0, y: y ?? 0 };
    });

/**
 * Cara que hay bajo un punto del lienzo de 100×100, o `null` si el punto cae
 * fuera (lo que permite distinguir «pulsó la pieza» de «pulsó el hueco»).
 *
 * El acierto se resuelve por **área**: el reparto de polígonos es exacto (los
 * cuatro trapecios suman 10.000 y la oclusal 2.500, sin solaparse), así que basta
 * con elegir la cara cuyo polígono contiene al punto, prefiriendo la oclusal
 * —la más interior— cuando dos la contienen. Gana el polígono **menor**, que es
 * el criterio estable para un reparto que puede afinarse.
 */
export const surfaceAtPoint = (x: number, y: number): ToothSurface | null => {
  if (x < 0 || x > 100 || y < 0 || y > 100) return null;

  const contiene = (points: string): boolean => {
    const vertices = parsePolygonPoints(points);
    let dentro = false;
    for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
      const actual = vertices[i]!;
      const anterior = vertices[j]!;
      const cruza =
        actual.y > y !== anterior.y > y &&
        x < ((anterior.x - actual.x) * (y - actual.y)) / (anterior.y - actual.y) + actual.x;
      if (cruza) dentro = !dentro;
    }
    return dentro;
  };

  const area = (points: string): number => {
    const vertices = parsePolygonPoints(points);
    let suma = 0;
    for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
      suma += vertices[j]!.x * vertices[i]!.y - vertices[i]!.x * vertices[j]!.y;
    }
    return Math.abs(suma / 2);
  };

  const candidatas = SURFACE_DRAW_ORDER.filter((surface) =>
    contiene(SURFACE_POLYGONS[surface]),
  ).sort((a, b) => area(SURFACE_POLYGONS[a]) - area(SURFACE_POLYGONS[b]));

  return candidatas[0] ?? null;
};

/** Un diente colocado en la arcada: la interfaz solo tiene que pintarlo. */
export interface ToothPlacement {
  toothNumber: number;
  quadrant: FdiQuadrant;
  position: FdiPosition;
  kind: ToothKind;
  /** `true` si va en la arcada superior. */
  upper: boolean;
  /** Coordenada X del lienzo de 100×100 de esta pieza. */
  x: number;
  /**
   * `true` si hay que **voltear** el lienzo en vertical: en la mandíbula la cara
   * vestibular mira hacia abajo, así que la pieza se dibuja con `scale(1,-1)`.
   */
  flipped: boolean;
  /**
   * `true` si hay que **espejar** la pieza en horizontal.
   *
   * La arcada se dibuja como dos filas con la línea media en el centro, así que las
   * piezas de la **derecha del paciente** (cuadrantes 1 y 4, y 5 y 8 temporales)
   * tienen su cara **mesial mirando a la derecha de la pantalla**, hacia la línea
   * media. Sin espejar, la cara que el dibujo llama «mesial» en el 16 sería la que
   * está junto al 17: el vecino equivocado — y el odontólogo registra la caries en la
   * cara que no es.
   */
  mirrorX: boolean;
  surfaces: readonly ToothSurface[];
}

/** Ancho de la ranura de cada pieza, en unidades del lienzo (100 de pieza + hueco). */
export const TOOTH_STRIDE = 112;

/**
 * Transformación SVG del lienzo de una pieza según su arcada y su cuadrante.
 *
 * Vive en el contrato —y no en cada componente— porque la usan **los dos**
 * renderizadores (el gráfico de pantalla y el documento de impresión) y **la
 * conversión del clic**: si el dibujo y el `hit-test` no aplican exactamente la
 * misma transformación, se registra la cara contraria a la que se ve.
 *
 * - `flipped` (mandíbula): `scale(1,-1) translate(0,-100)` — volta la pieza en
 *   vertical, dejando la vestibular abajo.
 * - `mirrorX` (derecha del paciente): `scale(-1,1) translate(-100,0)` — espeja en
 *   horizontal, dejando la mesial del lado de la línea media.
 * - Las dos: 180°, `scale(-1,-1) translate(-100,-100)`.
 */
export const toothGroupTransform = (
  placement: Pick<ToothPlacement, 'flipped' | 'mirrorX'>,
): string | undefined => {
  if (placement.flipped && placement.mirrorX) return 'scale(-1,-1) translate(-100,-100)';
  if (placement.flipped) return 'scale(1,-1) translate(0,-100)';
  if (placement.mirrorX) return 'scale(-1,1) translate(-100,0)';
  return undefined;
};

/**
 * Devuelve un punto **de la pantalla** a las coordenadas del contrato (inversa de
 * `toothGroupTransform`), que es lo que necesita el `hit-test` de una cara.
 */
export const unscreenPoint = (
  x: number,
  y: number,
  placement: Pick<ToothPlacement, 'flipped' | 'mirrorX'>,
): Point => ({
  x: placement.mirrorX ? TOOTH_CANVAS - x : x,
  y: placement.flipped ? TOOTH_CANVAS - y : y,
});

/** Lado del lienzo de una pieza, en unidades del `viewBox`. */
export const TOOTH_CANVAS = 100;

/**
 * Línea base del número de pieza, en unidades del lienzo.
 *
 * El cuadro de la pieza acaba en 100 y el número tiene que quedar **debajo y con
 * aire**: a 124 quedaba pegado al borde (con una tipografía de 26–30 el alto de las
 * cifras se come casi todo el hueco) y el dibujo se leía como un amasijo de cuadros.
 *
 * Vive en el contrato porque lo usan **los tres** renderizadores: el gráfico de
 * pantalla, el de papel del navegador y el SVG del dossier que se compone en el
 * servidor. El número tiene que caer a la misma altura en los tres.
 */
export const TOOTH_LABEL_BASELINE = 138;

/**
 * Hueco extra **en la línea media** (entre el 11 y el 21, y entre el 41 y el 31), en
 * unidades del lienzo.
 *
 * Sin él los dos cuadrantes quedan pegados y el odontograma se lee como una fila
 * continua de 16 piezas: en un esquema clínico la línea media es una referencia, y
 * ver de un golpe dónde empieza cada cuadrante evita contar casillas a ojo.
 */
export const MIDLINE_GAP = 28;

export interface ArchLayout {
  dentition: Dentition;
  /** Anchura total del lienzo de la arcada. */
  width: number;
  upper: readonly ToothPlacement[];
  lower: readonly ToothPlacement[];
  /**
   * Arcadas **primarias** de un odontograma **mixto**: las piezas de leche, cada una en
   * la ranura de su sucesor permanente. Van vacías en `permanente` y `temporal` (ahí lo
   * temporal ya está en `upper`/`lower`), y se dibujan como **una banda más** debajo de
   * la principal (ADR 0051).
   */
  upperPrimary: readonly ToothPlacement[];
  lowerPrimary: readonly ToothPlacement[];
}

/**
 * Distribución de cuadrantes FDI (doc §7.2). El orden es el que se ve en pantalla
 * mirando al paciente: en la arcada superior, del 18 (extremo derecho del paciente,
 * a la izquierda de la pantalla) al 28; en la inferior, del 48 al 38.
 *
 * Una dentición **temporal** no dibuja los molares que no existen (posiciones 6–8
 * del cuadrante temporal): pintarlos como si fueran piezas permanentes sería un
 * error clínico, así que la arcada se acorta sola.
 *
 * Una dentición **mixta** dibuja la huella **permanente** (la boca a la que va el
 * paciente) y, aparte, las piezas temporales que quedan, cada una **en la ranura de su
 * sucesor** (`primarySuccessor`), que es como se ve el recambio en la boca real
 * (ADR 0051).
 */
export const archLayout = (dentition: Dentition = 'permanente'): ArchLayout => {
  // El reparto del doc §7.2, leído **en el orden en que se ve** mirando al
  // paciente: la arcada superior va del 18 (extremo derecho del paciente, a la
  // izquierda de la pantalla) al 28, y la inferior del 48 al 38. El FDI crece hacia
  // la línea media, así que dentro de cada cuadrante el orden de pintado es el
  // inverso: primero el molar del extremo (posición 8) y al final el incisivo
  // central (posición 1).
  //
  // La arcada **principal** solo es la temporal cuando el paciente no tiene ninguna
  // pieza permanente; en la mixta manda la permanente (las temporales van aparte).
  const soloTemporal = dentition === 'temporal';
  const posiciones: readonly FdiPosition[] = soloTemporal
    ? [5, 4, 3, 2, 1]
    : [8, 7, 6, 5, 4, 3, 2, 1];
  const cuadrantesSuperiores: readonly FdiQuadrant[] = soloTemporal ? [5, 6] : [1, 2];
  const cuadrantesInferiores: readonly FdiQuadrant[] = soloTemporal ? [8, 7] : [4, 3];

  const colocar = (cuadrantes: readonly FdiQuadrant[], upper: boolean): ToothPlacement[] =>
    cuadrantes.flatMap((quadrant, indice) =>
      // Media arcada izquierda de la pantalla: del extremo hacia la línea media
      // (18→11). Media derecha: de la línea media hacia el extremo (21→28), para
      // que el reparto se lea igual que en el doc §7.2.
      (indice === 0 ? posiciones : [...posiciones].reverse()).map((position) => {
        const toothNumber = quadrant * 10 + position;
        const kind = toothKind(toothNumber);
        return {
          toothNumber,
          quadrant,
          position,
          kind,
          upper,
          // Las coordenadas las pone quien llama, una vez conocida la longitud de
          // la arcada: aquí solo viaja el orden.
          x: 0,
          // En la mandíbula la cara vestibular mira hacia abajo: la pieza se dibuja
          // volteada en vertical para que el esquema coincida con la boca.
          flipped: !upper,
          // Y las piezas de la derecha del paciente, espejadas en horizontal: su
          // mesial tiene que quedar del lado de la línea media.
          mirrorX: isPatientRightQuadrant(quadrant),
          surfaces: TOOTH_SURFACES_BY_KIND[kind],
        };
      }),
    );

  // La primera mitad de la lista es el cuadrante de la derecha del paciente y la
  // segunda el de la izquierda: entre las dos va el hueco de la línea media.
  const sinCoordenadas = (list: ToothPlacement[]): ToothPlacement[] => {
    const mitad = list.length / 2;
    return list.map((tooth, index) => ({
      ...tooth,
      x: index * TOOTH_STRIDE + (index >= mitad ? MIDLINE_GAP : 0),
    }));
  };

  const upper = sinCoordenadas(colocar(cuadrantesSuperiores, true));
  const lower = sinCoordenadas(colocar(cuadrantesInferiores, false));
  const width = Math.max(upper.length, lower.length) * TOOTH_STRIDE + MIDLINE_GAP;

  if (dentition !== 'mixta') {
    return { dentition, width, upper, lower, upperPrimary: [], lowerPrimary: [] };
  }

  // La mixta: la huella es la permanente (`upper`/`lower` de arriba) y cada pieza
  // temporal se coloca en la ranura de **su sucesor**. Los cuadrantes temporales 5–8
  // caen del mismo lado que los permanentes 1–4 (5 con 1, 6 con 2, 8 con 4, 7 con 3).
  const porNumero = new Map([...upper, ...lower].map((tooth) => [tooth.toothNumber, tooth]));
  const posicionesPrimarias: readonly FdiPosition[] = [5, 4, 3, 2, 1];

  const colocarPrimarias = (
    cuadrantes: readonly FdiQuadrant[],
    upperArcada: boolean,
  ): ToothPlacement[] =>
    cuadrantes.flatMap((quadrant, indice) =>
      (indice === 0 ? posicionesPrimarias : [...posicionesPrimarias].reverse()).map((position) => {
        const toothNumber = quadrant * 10 + position;
        const kind = toothKind(toothNumber);
        return {
          toothNumber,
          quadrant,
          position,
          kind,
          upper: upperArcada,
          // La ranura del sucesor: donde estará su permanente. Sin sucesor en la
          // arcada (no debería pasar: la temporal siempre tiene posición 1–5) va al 0.
          x: porNumero.get(primarySuccessor(toothNumber))?.x ?? 0,
          flipped: !upperArcada,
          mirrorX: isPatientRightQuadrant(quadrant),
          surfaces: TOOTH_SURFACES_BY_KIND[kind],
        };
      }),
    );

  return {
    dentition,
    width,
    upper,
    lower,
    upperPrimary: colocarPrimarias([5, 6], true),
    lowerPrimary: colocarPrimarias([8, 7], false),
  };
};

/* ── Carga rápida por teclado ──────────────────────────────────────────────── */

/**
 * Teclas de condición de la carga rápida: la **minúscula** registra el hallazgo
 * como `pendiente` (rojo) y la **mayúscula** como `completado` (azul), que es el
 * gesto de «ya está hecho» sobre la misma tecla.
 *
 *   c / C  caries        o / O  obturación     x / X  extracción indicada
 *   a / A  ausente       r / R  corona         i / I  implante
 *   e / E  endodoncia
 */
export const QUICK_CONDITION_KEYS: Readonly<Record<string, ToothCondition>> = {
  c: 'caries',
  C: 'caries',
  o: 'restauracion',
  O: 'restauracion',
  x: 'extraccion_indicada',
  X: 'extraccion_indicada',
  a: 'ausente',
  A: 'ausente',
  r: 'corona',
  R: 'corona',
  i: 'implante',
  I: 'implante',
  e: 'endodoncia',
  E: 'endodoncia',
};

/**
 * Tecla de cada cara cuando hay una pieza seleccionada. Se evita la `o` porque ya
 * es la obturación: la cara oclusal se registra con `n` (de masticació**n**) y las
 * proximales con `s` (mesial) y `d` (distal).
 */
export const QUICK_SURFACE_KEYS: Readonly<Record<string, ToothSurface>> = {
  v: 'vestibular',
  l: 'lingual',
  n: 'occlusal',
  s: 'mesial',
  d: 'distal',
};

export interface QuickEntryState {
  /** Pieza seleccionada, o `null` si todavía no se escribió un número. */
  toothNumber: number | null;
  /** Dígitos pendientes de completar el número de pieza (`"1"` esperando el 6). */
  pendingDigits: string;
  /** Caras activas para la siguiente condición de caries/obturación. */
  surfaces: ToothSurface[];
  /** Última condición elegida (se mantiene para encadenar piezas). */
  condition: ToothCondition | null;
  state: ClinicalState;
}

export const initialQuickEntryState = (): QuickEntryState => ({
  toothNumber: null,
  pendingDigits: '',
  surfaces: [],
  condition: null,
  state: 'pendiente',
});

export type QuickEntryIntent =
  /** Cambió el estado de la máquina: la interfaz repinta la pieza activa. */
  | { kind: 'state'; state: QuickEntryState }
  /** Hay que guardar este hallazgo. */
  | { kind: 'record'; input: RecordFindingInput }
  /** Hay que borrar este hallazgo (la pieza vuelve a estar sana). */
  | { kind: 'delete'; input: DeleteFindingInput }
  /** Hay que dejar la cara sana sin decir qué condición había. */
  | { kind: 'clear'; input: ClearSurfaceInput }
  /** Se salió de la carga rápida (`Escape`). */
  | { kind: 'cancel' }
  /** La tecla no hace nada aquí. */
  | { kind: 'ignored' };

const esPiezaViva = (toothNumber: number): boolean => isToothNumber(toothNumber);

/**
 * Máquina de la carga rápida: recibe una tecla y el estado y devuelve el estado
 * nuevo y, si toca, el hallazgo que hay que guardar. Es **pura** y vive en el
 * contrato para que la interfaz no duplique reglas: la misma pulsación produce el
 * mismo resultado en la pantalla y en las pruebas.
 *
 * Flujo: se escribe el número de pieza (dos dígitos, p. ej. `1` `6`), se eligen
 * caras con `v`/`l`/`n`/`s`/`d` (sin caras, la condición de caries u obturación se
 * aplica a la cara oclusal) y se pulsa la tecla de condición. Al registrar, las
 * caras se limpian y **la pieza sigue seleccionada** para poder marcar otra cara o
 * encadenar la pieza siguiente escribiendo su número.
 */
export const quickEntryKey = (
  state: QuickEntryState,
  key: string,
): { state: QuickEntryState; intent: QuickEntryIntent } => {
  if (key === 'Escape') {
    return { state: initialQuickEntryState(), intent: { kind: 'cancel' } };
  }

  // 1) Dígitos: completan el número de pieza FDI.
  if (/^[0-9]$/.test(key)) {
    const digitos = `${state.pendingDigits}${key}`;
    if (digitos.length === 1) {
      const numero = Number(digitos);
      // Los cuadrantes válidos empiezan por 1–8: si el dígito no puede abrir un
      // número, se ignora en lugar de reinterpretarlo.
      if (numero < 1 || numero > 8) return { state, intent: { kind: 'ignored' } };
      const abierto: QuickEntryState = {
        ...state,
        pendingDigits: digitos,
        toothNumber: null,
        surfaces: [],
      };
      return { state: abierto, intent: { kind: 'state', state: abierto } };
    }

    const numero = Number(digitos);
    if (!esPiezaViva(numero)) {
      // El número no existe en FDI: ese segundo dígito pasa a ser el primero del
      // número siguiente, así teclear «19» no deja la máquina atascada esperando
      // un número imposible.
      const reinicio: QuickEntryState = {
        ...state,
        pendingDigits: key,
        toothNumber: null,
        surfaces: [],
      };
      return { state: reinicio, intent: { kind: 'state', state: reinicio } };
    }

    const siguiente: QuickEntryState = {
      ...state,
      pendingDigits: '',
      toothNumber: numero,
      surfaces: [],
    };
    return { state: siguiente, intent: { kind: 'state', state: siguiente } };
  }

  const normalizada = key.length === 1 ? key : key.toLowerCase();

  // 2) `Backspace` suelta la pieza o el dígito pendiente. (Se compara con la tecla
  //    original: `delete`/`backspace` en minúsculas son teclas de una sola letra
  //    que sí deben leerse como caras.)
  if (key === 'Backspace') {
    const siguiente: QuickEntryState =
      state.pendingDigits !== ''
        ? { ...state, pendingDigits: '' }
        : { ...state, toothNumber: null, surfaces: [] };
    return { state: siguiente, intent: { kind: 'state', state: siguiente } };
  }

  // 3) Caras: se acumulan para la siguiente caries u obturación.
  const cara = QUICK_SURFACE_KEYS[normalizada];
  if (cara !== undefined && state.toothNumber !== null) {
    const caras = state.surfaces.includes(cara)
      ? state.surfaces.filter((item) => item !== cara)
      : [...state.surfaces, cara];
    const siguiente: QuickEntryState = { ...state, surfaces: caras };
    return { state: siguiente, intent: { kind: 'state', state: siguiente } };
  }

  // 4) Condición: registra el hallazgo sobre la pieza activa.
  const condicion = QUICK_CONDITION_KEYS[key];
  if (condicion !== undefined && state.toothNumber !== null) {
    const toothNumber = state.toothNumber;
    const estadoClinico: ClinicalState = key === key.toUpperCase() ? 'completado' : 'pendiente';

    if (isWholeToothCondition(condicion)) {
      const siguiente: QuickEntryState = {
        ...state,
        surfaces: [],
        condition: condicion,
        state: estadoClinico,
      };
      return {
        state: siguiente,
        intent: {
          kind: 'record',
          input: {
            toothNumber,
            surface: null,
            condition: condicion,
            state: estadoClinico,
            notes: null,
            sessionId: null,
          },
        },
      };
    }

    // Caries u obturación sin cara marcada: se aplica a la cara oclusal, que es la
    // que más se registra, y así una pieza se resuelve con dos pulsaciones.
    const caras: readonly ToothSurface[] =
      state.surfaces.length > 0 ? state.surfaces : ['occlusal'];
    const siguiente: QuickEntryState = {
      ...state,
      surfaces: [],
      condition: condicion,
      state: estadoClinico,
    };
    return {
      state: siguiente,
      intent: {
        kind: 'record',
        input: {
          toothNumber,
          surface: caras[0]!,
          condition: condicion,
          state: estadoClinico,
          notes: null,
          sessionId: null,
        },
      },
    };
  }

  // 5) `Supr` deja la cara sana: la pieza vuelve a estar sana, que en este patrón
  //    es la ausencia de fila. Si ya se eligió condición, se borra esa; si no, se
  //    limpia la cara entera.
  if (key === 'Delete' && state.toothNumber !== null) {
    const caras: readonly ToothSurface[] =
      state.surfaces.length > 0 ? state.surfaces : ['occlusal'];
    const condicion = state.condition;
    return {
      state: { ...state, surfaces: [] },
      intent:
        condicion !== null && isSurfaceCondition(condicion)
          ? {
              kind: 'delete',
              input: { toothNumber: state.toothNumber, surface: caras[0]!, condition: condicion },
            }
          : { kind: 'clear', input: { toothNumber: state.toothNumber, surface: caras[0]! } },
    };
  }

  return { state, intent: { kind: 'ignored' } };
};

/**
 * Etiqueta de la pieza activa para la barra de la carga rápida (`"1"` → `"1_"`).
 *
 * La cara se nombra **con la pieza delante** (`surfaceLabelFor`): al elegir el 11 la
 * barra dice «11 (Incisal)», no «11 (Oclusal)», porque la caries que se marque va al
 * borde incisal. Es la misma regla que la tabla, la hoja de la pieza y el papel.
 */
export const quickEntryLabel = (state: QuickEntryState): string =>
  state.toothNumber === null
    ? state.pendingDigits === ''
      ? ''
      : `${state.pendingDigits}_`
    : `${String(state.toothNumber)}${
        state.surfaces.length === 0
          ? ''
          : ` (${state.surfaces
              .map((surface) => surfaceLabelFor(state.toothNumber as number, surface))
              .join(' · ')})`
      }`;
