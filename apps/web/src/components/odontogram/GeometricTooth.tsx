import {
  CLINICAL_STATE_COLORS,
  CONDITION_LABELS,
  CLINICAL_STATE_LABELS,
  SURFACE_DRAW_ORDER,
  SURFACE_LABELS,
  SURFACE_POLYGONS,
  TOOTH_LABEL_BASELINE,
  WHOLE_TOOTH_SYMBOLS,
  surfaceLabelFor,
  toothGroupTransform,
  unscreenPoint,
  wholeToothMarkerTone,
  wholeToothMarkers,
  TOOTH_OUTLINE_POINTS,
  surfaceAtPoint,
} from '@odontocrm/contracts';
import type {
  ClinicalState,
  ToothCondition,
  ToothFindingRecord,
  ToothMarker,
  ToothSurface,
  WholeToothCondition,
} from '@odontocrm/contracts';
import { useRef } from 'react';
import type { KeyboardEvent, MouseEvent } from 'react';

import { findingFill } from '../../lib/odontogram-api';
import { t } from '../../lib/i18n';

/**
 * La pieza del odontograma, dibujada con los polígonos del contrato (doc §7.1).
 *
 * El lienzo de una pieza es de **100×100** y vive aquí, no en el contrato, porque
 * es una decisión de pintura: la geometría (`SURFACE_POLYGONS`, `surfaceAtPoint`)
 * sigue siendo la única fuente de verdad de qué cara hay bajo un punto.
 *
 * La pieza de la mandíbula se dibuja volteada en vertical (`flipped`): en la boca
 * la cara vestibular mira hacia abajo, así que el esquema se voltea para que el
 * dibujo coincida con el paciente. Ese volteo obliga a **deshacerlo** antes de
 * preguntar por la cara, o se registraría la cara contraria a la que se ve.
 */

/** Lado del lienzo de una pieza, en unidades del `viewBox`. */
export const TOOTH_CANVAS = 100;

/**
 * Línea base del número de pieza, en unidades del lienzo.
 *
 * Se lee del contrato (`@odontocrm/contracts`) y se reexporta aquí para no romper a
 * quien la importaba de este módulo: el mismo valor lo usa el SVG del dossier que el
 * servicio clínico compone en el servidor, y el número tiene que caer a la misma
 * altura en pantalla, en el papel del navegador y en ese PDF.
 */
export { TOOTH_LABEL_BASELINE } from '@odontocrm/contracts';

/**
 * Cara que hay bajo un punto **del lienzo visible** de la pieza.
 *
 * `surfaceAtPoint` trabaja en las coordenadas del contrato, que describen una pieza
 * **superior y de la izquierda del paciente** (vestibular arriba, mesial a la
 * izquierda). Cuando la pieza va volteada (mandíbula) o espejada (derecha del
 * paciente) hay que **deshacer esas dos transformaciones** antes de preguntar: si no,
 * pulsar la cara que se ve registra la contraria —el vecino equivocado en el caso de
 * mesial/distal—. La inversa la da el contrato (`unscreenPoint`), que es la misma
 * que usa el dibujo.
 */
export const pointToSurface = (
  x: number,
  y: number,
  flipped: boolean,
  mirrorX = false,
): ToothSurface | null => {
  const punto = unscreenPoint(x, y, { flipped, mirrorX });
  return surfaceAtPoint(punto.x, punto.y);
};

const enMinusculas = (texto: string): string => texto.toLowerCase();

/**
 * Condición y cara, sin estado: «caries oclusal» o «ausente (pieza completa)».
 * Es lo que identifica a un hallazgo cuando el estado todavía no importa (borrar).
 *
 * La cara se nombra **con la pieza delante** porque en los dientes anteriores la de
 * masticación no es oclusal sino **incisal** (`surfaceLabelFor`).
 */
export const conditionSurfaceLabel = (
  condition: ToothCondition,
  surface: ToothSurface | null,
  toothNumber?: number,
): string =>
  surface === null
    ? t('odonto.pieza.condicionEntera', { condicion: enMinusculas(CONDITION_LABELS[condition]) })
    : t('odonto.pieza.condicionCara', {
        condicion: enMinusculas(CONDITION_LABELS[condition]),
        cara: enMinusculas(
          toothNumber === undefined
            ? SURFACE_LABELS[surface]
            : surfaceLabelFor(toothNumber, surface),
        ),
      });

/** Etiqueta de un hallazgo para leerlo en voz alta o en el aviso de la barra. */
export const findingLabel = (
  finding: Pick<ToothFindingRecord, 'surface' | 'condition' | 'state'>,
  toothNumber?: number,
): string =>
  t('odonto.pieza.hallazgoEstado', {
    detalle: conditionSurfaceLabel(finding.condition, finding.surface, toothNumber),
    estado: enMinusculas(CLINICAL_STATE_LABELS[finding.state]),
  });

/**
 * Texto accesible de la pieza: `Pieza 16, caries oclusal pendiente` o
 * `Pieza 16 sana`. La pieza sana no lleva adjetivos clínicos porque en este
 * patrón no tener hallazgo **es** estar sana.
 */
export const toothAriaLabel = (
  toothNumber: number,
  findings: readonly ToothFindingRecord[],
): string =>
  findings.length === 0
    ? t('odonto.pieza.sana', { pieza: toothNumber })
    : t('odonto.pieza.hallazgos', {
        pieza: toothNumber,
        hallazgos: findings.map((finding) => findingLabel(finding, toothNumber)).join(', '),
      });

export interface ToothConditionSymbolProps {
  condition: WholeToothCondition;
  state: ClinicalState;
}

/** Marcador ya colocado: la política (capas y geometría) vive en el contrato. */
export type MarkerSlot = ToothMarker;

/**
 * Coloca los marcadores de pieza completa **por capas** (spec anexo ADR 0032 §6): la
 * corona en la **periferia**, el implante o el conducto en el **centro**, la extracción
 * indicada por encima (**overlay**) y el aspa de `ausente` a tamaño completo —que cede
 * si hay implante—.
 *
 * La composición la decide el contrato (`wholeToothMarkers`): así la pantalla, el papel
 * y el dossier no tienen reglas propias y no pueden divergir. Antes se dibujaban en
 * fila y se encogían según cuántos hubiera, lo que deformaba el tornillo junto al
 * círculo de la corona.
 */
export const markerSlots = wholeToothMarkers;

/**
 * Símbolo clásico de las condiciones de **pieza completa**: aspa (ausente),
 * aspa discontinua roja (extracción indicada), círculo (corona), tornillo
 * (implante) y triángulo (endodoncia).
 *
 * Se dibuja **dos veces**: primero un halo del color de la superficie y luego la
 * marca. Sin el halo, un círculo de corona sobre una cara roja se lee como si fuera
 * anatomía del diente; con un panel opaco detrás se taparían las caras que conviven
 * con el tratamiento (ADR 0032), así que el halo —que no oculta nada— es lo que
 * deja ver las dos cosas: el tratamiento **y** lo que hay en sus caras.
 *
 * Que las caras sigan siendo válidas o no depende de la condición: `ausente` las
 * supera y los tratamientos conviven con ellas (ADR 0032).
 */
export const ToothConditionSymbol = ({ condition, state }: ToothConditionSymbolProps) => (
  <>
    <SymbolMark condition={condition} state={state} grosor={2.6} colorClass="stroke-surface" />
    <SymbolMark condition={condition} state={state} {...marcaDe(condition, state)} />
  </>
);

/**
 * Color de la marca de cada condición.
 *
 * El aspa de `ausente` va en tinta: es la ausencia del diente, no una tarea por hacer
 * ni un tratamiento. **Todo lo demás sigue la regla del color**: rojo = indicado o
 * pendiente, azul = realizado o completado —también la extracción indicada, que sale
 * roja porque se registra como pendiente, y azul el día que se marca hecha.
 */
const marcaDe = (
  condition: WholeToothCondition,
  state: ClinicalState,
): { color?: string; colorClass?: string } =>
  wholeToothMarkerTone(condition) === 'ink'
    ? { colorClass: 'stroke-ink' }
    : { color: CLINICAL_STATE_COLORS[state] };

/**
 * El trazo de un símbolo, a partir de las formas del contrato: la **geometría** vive
 * en `WHOLE_TOOTH_SYMBOLS` (la comparten la pantalla y el dossier del servidor) y
 * aquí solo se pasa a React. Se dibuja dos veces —halo y marca—, igual que antes.
 */
const SymbolMark = ({
  condition,
  color,
  colorClass,
  grosor = 1,
}: {
  condition: WholeToothCondition;
  state: ClinicalState;
  /** Color del trazo, o la clase que lo pone (el halo usa `stroke-surface`). */
  color?: string;
  colorClass?: string;
  /** Multiplicador del grosor, para el halo. */
  grosor?: number;
}) => {
  const simbolo = WHOLE_TOOTH_SYMBOLS[condition];

  return (
    <g
      stroke={color}
      className={colorClass}
      pointerEvents="none"
      strokeWidth={simbolo.strokeWidth * grosor}
      strokeLinecap={simbolo.strokeLinecap}
      strokeLinejoin={simbolo.strokeLinejoin}
    >
      {simbolo.shapes.map((shape, indice) => {
        if (shape.kind === 'line') {
          return (
            <line
              key={indice}
              x1={shape.x1}
              y1={shape.y1}
              x2={shape.x2}
              y2={shape.y2}
              strokeDasharray={shape.dash}
            />
          );
        }
        if (shape.kind === 'circle') {
          return <circle key={indice} cx={shape.cx} cy={shape.cy} r={shape.r} fill="none" />;
        }
        return <polygon key={indice} points={shape.points} fill="none" />;
      })}
    </g>
  );
};

export interface GeometricToothProps {
  toothNumber: number;
  /** Hallazgos **vigentes** de la pieza; vacío = pieza sana. */
  findings: readonly ToothFindingRecord[];
  /** Volteo vertical de la mandíbula y espejo horizontal de la derecha. */
  flipped: boolean;
  /** 	rue en los cuadrantes de la derecha del paciente (1, 4, 5 y 8). */
  mirrorX?: boolean;
  /** `true` si es la pieza activa de la carga rápida. */
  active?: boolean;
  /** Caras marcadas ahora mismo en la carga rápida. */
  activeSurfaces?: readonly ToothSurface[];
  /** Sin interacción: la vista impresa no lleva foco ni manejadores. */
  readOnly?: boolean;
  /**
   * Un **toque o clic** en la pieza. Llega la **cara** que hay bajo el punto, o
   * `null` si se pulsó fuera de las caras (el contorno, el número o el hueco).
   *
   * El panel decide qué hacer con eso según el modo de captura: por defecto abre la
   * hoja de botones de la pieza (con la cara marcada, si la hubo); en modo teclado,
   * elige la pieza o marca la cara para la barra de carga rápida.
   */
  onPress?: (surface: ToothSurface | null) => void;
}

export const GeometricTooth = ({
  toothNumber,
  findings,
  flipped,
  mirrorX = false,
  active = false,
  activeSurfaces = [],
  readOnly = false,
  onPress,
}: GeometricToothProps) => {
  // El rectángulo invisible es la referencia de coordenadas: su caja es
  // exactamente el lienzo de la pieza, así que la escala sale de su ancho y no
  // del `viewBox` (que el navegador estira según el ancho del contenedor).
  const lienzo = useRef<SVGRectElement>(null);
  const interactiva = !readOnly && onPress !== undefined;
  const marcadores = markerSlots(findings);

  const superficieEn = (event: MouseEvent<SVGGElement>): ToothSurface | null => {
    const caja = lienzo.current?.getBoundingClientRect();
    if (caja === undefined || caja.width === 0 || caja.height === 0) return null;
    const x = ((event.clientX - caja.left) / caja.width) * TOOTH_CANVAS;
    const y = ((event.clientY - caja.top) / caja.height) * TOOTH_CANVAS;
    return pointToSurface(x, y, flipped, mirrorX);
  };

  const alPulsar = (event: MouseEvent<SVGGElement>): void => {
    // La cara bajo el punto (o `null` si se pulsó fuera de las caras): el panel sabe
    // qué hacer con eso. Ya no hay dos gestos distintos según el puntero.
    onPress?.(superficieEn(event));
  };

  const alTeclear = (event: KeyboardEvent<SVGGElement>): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onPress?.(null);
  };

  return (
    <g
      role={interactiva ? 'button' : 'img'}
      tabIndex={interactiva ? 0 : undefined}
      aria-label={toothAriaLabel(toothNumber, findings)}
      onClick={interactiva ? alPulsar : undefined}
      onKeyDown={interactiva ? alTeclear : undefined}
      // `manipulation` quita el retardo de 300 ms y el zoom por doble toque en
      // móviles y tabletas: sin esto, marcar dientes seguidos se siente roto.
      style={interactiva ? { touchAction: 'manipulation' } : undefined}
      className={
        interactiva
          ? 'cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-focus'
          : undefined
      }
    >
      {active && (
        <rect
          x={-4}
          y={-4}
          width={108}
          height={108}
          rx={12}
          className="fill-primary/10"
          pointerEvents="none"
          aria-hidden
        />
      )}

      <g transform={toothGroupTransform({ flipped, mirrorX })}>
        {SURFACE_DRAW_ORDER.map((surface) => (
          <polygon
            key={surface}
            points={SURFACE_POLYGONS[surface]}
            // `transparent` y no `none`: el relleno sano se ve igual, pero la
            // cara sigue recibiendo el clic (con `none` el interior no es
            // «painted» y el navegador no lo considera pulsable).
            fill={findingFill(findings, surface) ?? 'transparent'}
            className="stroke-border-strong"
            strokeWidth={1}
          />
        ))}

        <polygon
          points={TOOTH_OUTLINE_POINTS}
          fill="none"
          className="stroke-ink"
          strokeWidth={4}
          strokeLinejoin="round"
        />

        {/* Los tratamientos, por capas: periferia, centro y overlay (spec §6). */}
        {marcadores.map((slot) => (
          <g
            key={`${slot.condition}-${slot.id}`}
            data-condicion={slot.condition}
            data-capa={slot.layer}
            // La extracción indicada va por encima con trazo translúcido: deja ver
            // debajo la corona o el conducto que motivó la exodoncia (spec §6).
            opacity={slot.layer === 'overlay' ? 0.75 : undefined}
            transform={`translate(${String(slot.cx - 50 * slot.scale)},${String(
              slot.cy - 50 * slot.scale,
            )}) scale(${String(slot.scale)})`}
          >
            <ToothConditionSymbol condition={slot.condition} state={slot.state} />
          </g>
        ))}

        {activeSurfaces.map((surface) => (
          <polygon
            key={`marcada-${surface}`}
            points={SURFACE_POLYGONS[surface]}
            fill="none"
            className="stroke-primary"
            strokeWidth={4}
            strokeDasharray="8 6"
            pointerEvents="none"
          />
        ))}
      </g>

      <text
        x={50}
        y={TOOTH_LABEL_BASELINE}
        textAnchor="middle"
        fontSize={26}
        fontWeight={600}
        className="fill-ink select-none"
      >
        {toothNumber}
      </text>

      <rect
        ref={lienzo}
        x={0}
        y={0}
        width={TOOTH_CANVAS}
        height={TOOTH_CANVAS}
        fill="none"
        pointerEvents="none"
      />
    </g>
  );
};
