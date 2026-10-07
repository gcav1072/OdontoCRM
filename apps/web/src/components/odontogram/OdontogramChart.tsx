import {
  archLayout,
  CLINICAL_STATES,
  CLINICAL_STATE_COLORS,
  CONDITION_LABELS,
} from '@odontocrm/contracts';
import type {
  ClinicalState,
  Dentition,
  OdontogramDetail,
  ToothPlacement,
  ToothSurface,
  WholeToothCondition,
} from '@odontocrm/contracts';

import { findingsForTooth } from '../../lib/odontogram-api';
import { t } from '../../lib/i18n';
import { GeometricTooth, TOOTH_LABEL_BASELINE, ToothConditionSymbol } from './GeometricTooth';

/**
 * Las dos arcadas del odontograma, interactivas.
 *
 * La colocación la decide `archLayout` del contrato (doc §7.2), que ya sabe qué
 * piezas existen en cada dentición y cuáles van volteadas; aquí solo se pintan y
 * se reparte el ancho. La boca se lee **mirando al paciente**: la arcada superior
 * va del 18 al 28 y la inferior del 48 al 38.
 */

/** Alto del lienzo de una arcada: la pieza (100) más el número de pieza. */
const ARCH_HEIGHT = TOOTH_LABEL_BASELINE + 14;

/** Un ancho mínimo para que las piezas sigan siendo pulsables en pantallas estrechas. */
const MIN_WIDTH_CLASS = 'min-w-[44rem]';

/**
 * Con el dedo, cada pieza tiene que medir al menos ~44 px (lo que un dedo
 * acierta): 16 piezas × 44 px ≈ 704 px. Si la tableta es más estrecha, la arcada
 * se desplaza en horizontal en vez de encoger las piezas.
 */
const MIN_TOUCH_WIDTH_CLASS = 'min-w-[48rem]';

interface ArchProps {
  title: string;
  /** Orientación de las caras (vestibular/palatino/lingual), para no malinterpretarla. */
  orientacion: string;
  teeth: readonly ToothPlacement[];
  detail: OdontogramDetail | null;
  /** Ancho total del lienzo (el de la arcada más larga, para que las dos cuadren). */
  width: number;
  activeTooth: number | null;
  activeSurfaces: readonly ToothSurface[];
  readOnly: boolean;
  tapTargets: 'surfaces' | 'tooth';
  onSurfaceClick?: (toothNumber: number, surface: ToothSurface) => void;
  onToothClick?: (toothNumber: number) => void;
}

const Arch = ({
  title,
  orientacion,
  teeth,
  detail,
  width,
  activeTooth,
  activeSurfaces,
  readOnly,
  tapTargets,
  onSurfaceClick,
  onToothClick,
}: ArchProps) => (
  <section>
    <p className="mb-1 text-xs font-medium text-ink-subtle">
      {title}
      <span className="ml-2 font-normal text-ink-subtle/80">{orientacion}</span>
    </p>
    <div className="overflow-x-auto">
      <svg
        viewBox={`-6 -6 ${String(width + 12)} ${String(ARCH_HEIGHT)}`}
        className={`w-full ${tapTargets === 'tooth' ? MIN_TOUCH_WIDTH_CLASS : MIN_WIDTH_CLASS}`}
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
                tapTargets={tapTargets}
                onSurfaceClick={
                  onSurfaceClick === undefined
                    ? undefined
                    : (surface) => onSurfaceClick(tooth.toothNumber, surface)
                }
                onToothClick={
                  onToothClick === undefined ? undefined : () => onToothClick(tooth.toothNumber)
                }
              />
            </g>
          );
        })}
      </svg>
    </div>
  </section>
);

/** Muestra en pequeño el símbolo de una condición, en el color de su estado. */
/** Tratamientos: los que llevan estado (realizado / indicado). */
const TREATMENT_CONDITIONS: readonly WholeToothCondition[] = [
  'extraccion_indicada',
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
      {CLINICAL_STATES.map((state) => (
        <li key={state} className="flex items-center gap-1.5">
          <span
            className="inline-block size-3 rounded-sm border border-border"
            style={{ backgroundColor: CLINICAL_STATE_COLORS[state] }}
            aria-hidden
          />
          {`${CONDITION_LABELS.caries} / ${CONDITION_LABELS.restauracion} · ${t(
            state === 'pendiente' ? 'odonto.leyenda.pendiente' : 'odonto.leyenda.completado',
          )}`}
        </li>
      ))}
      <li className="flex items-center gap-1.5">
        <span className="inline-block size-3 rounded-sm border border-border-strong" aria-hidden />
        {t('odonto.leyenda.sano')}
      </li>

      {/* El aspa de `ausente` no tiene color de estado: la pieza no está, y ya.
          Los tratamientos van en la fila de abajo, **en los dos colores**. */}
      <li className="flex items-center gap-1.5">
        <SymbolPreview condition="ausente" state="pendiente" />
        {CONDITION_LABELS.ausente}
      </li>
    </ul>

    <ul className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-ink-muted">
      {TREATMENT_CONDITIONS.map((condition) => (
        <li key={condition} className="flex items-center gap-1.5">
          <span className="flex items-center gap-0.5">
            <SymbolPreview condition={condition} state="pendiente" />
            <SymbolPreview condition={condition} state="completado" />
          </span>
          {t('odonto.leyenda.tratamiento', { condicion: CONDITION_LABELS[condition] })}
        </li>
      ))}
    </ul>

    <p className="mt-2 text-xs text-ink-subtle">{t('odonto.leyenda.caras')}</p>
  </div>
);

export interface OdontogramChartProps {
  /** Odontograma leído; `null` = boca sin hallazgos (todo sano). */
  detail: OdontogramDetail | null;
  /** Pieza activa de la carga rápida. */
  activeTooth?: number | null;
  /** Caras marcadas de la pieza activa. */
  activeSurfaces?: readonly ToothSurface[];
  onSurfaceClick?: (toothNumber: number, surface: ToothSurface) => void;
  onToothClick?: (toothNumber: number) => void;
  readOnly?: boolean;
  /**
   * Qué hace un toque sobre una pieza: `surfaces` (ratón: se acierta la cara) o
   * `tooth` (dedo: abre la hoja de botones grandes). Lo decide quien pinta el
   * gráfico con `useCoarsePointer`.
   */
  tapTargets?: 'surfaces' | 'tooth';
  /** Dentición a dibujar cuando todavía no hay odontograma. */
  dentition?: Dentition;
}

export const OdontogramChart = ({
  detail,
  activeTooth = null,
  activeSurfaces = [],
  onSurfaceClick,
  onToothClick,
  readOnly = false,
  tapTargets = 'surfaces',
  dentition,
}: OdontogramChartProps) => {
  const layout = archLayout(dentition ?? detail?.dentition ?? 'permanente');

  return (
    <div className="space-y-4">
      <Arch
        title={t('odonto.arcada.superior')}
        orientacion={t('odonto.arcada.superior.orientacion')}
        teeth={layout.upper}
        detail={detail}
        width={layout.width}
        activeTooth={activeTooth}
        activeSurfaces={activeSurfaces}
        readOnly={readOnly}
        tapTargets={tapTargets}
        onSurfaceClick={onSurfaceClick}
        onToothClick={onToothClick}
      />
      <Arch
        title={t('odonto.arcada.inferior')}
        orientacion={t('odonto.arcada.inferior.orientacion')}
        teeth={layout.lower}
        detail={detail}
        width={layout.width}
        activeTooth={activeTooth}
        activeSurfaces={activeSurfaces}
        readOnly={readOnly}
        tapTargets={tapTargets}
        onSurfaceClick={onSurfaceClick}
        onToothClick={onToothClick}
      />
      {/*
        Dentición mixta (ADR 0051): las piezas de leche van en su propia banda, cada
        una en la ranura de la que la va a sustituir. Las bandas solo existen cuando
        hay piezas temporales, que es lo que dice `archLayout`.
      */}
      {layout.upperPrimary.length > 0 && (
        <Arch
          title={t('odonto.arcada.superior.temporal')}
          orientacion={t('odonto.arcada.superior.orientacion')}
          teeth={layout.upperPrimary}
          detail={detail}
          width={layout.width}
          activeTooth={activeTooth}
          activeSurfaces={activeSurfaces}
          readOnly={readOnly}
          tapTargets={tapTargets}
          onSurfaceClick={onSurfaceClick}
          onToothClick={onToothClick}
        />
      )}
      {layout.lowerPrimary.length > 0 && (
        <Arch
          title={t('odonto.arcada.inferior.temporal')}
          orientacion={t('odonto.arcada.inferior.orientacion')}
          teeth={layout.lowerPrimary}
          detail={detail}
          width={layout.width}
          activeTooth={activeTooth}
          activeSurfaces={activeSurfaces}
          readOnly={readOnly}
          tapTargets={tapTargets}
          onSurfaceClick={onSurfaceClick}
          onToothClick={onToothClick}
        />
      )}
      <Legend />
    </div>
  );
};
