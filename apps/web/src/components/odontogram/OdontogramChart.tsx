import {
  allowedStatesFor,
  ARCH_CANVAS_HEIGHT,
  archLayout,
  CLINICAL_STATE_COLORS,
  CONDITION_LABELS,
} from '@odontocrm/contracts';
import type {
  ArchLayout,
  ClinicalState,
  Dentition,
  OdontogramDetail,
  ProsthesisArch,
  ProsthesisRecord,
  ToothPlacement,
  ToothSurface,
  WholeToothCondition,
} from '@odontocrm/contracts';

import { findingsForTooth } from '../../lib/odontogram-api';
import { t } from '../../lib/i18n';
import { GeometricTooth, ToothConditionSymbol } from './GeometricTooth';
import { ProsthesisOverlay } from './ProsthesisOverlay';

/**
 * Las dos arcadas del odontograma, interactivas.
 *
 * La colocación la decide `archLayout` del contrato (doc §7.2), que ya sabe qué
 * piezas existen en cada dentición y cuáles van volteadas; aquí solo se pintan y
 * se reparte el ancho. La boca se lee **mirando al paciente**: la arcada superior
 * va del 18 al 28 y la inferior del 48 al 38.
 */

/** Alto del lienzo de una arcada: la pieza (100), el número y la franja de prótesis. */
const ARCH_HEIGHT = ARCH_CANVAS_HEIGHT;

/**
 * Un ancho mínimo para que las piezas sigan siendo cómodas de pulsar en pantallas
 * estrechas. Ya no hay un ancho distinto para el dedo: el gesto es el mismo en todos
 * los dispositivos —pulsar la pieza abre su hoja— y la precisión de la cara la da la
 * hoja, no el tamaño de la casilla.
 */
const MIN_WIDTH_CLASS = 'min-w-[44rem]';

interface ArchProps {
  title: string;
  /** Orientación de las caras (vestibular/palatino/lingual), para no malinterpretarla. */
  orientacion: string;
  teeth: readonly ToothPlacement[];
  detail: OdontogramDetail | null;
  /** Colocación completa de la boca (para situar la doble línea de la prótesis). */
  layout: ArchLayout;
  /** Arcada que representa esta banda. */
  arch: ProsthesisArch;
  /** Prótesis removibles a pintar en esta banda (vacío en las bandas temporales). */
  prostheses: readonly ProsthesisRecord[];
  /** Ancho total del lienzo (el de la arcada más larga, para que las dos cuadren). */
  width: number;
  activeTooth: number | null;
  activeSurfaces: readonly ToothSurface[];
  readOnly: boolean;
  onToothPress?: (toothNumber: number, surface: ToothSurface | null) => void;
  onProsthesisPress?: (prosthesis: ProsthesisRecord) => void;
}

const Arch = ({
  title,
  orientacion,
  teeth,
  detail,
  layout,
  arch,
  prostheses,
  width,
  activeTooth,
  activeSurfaces,
  readOnly,
  onToothPress,
  onProsthesisPress,
}: ArchProps) => (
  <section>
    <p className="mb-1 text-xs font-medium text-ink-subtle">
      {title}
      <span className="ml-2 font-normal text-ink-subtle/80">{orientacion}</span>
    </p>
    <div className="overflow-x-auto">
      <svg
        viewBox={`-6 -6 ${String(width + 12)} ${String(ARCH_HEIGHT)}`}
        className={`w-full ${MIN_WIDTH_CLASS}`}
        role="group"
        aria-label={title}
      >
        {teeth.map((tooth) => {
          const activa = tooth.toothNumber === activeTooth;
          return (
            <g key={tooth.toothNumber} transform={`translate(${String(tooth.x)},0)`}>
              <GeometricTooth
                toothNumber={tooth.toothNumber}
                findings={findingsForTooth(detail, tooth.toothNumber)}
                flipped={tooth.flipped}
                mirrorX={tooth.mirrorX}
                active={activa}
                activeSurfaces={activa ? activeSurfaces : []}
                readOnly={readOnly}
                onPress={
                  onToothPress === undefined
                    ? undefined
                    : (surface) => onToothPress(tooth.toothNumber, surface)
                }
              />
            </g>
          );
        })}

        {/* La franja de las prótesis removibles: doble línea bajo las piezas. */}
        <ProsthesisOverlay
          prostheses={prostheses}
          arch={arch}
          layout={layout}
          readOnly={readOnly}
          onPress={onProsthesisPress}
        />
      </svg>
    </div>
  </section>
);

/** Muestra en pequeño el símbolo de una condición, en el color de su estado. */
/** Tratamientos: los que llevan estado (realizado / indicado). */
const TREATMENT_CONDITIONS: readonly WholeToothCondition[] = [
  'extraccion_indicada',
  'extraida',
  'corona',
  'implante',
  'endodoncia',
];

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

/**
 * Leyenda del gráfico: los dos colores clínicos del doc §7.2 (rojo pendiente,
 * azul completado) y los símbolos de las condiciones que mandan sobre las caras.
 *
 * Cada tratamiento se enseña en **los dos colores**: el mismo símbolo significa «por
 * hacer» o «hecho» según el color, y esa es la confusión que hay que evitar al leer
 * el odontograma (una endodoncia en rojo está indicada; en azul, realizada).
 */
const Legend = () => (
  <div className="rounded-control border border-border bg-surface-muted/60 px-4 py-3">
    <p className="text-xs font-medium text-ink">{t('odonto.leyenda.titulo')}</p>

    <ul className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-ink-muted">
      {/* El rojo es «por hacer»: una caries y un empaste indicados van así. */}
      <li className="flex items-center gap-1.5">
        <span
          className="inline-block size-3 rounded-sm border border-border"
          style={{ backgroundColor: CLINICAL_STATE_COLORS.pendiente }}
          aria-hidden
        />
        {`${CONDITION_LABELS.caries} / ${CONDITION_LABELS.restauracion} · ${t(
          'odonto.leyenda.pendiente',
        )}`}
      </li>
      {/* El azul es «hecho»: la caries no se «completa» —se trata y pasa a
          restauración—, así que completado solo lo lleva la restauración (spec §2). */}
      <li className="flex items-center gap-1.5">
        <span
          className="inline-block size-3 rounded-sm border border-border"
          style={{ backgroundColor: CLINICAL_STATE_COLORS.completado }}
          aria-hidden
        />
        {`${CONDITION_LABELS.restauracion} · ${t('odonto.leyenda.completado')}`}
      </li>
      <li className="flex items-center gap-1.5">
        <span className="inline-block size-3 rounded-sm border border-border-strong" aria-hidden />
        {t('odonto.leyenda.sano')}
      </li>

      {/* El aspa de `ausente` no tiene color de estado: la pieza no está, y ya. */}
      <li className="flex items-center gap-1.5">
        <SymbolPreview condition="ausente" state="completado" />
        {CONDITION_LABELS.ausente}
      </li>
    </ul>

    <ul className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-ink-muted">
      {TREATMENT_CONDITIONS.map((condition) => (
        <li key={condition} className="flex items-center gap-1.5">
          <span className="flex items-center gap-0.5">
            {/* Solo los colores que la condición admite (spec §2): la extracción
                indicada siempre va roja; la corona, el conducto y el implante se
                enseñan en las dos fases. */}
            {allowedStatesFor(condition).map((state) => (
              <SymbolPreview key={state} condition={condition} state={state} />
            ))}
          </span>
          {t('odonto.leyenda.tratamiento', { condicion: CONDITION_LABELS[condition] })}
        </li>
      ))}
    </ul>

    <ul className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-ink-muted">
      {/* Prótesis removibles: la doble línea que une un tramo (PPR) o la arcada (PRT). */}
      <li className="flex items-center gap-1.5">
        <svg viewBox="0 0 40 24" className="h-4 w-8 shrink-0" aria-hidden>
          <line x1={2} y1={9} x2={38} y2={9} stroke={CLINICAL_STATE_COLORS.pendiente} strokeWidth={3} />
          <line x1={2} y1={15} x2={38} y2={15} stroke={CLINICAL_STATE_COLORS.pendiente} strokeWidth={3} />
          <line x1={2} y1={4} x2={2} y2={20} stroke={CLINICAL_STATE_COLORS.pendiente} strokeWidth={3} />
          <line x1={38} y1={4} x2={38} y2={20} stroke={CLINICAL_STATE_COLORS.pendiente} strokeWidth={3} />
        </svg>
        {t('odonto.protesis.leyenda')}
      </li>
    </ul>

    <p className="mt-2 text-xs text-ink-subtle">{t('odonto.leyenda.caras')}</p>
  </div>
);

export interface OdontogramChartProps {
  /** Odontograma leído; `null` = boca sin hallazgos (todo sano). */
  detail: OdontogramDetail | null;
  /** Pieza activa de la carga rápida. */
  activeTooth?: number | null;
  /** Caras marcadas de la pieza activa (modo teclado). */
  activeSurfaces?: readonly ToothSurface[];
  /**
   * Un **toque o clic** en una pieza: llega su número y la cara bajo el punto (o
   * `null` si se pulsó fuera de las caras). El panel decide qué hacer según el modo.
   */
  onToothPress?: (toothNumber: number, surface: ToothSurface | null) => void;
  /**
   * Un **toque o clic** en la doble línea de una prótesis removible: reabre su ficha.
   */
  onProsthesisPress?: (prosthesis: ProsthesisRecord) => void;
  readOnly?: boolean;
  /** Dentición a dibujar cuando todavía no hay odontograma. */
  dentition?: Dentition;
}

export const OdontogramChart = ({
  detail,
  activeTooth = null,
  activeSurfaces = [],
  onToothPress,
  onProsthesisPress,
  readOnly = false,
  dentition,
}: OdontogramChartProps) => {
  const layout = archLayout(dentition ?? detail?.dentition ?? 'permanente');
  const prostheses = detail?.prostheses ?? [];

  return (
    <div className="space-y-4">
      <Arch
        title={t('odonto.arcada.superior')}
        orientacion={t('odonto.arcada.superior.orientacion')}
        teeth={layout.upper}
        detail={detail}
        layout={layout}
        arch="maxilar"
        prostheses={prostheses}
        width={layout.width}
        activeTooth={activeTooth}
        activeSurfaces={activeSurfaces}
        readOnly={readOnly}
        onToothPress={onToothPress}
        onProsthesisPress={onProsthesisPress}
      />
      <Arch
        title={t('odonto.arcada.inferior')}
        orientacion={t('odonto.arcada.inferior.orientacion')}
        teeth={layout.lower}
        detail={detail}
        layout={layout}
        arch="mandibula"
        prostheses={prostheses}
        width={layout.width}
        activeTooth={activeTooth}
        activeSurfaces={activeSurfaces}
        readOnly={readOnly}
        onToothPress={onToothPress}
        onProsthesisPress={onProsthesisPress}
      />
      {/*
        Dentición mixta (ADR 0051): las piezas de leche van en su propia banda, cada
        una en la ranura de la que la va a sustituir. Las bandas solo existen cuando
        hay piezas temporales, que es lo que dice `archLayout`. Las prótesis removibles
        son de la arcada permanente, así que en estas bandas no se pintan.
      */}
      {layout.upperPrimary.length > 0 && (
        <Arch
          title={t('odonto.arcada.superior.temporal')}
          orientacion={t('odonto.arcada.superior.orientacion')}
          teeth={layout.upperPrimary}
          detail={detail}
          layout={layout}
          arch="maxilar"
          prostheses={[]}
          width={layout.width}
          activeTooth={activeTooth}
          activeSurfaces={activeSurfaces}
          readOnly={readOnly}
          onToothPress={onToothPress}
        />
      )}
      {layout.lowerPrimary.length > 0 && (
        <Arch
          title={t('odonto.arcada.inferior.temporal')}
          orientacion={t('odonto.arcada.inferior.orientacion')}
          teeth={layout.lowerPrimary}
          detail={detail}
          layout={layout}
          arch="mandibula"
          prostheses={[]}
          width={layout.width}
          activeTooth={activeTooth}
          activeSurfaces={activeSurfaces}
          readOnly={readOnly}
          onToothPress={onToothPress}
        />
      )}
      <Legend />
    </div>
  );
};
