import {
  archLayout,
  CLINICAL_STATE_COLORS,
  CONDITION_LABELS,
  SURFACE_POLYGONS,
  TOOTH_OUTLINE_POINTS,
} from '@odontocrm/contracts';
import type {
  ClinicalState,
  Dentition,
  OdontogramDetail,
  ToothFindingRecord,
  ToothPlacement,
  ToothSurface,
  WholeToothCondition,
} from '@odontocrm/contracts';

import { t } from '../../lib/i18n';
import { findingsForTooth } from '../../lib/odontogram-api';
import { TOOTH_LABEL_BASELINE, ToothConditionSymbol, markerSlots } from './GeometricTooth';
import { toothGroupTransform } from '@odontocrm/contracts';

/**
 * Odontograma **de papel**: la misma geometría que la pantalla, sin interacción.
 *
 * Se separa del componente interactivo a propósito: la vista de impresión la usa
 * también la secretaría (solo lectura) y el papel no debe llevar ni teclado, ni
 * estados de foco, ni manejadores de eventos.
 *
 * El **énfasis** del dibujo —separadores de caras, contorno y número de pieza— sale de
 * la **marca** (`--brand-*`), para que el papel del navegador case con el dossier que
 * compone el servidor. Los colores **clínicos** (rojo `pendiente`, azul `completado`)
 * son del dominio y no cambian con la paleta.
 */

/** En SVG, `var()` no vale como atributo: la marca entra por `style`. */
const TRAZO_CARA = { stroke: 'var(--brand-line)' } as const;
const TRAZO_PIEZA = { stroke: 'var(--brand-ink-strong)' } as const;
const TINTA_NUMERO = { fill: 'var(--brand-ink)' } as const;

/** Relleno de una cara: rojo pendiente, azul completado, sano sin relleno. */
const fillOf = (findings: readonly ToothFindingRecord[], surface: ToothSurface): string => {
  const finding = findings.find((item) => item.surface === surface);
  if (finding === undefined) return 'none';
  return finding.state === 'pendiente'
    ? CLINICAL_STATE_COLORS.pendiente
    : CLINICAL_STATE_COLORS.completado;
};

interface StaticToothProps {
  toothNumber: number;
  findings: readonly ToothFindingRecord[];
  /** Ancho del lienzo de una pieza, en unidades del `viewBox`. */
  size: number;
  /** Volteo vertical de la mandíbula (la cara vestibular mira hacia abajo). */
  flipped: boolean;
  /** Espejo horizontal de la derecha del paciente (mesial hacia la línea media). */
  mirrorX: boolean;
}

const StaticTooth = ({ toothNumber, findings, size, flipped, mirrorX }: StaticToothProps) => {
  const marcadores = markerSlots(findings);
  const escala = size / 100;

  return (
    <g transform={`scale(${String(escala)})`}>
      <g transform={toothGroupTransform({ flipped, mirrorX })}>
        {(Object.keys(SURFACE_POLYGONS) as ToothSurface[]).map((surface) => (
          <polygon
            key={surface}
            points={SURFACE_POLYGONS[surface]}
            fill={fillOf(findings, surface)}
            strokeWidth={1}
            style={TRAZO_CARA}
          />
        ))}
        <polygon
          points={TOOTH_OUTLINE_POINTS}
          fill="none"
          strokeWidth={4}
          strokeLinejoin="round"
          style={TRAZO_PIEZA}
        />
        {/* Uno o varios tratamientos: en el papel también conviven (ADR 0032). */}
        {marcadores.map((slot) => (
          <g
            key={`${slot.condition}-${slot.id}`}
            data-condicion={slot.condition}
            transform={`translate(${String(slot.cx - 50 * slot.scale)},${String(
              slot.cy - 50 * slot.scale,
            )}) scale(${String(slot.scale)})`}
          >
            <ToothConditionSymbol condition={slot.condition} state={slot.state} />
          </g>
        ))}
      </g>

      {/*
        El número va **siempre derecho**: este `<text>` está fuera del grupo volteado,
        así que no lleva transformación ninguna. Ponerle el volteo compensado
        (`scale(1,-1) translate(0,-248)`) lo devolvía a su sitio pero **espejaba los
        dígitos** —el 48 se leía «8t»—, que es justo lo que no puede pasar en un
        documento que se imprime. La línea base es la misma que en pantalla: el papel
        y el gráfico tienen que verse igual.
      */}
      <text
        x={50}
        y={TOOTH_LABEL_BASELINE}
        textAnchor="middle"
        fontSize={30}
        fontWeight={600}
        style={TINTA_NUMERO}
      >
        {toothNumber}
      </text>
    </g>
  );
};

/** Alto del lienzo de una arcada: la pieza, el aire del número y el número. */
const ARCH_HEIGHT = TOOTH_LABEL_BASELINE + 16;

/** Muestra en pequeño el símbolo de una condición, en el color de su estado. */
const SymbolPreview = ({
  condition,
  state,
}: {
  condition: WholeToothCondition;
  state: ClinicalState;
}) => (
  <svg viewBox="0 0 100 100" className="size-5 shrink-0" aria-hidden>
    <ToothConditionSymbol condition={condition} state={state} />
  </svg>
);

const Arch = ({
  teeth,
  detail,
  size,
  width,
  caption,
}: {
  teeth: readonly ToothPlacement[];
  detail: Pick<OdontogramDetail, 'findings'>;
  size: number;
  /**
   * Ancho del lienzo de la arcada **completa** (el de la huella permanente). Todas las
   * bandas de la boca usan el mismo, para que escalen igual y cada pieza caiga en su
   * columna: sin esto, la banda temporal —más corta— se estiraba a lo ancho, sus
   * dientes salían más grandes y se desalineaban con la de arriba.
   */
  width: number;
  /** Qué arcada es y hacia dónde mira cada cara: sin esto el papel se malinterpreta. */
  caption: string;
}) => {
  return (
    <figure className="m-0">
      <figcaption className="mb-0.5 text-[11px] text-[color:var(--brand-ink-subtle)]">
        {caption}
      </figcaption>
      <svg viewBox={`0 0 ${String(width)} ${String(ARCH_HEIGHT)}`} className="w-full" role="img">
        {teeth.map((tooth) => (
          <g key={tooth.toothNumber} transform={`translate(${String(tooth.x)},0)`}>
            <StaticTooth
              toothNumber={tooth.toothNumber}
              findings={findingsForTooth(detail, tooth.toothNumber)}
              size={size}
              flipped={tooth.flipped}
              mirrorX={tooth.mirrorX}
            />
          </g>
        ))}
      </svg>
    </figure>
  );
};

/**
 * Leyenda del papel: qué significa cada color y cada símbolo.
 *
 * Los tratamientos se enseñan en **los dos colores** (rojo = indicado o pendiente,
 * azul = realizado), porque un mismo símbolo significa dos cosas según su color y en
 * el informe eso tiene que quedar claro: el rojo es lo que queda por hacer y el azul
 * lo que ya está hecho.
 */
const OdontogramLegend = () => (
  <div className="space-y-1.5 text-xs text-[color:var(--brand-ink-muted)]">
    <ul className="flex flex-wrap gap-x-5 gap-y-1">
      <li className="flex items-center gap-1.5">
        <span
          className="inline-block size-3 rounded-sm border border-[color:var(--brand-line)]"
          style={{ backgroundColor: CLINICAL_STATE_COLORS.pendiente }}
          aria-hidden
        />
        {t('odonto.leyenda.rojo')}
      </li>
      <li className="flex items-center gap-1.5">
        <span
          className="inline-block size-3 rounded-sm border border-[color:var(--brand-line)]"
          style={{ backgroundColor: CLINICAL_STATE_COLORS.completado }}
          aria-hidden
        />
        {t('odonto.leyenda.azul')}
      </li>
      <li className="flex items-center gap-1.5">
        <span
          className="inline-block size-3 rounded-sm border border-[color:var(--brand-line)] bg-white"
          aria-hidden
        />
        {t('odonto.leyenda.sano')}
      </li>
    </ul>

    <ul className="flex flex-wrap items-center gap-x-5 gap-y-1.5">
      <li className="flex items-center gap-1.5">
        <span className="font-semibold" aria-hidden>
          ✕
        </span>
        {CONDITION_LABELS.ausente}
      </li>
      {(['extraccion_indicada', 'corona', 'implante', 'endodoncia'] as const).map((condition) => (
        <li key={condition} className="flex items-center gap-1.5">
          <span className="flex items-center gap-0.5">
            <SymbolPreview condition={condition} state="pendiente" />
            <SymbolPreview condition={condition} state="completado" />
          </span>
          {t('odonto.leyenda.tratamiento', { condicion: CONDITION_LABELS[condition] })}
        </li>
      ))}
    </ul>
  </div>
);

export interface OdontogramStaticChartProps {
  detail: Pick<OdontogramDetail, 'findings' | 'dentition'> | null;
  dentition?: Dentition;
  /** Alto del lienzo de cada pieza, en unidades del `viewBox`. */
  toothSize?: number;
}

/**
 * Las dos arcadas de la boca, sin interacción. Lo que no tiene fila está sano:
 * la ausencia de relleno **es** el estado sano del patrón por excepción.
 */
export const OdontogramStaticChart = ({
  detail,
  dentition,
  toothSize = 100,
}: OdontogramStaticChartProps) => {
  const boca = detail ?? { findings: {}, dentition: 'permanente' as Dentition };
  const layout = archLayout(dentition ?? boca.dentition);

  return (
    <div className="mx-auto max-w-[20cm] space-y-4">
      <Arch
        teeth={layout.upper}
        detail={boca}
        size={toothSize}
        width={layout.width}
        caption={t('odonto.arcada.superior.orientacion')}
      />
      <Arch
        teeth={layout.lower}
        detail={boca}
        size={toothSize}
        width={layout.width}
        caption={t('odonto.arcada.inferior.orientacion')}
      />
      {/* Dentición mixta (ADR 0051): las piezas de leche, en su banda y en la ranura
          de la que las va a sustituir. Solo existen si `archLayout` las trae. */}
      {layout.upperPrimary.length > 0 && (
        <Arch
          teeth={layout.upperPrimary}
          detail={boca}
          size={toothSize}
          width={layout.width}
          caption={`${t('odonto.arcada.superior.temporal')} · ${t('odonto.arcada.superior.orientacion')}`}
        />
      )}
      {layout.lowerPrimary.length > 0 && (
        <Arch
          teeth={layout.lowerPrimary}
          detail={boca}
          size={toothSize}
          width={layout.width}
          caption={`${t('odonto.arcada.inferior.temporal')} · ${t('odonto.arcada.inferior.orientacion')}`}
        />
      )}
      <OdontogramLegend />
    </div>
  );
};
