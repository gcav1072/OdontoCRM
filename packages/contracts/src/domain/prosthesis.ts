import { z } from 'zod';

import { cleanText } from './patient.js';
import {
  CLINICAL_STATES,
  PROSTHESIS_BAND_Y,
  TOOTH_CANVAS,
  clinicalStateSchema,
  isPrimaryTooth,
  isToothNumber,
  isUpperTooth,
  toothNumberSchema,
  type ArchLayout,
  type ClinicalState,
} from './odontogram.js';

/**
 * Prótesis **removibles** (Fase 6, ampliación): PPR (parcial) y PRT (total).
 *
 * A diferencia de un hallazgo de pieza (una caries, una corona), una prótesis
 * removible **no se registra cara a cara**: es una estructura que abarca un **tramo**
 * (la parcial, PPR) o una **arcada completa** (la total, PRT). Por eso vive en una
 * entidad aparte —`ProsthesisFinding`— en vez de forzarla dentro del diccionario de
 * piezas (`Record<number, ToothFinding>`): una PPR «14–16» no es una propiedad de la
 * 14, la 15 o la 16 por separado, es un objeto de nivel de arcada.
 *
 * Clínica: las prótesis removibles sustituyen piezas que **no están**, así que las
 * piezas del tramo deberían estar `ausente` o `extraida`. La interfaz avisa, pero no
 * lo impone: una PPR indicada se registra antes de tallar, y las piezas todavía están.
 *
 * Convención de color (heredada del odontograma): **rojo `pendiente`** = indicada /
 * por confeccionar, **azul `completado`** = instalada / en uso. Se reutiliza
 * `ClinicalState` para no inventar un segundo eje de estado.
 */

/** Tipos de prótesis removible. */
export const PROSTHESIS_KINDS = ['ppr', 'prt'] as const;
export type ProsthesisKind = (typeof PROSTHESIS_KINDS)[number];
export const prosthesisKindSchema = z.enum(PROSTHESIS_KINDS);

/** Arcadas de una prótesis (siempre permanentes: 18–28 y 48–38). */
export const PROSTHESIS_ARCHES = ['maxilar', 'mandibula'] as const;
export type ProsthesisArch = (typeof PROSTHESIS_ARCHES)[number];
export const prosthesisArchSchema = z.enum(PROSTHESIS_ARCHES);

/** Nombre del tipo de prótesis en la interfaz. */
export const PROSTHESIS_KIND_LABELS: Readonly<Record<ProsthesisKind, string>> = {
  ppr: 'Prótesis parcial removible',
  prt: 'Prótesis total removible',
};

/** Sigla del tipo, para el gráfico y la leyenda. */
export const PROSTHESIS_KIND_SHORT: Readonly<Record<ProsthesisKind, string>> = {
  ppr: 'PPR',
  prt: 'PRT',
};

/** Nombre de la arcada en la interfaz. */
export const PROSTHESIS_ARCH_LABELS: Readonly<Record<ProsthesisArch, string>> = {
  maxilar: 'Maxilar superior',
  mandibula: 'Mandíbula inferior',
};

/**
 * Piezas de una arcada **en orden anatómico continuo**, del extremo derecho del
 * paciente a la línea media y de ahí al extremo izquierdo (`18…11, 21…28` para el
 * maxilar y `48…41, 31…38` para la mandíbula). Es el orden en el que se dibuja la
 * arcada (`archLayout`), así que un tramo contiguo aquí lo es también en pantalla.
 */
const archSequence = (arch: ProsthesisArch): readonly number[] => {
  const [derecha, izquierda] = arch === 'maxilar' ? [1, 2] : [4, 3];
  const posiciones = [1, 2, 3, 4, 5, 6, 7, 8] as const;
  return [
    ...posiciones.map((position) => derecha * 10 + position).reverse(),
    ...posiciones.map((position) => izquierda * 10 + position),
  ];
};

const ARCH_TEETH: Readonly<Record<ProsthesisArch, readonly number[]>> = {
  maxilar: archSequence('maxilar'),
  mandibula: archSequence('mandibula'),
};

/** Piezas de una arcada permanente, en orden anatómico continuo. */
export const archTeeth = (arch: ProsthesisArch): readonly number[] => ARCH_TEETH[arch];

/** Arcada a la que pertenece una pieza **permanente**, o `null` si es temporal. */
export const archOfTooth = (toothNumber: number): ProsthesisArch | null => {
  if (!isToothNumber(toothNumber) || isPrimaryTooth(toothNumber)) return null;
  return isUpperTooth(toothNumber) ? 'maxilar' : 'mandibula';
};

/**
 * `true` si las piezas forman un **tramo contiguo** dentro de su arcada (índices
 * consecutivos en `archTeeth`). Una PPR es un tramo: `[14,15,16]` sí, `[14,16]` no.
 */
export const teethAreContiguous = (
  toothNumbers: readonly number[],
  arch: ProsthesisArch,
): boolean => {
  const orden = ARCH_TEETH[arch];
  const indices = toothNumbers
    .map((tooth) => orden.indexOf(tooth))
    .filter((indice) => indice >= 0)
    .sort((a, b) => a - b);
  if (indices.length !== toothNumbers.length || indices.length === 0) return false;
  for (let i = 1; i < indices.length; i += 1) {
    if (indices[i] !== indices[i - 1]! + 1) return false;
  }
  return true;
};

/**
 * Tramo contiguo entre dos piezas de una misma arcada, en orden anatómico (el que
 * recorre `archTeeth`). Es lo que arma la **PPR** a partir de la primera y la última
 * pieza que el usuario toca en el gráfico. Devuelve `[]` si alguna no es de la arcada.
 */
export const archRange = (arch: ProsthesisArch, from: number, to: number): number[] => {
  const orden = ARCH_TEETH[arch];
  const i = orden.indexOf(from);
  const j = orden.indexOf(to);
  if (i < 0 || j < 0) return [];
  const [inicio, fin] = i <= j ? [i, j] : [j, i];
  return orden.slice(inicio, fin + 1);
};

/** Prótesis removible tal como se guarda y se pinta. */
export interface ProsthesisRecord {
  id: string;
  kind: ProsthesisKind;
  arch: ProsthesisArch;
  /**
   * Piezas que cubre, en orden FDI. Para la **PPR** es el tramo (p. ej. `[14,15,16]`);
   * para la **PRT**, la arcada completa (las 16 piezas).
   */
  toothNumbers: number[];
  /** `pendiente` (rojo, indicada) o `completado` (azul, instalada). */
  state: ClinicalState;
  notes: string | null;
  recordedByUsername: string | null;
  recordedAt: string;
  updatedAt: string;
  /** Sesión clínica en la que se registró (Fase 7). */
  sessionId: string | null;
}

/**
 * Cuerpo de `PUT .../prostheses`: registra o actualiza una prótesis removible.
 *
 * - Todas las piezas tienen que ser **de la misma arcada** (la que dice `arch`).
 * - La **PPR** debe ser un **tramo contiguo** de esa arcada.
 * - La **PRT** cubre la arcada **completa**: `toothNumbers` se normaliza a las 16
 *   piezas de la arcada (así no depende de que el cliente las enumere bien).
 */
export const recordProsthesisSchema = z
  .object({
    kind: prosthesisKindSchema,
    arch: prosthesisArchSchema,
    toothNumbers: z.array(toothNumberSchema).min(1).max(16),
    state: clinicalStateSchema.default('pendiente'),
    notes: z
      .string()
      .max(500)
      .transform(cleanText)
      .transform((value) => (value === '' ? null : value))
      .nullable()
      .default(null),
    sessionId: z.uuid().nullable().default(null),
  })
  .strict()
  .superRefine((value, ctx) => {
    const orden = ARCH_TEETH[value.arch];

    // Cada pieza tiene que existir y pertenecer a la arcada declarada.
    for (const tooth of value.toothNumbers) {
      if (!orden.includes(tooth)) {
        ctx.addIssue({
          code: 'custom',
          path: ['toothNumbers'],
          message: `La pieza ${tooth} no pertenece a la arcada «${value.arch}»`,
        });
      }
    }

    if (value.kind === 'prt') {
      const completa = orden.every((tooth) => value.toothNumbers.includes(tooth));
      if (!completa) {
        ctx.addIssue({
          code: 'custom',
          path: ['toothNumbers'],
          message: 'La prótesis total removible cubre la arcada completa',
        });
      }
      return;
    }

    // PPR: tramo contiguo.
    if (!teethAreContiguous(value.toothNumbers, value.arch)) {
      ctx.addIssue({
        code: 'custom',
        path: ['toothNumbers'],
        message: 'La prótesis parcial removible debe cubrir un tramo contiguo de la arcada',
      });
    }
  });

export type RecordProsthesisInput = z.infer<typeof recordProsthesisSchema>;

/** Borrado por identificador. */
export const deleteProsthesisSchema = z.object({ id: z.uuid() }).strict();
export type DeleteProsthesisInput = z.infer<typeof deleteProsthesisSchema>;

/**
 * Tramo de la doble línea de una prótesis en el lienzo de la arcada, en las mismas
 * coordenadas que las piezas (contrato). Lo comparten los **tres** renderizadores
 * —pantalla, papel del navegador y dossier del servidor—: la prótesis no puede
 * dibujarse distinta en cada uno.
 */
export interface ProsthesisTrack {
  /** Extremo izquierdo del tramo, en unidades del lienzo de la arcada. */
  x1: number;
  /** Extremo derecho del tramo. */
  x2: number;
  /** Altura (Y) del eje de la doble línea: la franja bajo las piezas. */
  y: number;
}

/**
 * Calcula el tramo que ocupa una prótesis en la arcada a partir de la colocación
 * (`archLayout`): la PRT abarca de borde a borde de la arcada; la PPR, de la primera
 * a la última pieza del tramo. Devuelve `null` si la arcada no dibuja esas piezas.
 */
export const prosthesisTrack = (
  prosthesis: Pick<ProsthesisRecord, 'kind' | 'arch' | 'toothNumbers'>,
  layout: ArchLayout,
): ProsthesisTrack | null => {
  const fila = prosthesis.arch === 'maxilar' ? layout.upper : layout.lower;
  if (fila.length === 0) return null;

  const primera = fila[0]!;
  const ultima = fila[fila.length - 1]!;

  if (prosthesis.kind === 'prt') {
    return {
      x1: primera.x,
      x2: ultima.x + TOOTH_CANVAS,
      y: PROSTHESIS_BAND_Y,
    };
  }

  const cubiertas = new Set(prosthesis.toothNumbers);
  const piezas = fila.filter((tooth) => cubiertas.has(tooth.toothNumber));
  if (piezas.length === 0) return null;

  const x1 = Math.min(...piezas.map((tooth) => tooth.x));
  const x2 = Math.max(...piezas.map((tooth) => tooth.x)) + TOOTH_CANVAS;
  return { x1, x2, y: PROSTHESIS_BAND_Y };
};

/** Resumen corto y legible de una prótesis, para avisos y tablas: `PPR 14–16`. */
export const prosthesisSummaryLabel = (prosthesis: ProsthesisRecord): string => {
  const sigla = PROSTHESIS_KIND_SHORT[prosthesis.kind];
  if (prosthesis.kind === 'prt') return `${sigla} ${PROSTHESIS_ARCH_LABELS[prosthesis.arch]}`;
  const orden = [...prosthesis.toothNumbers].sort((a, b) => a - b);
  const primera = orden[0];
  const ultima = orden[orden.length - 1];
  return primera === undefined || ultima === undefined
    ? sigla
    : `${sigla} ${String(primera)}–${String(ultima)}`;
};

/** Estados clínicos válidos de una prótesis (las dos fases). */
export const PROSTHESIS_STATES: readonly ClinicalState[] = CLINICAL_STATES;
