import {
  furcationEntrancesFor,
  PERIODONTAL_SITE_INDEXES,
  type FurcationEntrance,
  type FurcationGrade,
  type PeriodontalArch,
  type PeriodontalSide,
  type PeriodontalSite,
  type PeriodontalSiteDiff,
  type PeriodontalSiteIndex,
  type PeriodontalTooth,
} from '@odontocrm/contracts';
import { memo, type KeyboardEvent } from 'react';

import { t } from '../../lib/i18n';
import {
  ALERT_DEPTH_MM,
  ARCH_TOOTH_COUNT,
  BAND_HEIGHT,
  TOOTH_STRIP_HEIGHT,
  ARCH_VIEW_WIDTH,
  CORONAL_GRID_MM,
  CORONAL_GUIDE_MM,
  TOOTH_CARD_INSET,
  TOOTH_COLUMN_WIDTH,
  archBands,
  changeColor,
  comparisonSiteKey,
  comparisonSiteOf,
  depthY,
  GRID_MM,
  nicPolygonPoints,
  PERIODONTAL_COLORS,
  polylinePoints,
  previousPdPoints,
  siteDrawing,
  siteCursorBox,
  siteHitbox,
  type BandLayout,
  type SiteDrawing,
} from './geometry';
import {
  archName,
  furcationEntranceLabel,
  furcationLabel,
  mobilityLabel,
  siteAriaLabel,
  sideName,
  siteShortName,
} from './presentation';

/**
 * Gráfico SVG de una arcada del periodontograma: rejilla milimetrada, curvas de MG y
 * PS, polígono del NIC, sangrado/placa/supuración, movilidad y furcas, y zonas
 * táctiles por sitio.
 *
 * Es el **mismo componente** en pantalla y en el papel (`readOnly`): si hubiera dos
 * dibujos acabarían discrepando, y el documento imprimible tiene que enseñar
 * exactamente lo que se capturó. En pantalla los sitios se tocan directamente (además
 * del pad y de la tabla); en papel no hay foco ni manejadores.
 *
 * El componente está memoizado: con 16 piezas × 6 sitios por arcada, un re-render
 * completo del SVG en cada pulsación del pad se nota en una tablet.
 */

/** Margen izquierdo del lienzo: las etiquetas de milímetros fuera de la cuadrícula. */
const VIEW_PADDING_LEFT = 18;

/** Ancho total del `viewBox`, con el margen de las cotas. */
const VIEW_WIDTH = ARCH_VIEW_WIDTH + VIEW_PADDING_LEFT;

/** Colores de tinta y estructura según el soporte (pantalla o papel). */
interface SvgPalette {
  ink: string;
  muted: string;
  border: string;
  surface: string;
  surfaceMuted: string;
  /** Separador de columnas de pieza (muy tenue). */
  column: string;
}

const SCREEN_PALETTE: SvgPalette = {
  ink: 'var(--color-ink)',
  muted: 'var(--color-ink-subtle)',
  border: 'var(--color-border-strong)',
  surface: 'var(--color-surface)',
  surfaceMuted: 'var(--color-surface-muted)',
  column: 'var(--color-border)',
};

const PRINT_PALETTE: SvgPalette = {
  ink: 'var(--brand-ink)',
  muted: 'var(--brand-ink-subtle)',
  border: 'var(--brand-line)',
  surface: '#ffffff',
  surfaceMuted: '#f6f8f8',
  column: '#e2e8f0',
};

/** Punto del sitio con su dato, para no repetir el acceso a la tupla. */
type SiteTuple = readonly [PeriodontalSite, PeriodontalSite, PeriodontalSite];

const sitesOfFace = (tooth: PeriodontalTooth, side: PeriodontalSide): SiteTuple =>
  side === 'vestibular' ? tooth.vestibular : tooth.lingual;

/** Triángulo de furca: hueco (I), medio lleno (II) o lleno (III). */
const FurcationTriangle = ({
  x,
  y,
  grade,
  color,
}: {
  x: number;
  y: number;
  grade: FurcationGrade | undefined;
  color: string;
}) => {
  const points = `${String(x)},${String(y - 5)} ${String(x + 4.2)},${String(y + 2.8)} ${String(x - 4.2)},${String(y + 2.8)}`;
  const relleno = grade === undefined ? 'none' : color;
  return (
    <polygon
      points={points}
      fill={relleno}
      fillOpacity={grade === 2 ? 0.45 : undefined}
      stroke={color}
      strokeWidth={0.9}
    />
  );
};

/** Posición del triángulo de una entrada de furca dentro de la franja de la pieza. */
const furcationMarkerPosition = (
  arch: PeriodontalArch,
  toothIndex: number,
  entrance: FurcationEntrance,
): { x: number; y: number } => {
  const centerX = toothIndex * (ARCH_VIEW_WIDTH / ARCH_TOOTH_COUNT) + 20;
  const stripTop = BAND_HEIGHT;
  const stripBottom = BAND_HEIGHT + TOOTH_STRIP_HEIGHT;
  const esInterna =
    entrance === 'lingual' || entrance === 'mesiopalatina' || entrance === 'distopalatina';
  const esVestibular = entrance === 'vestibular';
  // Las entradas mesial/distal (primeros premolares superiores) viven entre dos
  // piezas: se dibujan **fuera de la tarjeta**, en la banda vestibular, para no
  // pisar el número FDI ni la insignia de movilidad. Dentro de la tarjeta solo
  // caben dos textos y la insignia.
  if (!esInterna && !esVestibular) {
    const y = arch === 'maxilar' ? stripTop - 5 : stripBottom + 5;
    return { x: centerX + (entrance === 'mesial' ? -13 : 13), y };
  }
  const bandaDeArriba = arch === 'maxilar' ? esVestibular : esInterna;
  const x =
    entrance === 'mesiopalatina'
      ? centerX - 8
      : entrance === 'distopalatina'
        ? centerX + 8
        : centerX;
  return { x, y: bandaDeArriba ? stripTop - 5 : stripBottom + 5 };
};

interface BandProps {
  layout: BandLayout;
  teeth: readonly PeriodontalTooth[];
  palette: SvgPalette;
  readOnly: boolean;
  active: PeriodontogramArchSvgProps['active'];
  comparison: ReadonlyMap<string, PeriodontalSiteDiff> | null;
  previous: readonly PeriodontalTooth[] | null;
  onSelectSite: PeriodontogramArchSvgProps['onSelectSite'];
}

const Band = ({
  layout,
  teeth,
  palette,
  readOnly,
  active,
  comparison,
  previous,
  onSelectSite,
}: BandProps) => {
  const side = layout.side;
  return (
    <g>
      {/* Zona coronal (MG > 0): sombreada y con guías para que la hiperplasia se
          lea dentro del gráfico y no como una línea que se escapa del mismo. */}
      <rect
        x={0}
        y={Math.min(depthY(layout, 0), depthY(layout, -CORONAL_GUIDE_MM))}
        width={ARCH_VIEW_WIDTH}
        height={Math.abs(depthY(layout, CORONAL_GUIDE_MM) - depthY(layout, 0))}
        fill={PERIODONTAL_COLORS.coronal}
      />
      {CORONAL_GRID_MM.map((milimetros) => (
        <line
          key={`coronal-${String(milimetros)}`}
          x1={0}
          x2={ARCH_VIEW_WIDTH}
          y1={depthY(layout, -milimetros)}
          y2={depthY(layout, -milimetros)}
          stroke={PERIODONTAL_COLORS.grid}
          strokeWidth={0.4}
          strokeDasharray="2 2"
        />
      ))}

      {/* Rejilla milimetrada: cada 2 mm y la línea de alerta a 4 mm. El LAC (0 mm)
          se dibuja más oscuro y más grueso: es la frontera raíz/corona. */}
      {GRID_MM.map((milimetros) => (
        <line
          key={`grid-${String(milimetros)}`}
          x1={0}
          x2={ARCH_VIEW_WIDTH}
          y1={depthY(layout, milimetros)}
          y2={depthY(layout, milimetros)}
          stroke={
            milimetros === 0
              ? PERIODONTAL_COLORS.lac
              : milimetros === ALERT_DEPTH_MM
                ? PERIODONTAL_COLORS.alert
                : PERIODONTAL_COLORS.grid
          }
          strokeWidth={milimetros === 0 ? 1.5 : 0.5}
          strokeDasharray={milimetros === ALERT_DEPTH_MM ? '5 3' : undefined}
        />
      ))}

      {/* Separadores de columna: atan cada punto con la tarjeta de su pieza, sin
          depender de que el ojo cuente 40 unidades de distancia. */}
      {Array.from({ length: ARCH_TOOTH_COUNT + 1 }, (_, indice) => (
        <line
          key={`columna-${String(indice)}`}
          x1={indice * TOOTH_COLUMN_WIDTH}
          x2={indice * TOOTH_COLUMN_WIDTH}
          y1={layout.top}
          y2={layout.top + BAND_HEIGHT}
          stroke={palette.column}
          strokeWidth={0.3}
        />
      ))}

      {/* Etiquetas de la rejilla, fuera de la cuadrícula para no tapar los sitios. */}
      {GRID_MM.map((milimetros) => (
        <text
          key={`mm-${String(milimetros)}`}
          x={-3}
          y={depthY(layout, milimetros) + 1.6}
          textAnchor="end"
          fontSize={5.6}
          style={{ fill: milimetros === 0 ? palette.ink : palette.muted }}
        >
          {milimetros}
        </text>
      ))}
      {/* Guías coronales: en positivo porque el margen crece hacia la corona. */}
      {CORONAL_GRID_MM.map((milimetros) => (
        <text
          key={`mm-coronal-${String(milimetros)}`}
          x={-3}
          y={depthY(layout, -milimetros) + 1.6}
          textAnchor="end"
          fontSize={5.6}
          style={{ fill: palette.muted }}
        >
          {`+${String(milimetros)}`}
        </text>
      ))}

      {teeth.map((tooth, toothIndex) => {
        if (tooth.missing) return null;
        const sites = sitesOfFace(tooth, side);
        // Tupla (no arreglo): los tres índices visuales siempre existen y el
        // compilador lo sabe, así no hay comprobaciones de undefined por píxel.
        const drawings: readonly [SiteDrawing, SiteDrawing, SiteDrawing] = [
          siteDrawing(layout, toothIndex, 0, sites[0]),
          siteDrawing(layout, toothIndex, 1, sites[1]),
          siteDrawing(layout, toothIndex, 2, sites[2]),
        ];
        const mgPoints = drawings
          .filter((drawing) => drawing.mgY !== null)
          .map((drawing) => ({ x: drawing.x, y: drawing.mgY as number }));
        const pdPoints = drawings
          .filter((drawing) => drawing.pdY !== null)
          .map((drawing) => ({ x: drawing.x, y: drawing.pdY as number }));
        const nicPoints = nicPolygonPoints(mgPoints, pdPoints);

        const previousTooth = previous?.find((item) => item.fdi === tooth.fdi) ?? null;
        const previousSites =
          previousTooth === null || previousTooth.missing ? null : sitesOfFace(previousTooth, side);
        const previousPoints =
          previousSites === null ? [] : previousPdPoints(layout, toothIndex, previousSites);

        return (
          <g key={`${String(tooth.fdi)}-${side}`}>
            {/* NIC: el área entre la MG y la PS. */}
            {nicPoints !== null && (
              <polygon points={nicPoints} fill={PERIODONTAL_COLORS.nic} stroke="none" />
            )}
            {/* Línea del margen gingival (azul). */}
            {mgPoints.length > 1 && (
              <polyline
                points={polylinePoints(mgPoints)}
                fill="none"
                stroke={PERIODONTAL_COLORS.mg}
                strokeWidth={1.1}
                strokeLinejoin="round"
              />
            )}
            {/* Línea de la profundidad de sondaje (roja). */}
            {pdPoints.length > 1 && (
              <polyline
                points={polylinePoints(pdPoints)}
                fill="none"
                stroke={PERIODONTAL_COLORS.pd}
                strokeWidth={1.1}
                strokeLinejoin="round"
              />
            )}
            {PERIODONTAL_SITE_INDEXES.map((index) => {
              const drawing = drawings[index];
              const site = sites[index];
              const change =
                comparison === null ? null : comparisonSiteOf(comparison, tooth.fdi, side, index);
              return (
                <g key={`marcas-${String(index)}`}>
                  {/* Punto de la PS cuando la bolsa es profunda (≥ 4 mm). */}
                  {site.pd !== null && site.pd >= 4 && drawing.pdY !== null && (
                    <circle cx={drawing.x} cy={drawing.pdY} r={1.7} fill={PERIODONTAL_COLORS.pd} />
                  )}
                  {/* BOP: punto lleno en el margen (forma + color, no solo color). */}
                  {site.bop && (
                    <circle
                      cx={drawing.x}
                      cy={drawing.mgY ?? drawing.pdY ?? layout.lacY}
                      r={3}
                      fill={PERIODONTAL_COLORS.bop}
                      stroke={palette.surface}
                      strokeWidth={0.7}
                    />
                  )}
                  {/* Placa: cuadrado junto al margen. */}
                  {site.plaque && (
                    <rect
                      x={drawing.x - 1.8}
                      y={(drawing.mgY ?? layout.lacY) + (layout.direction === 'up' ? 4 : -7.6)}
                      width={3.6}
                      height={3.6}
                      fill={PERIODONTAL_COLORS.plaque}
                      stroke={palette.surface}
                      strokeWidth={0.5}
                    />
                  )}
                  {/* Supuración: rombo en el fondo de la bolsa. */}
                  {site.suppuration && (
                    <polygon
                      points={`${String(drawing.x)},${String((drawing.pdY ?? layout.lacY) - 2.6)} ${String(drawing.x + 2.6)},${String(drawing.pdY ?? layout.lacY)} ${String(drawing.x)},${String((drawing.pdY ?? layout.lacY) + 2.6)} ${String(drawing.x - 2.6)},${String(drawing.pdY ?? layout.lacY)}`}
                      fill={PERIODONTAL_COLORS.suppuration}
                      stroke={palette.surface}
                      strokeWidth={0.5}
                    />
                  )}
                  {/* Comparación: color del cambio en el punto del sitio actual. */}
                  {change !== null && (drawing.pdY ?? drawing.mgY) !== null && (
                    <circle
                      cx={drawing.x}
                      cy={drawing.pdY ?? (drawing.mgY as number)}
                      r={2.8}
                      fill={changeColor(change.change)}
                      stroke={palette.surface}
                      strokeWidth={0.8}
                    />
                  )}
                </g>
              );
            })}
            {/* Línea punteada del examen anterior (PS previa). */}
            {previousPoints.length > 1 && (
              <polyline
                points={polylinePoints(previousPoints)}
                fill="none"
                stroke={PERIODONTAL_COLORS.previous}
                strokeWidth={1}
                strokeDasharray="3 2"
                opacity={0.85}
              />
            )}
            {/* Sitio activo: marco visible, forma además del color. Se ajusta a la
                rejilla dibujada (14 mm apicales a +4 coronales) para no sobresalir. */}
            {active !== null &&
              active !== undefined &&
              active.fdi === tooth.fdi &&
              active.side === side &&
              (() => {
                const marco = siteCursorBox(layout, toothIndex, active.siteIndex);
                return (
                  <rect
                    x={marco.x}
                    y={marco.top}
                    width={marco.width}
                    height={marco.height}
                    fill="rgba(124, 58, 237, 0.08)"
                    stroke={PERIODONTAL_COLORS.selection}
                    strokeWidth={1.2}
                    strokeDasharray="3 2"
                  />
                );
              })()}
            {PERIODONTAL_SITE_INDEXES.map((index) => {
              const hitbox = siteHitbox(layout, toothIndex, index);
              // Los sitios con el mismo x visual se resaltan al pasar el ratón; el
              // `title` nativo del SVG da el nombre anatómico completo.
              if (readOnly) return null;
              const etiqueta = siteAriaLabel(tooth.fdi, side, index);
              return (
                <rect
                  key={`hitbox-${String(index)}`}
                  x={hitbox.x}
                  y={hitbox.y}
                  width={hitbox.width}
                  height={hitbox.height}
                  fill="transparent"
                  role="button"
                  tabIndex={0}
                  aria-label={etiqueta}
                  className="cursor-pointer outline-none focus-visible:fill-[rgba(124,58,237,0.12)]"
                  onClick={() => onSelectSite?.(tooth.fdi, side, index)}
                  onKeyDown={(event: KeyboardEvent<SVGRectElement>) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    onSelectSite?.(tooth.fdi, side, index);
                  }}
                />
              );
            })}
          </g>
        );
      })}
    </g>
  );
};

export interface PeriodontogramArchSvgProps {
  arch: PeriodontalArch;
  /** Las 16 piezas de la arcada, en orden visual. */
  teeth: readonly PeriodontalTooth[];
  /** Documento impreso: sin interacción, foco ni manejadores. */
  readOnly?: boolean;
  /**
   * Paleta de papel (tinta de marca) en vez de la de pantalla. El documento la pide
   * para que el SVG case con el membrete; en pantalla, aunque el examen sea de solo
   * lectura, se usan los tokens del tema (si no, en modo oscuro no se leería).
   */
  paper?: boolean;
  /** Sitio activo que se resalta (solo pantalla). */
  active?: { fdi: number; side: PeriodontalSide; siteIndex: PeriodontalSiteIndex } | null;
  /** Índice de la comparación por sitio, para superponer el examen anterior. */
  comparison?: ReadonlyMap<string, PeriodontalSiteDiff> | null;
  /** Boca del examen anterior (línea punteada). */
  previous?: readonly PeriodontalTooth[] | null;
  onSelectSite?: (fdi: number, side: PeriodontalSide, siteIndex: PeriodontalSiteIndex) => void;
  /**
   * Selecciona la pieza desde la franja central del gráfico. Es el único blanco
   * táctil cómodo para cambiar de pieza (los sitios miden ~13 px de ancho) y el
   * único camino para recuperar una pieza ausente, que no dibuja sitios.
   */
  onSelectTooth?: (fdi: number) => void;
  onCycleMobility?: (fdi: number) => void;
  onCycleFurcation?: (fdi: number, entrance: FurcationEntrance) => void;
  /**
   * Ancho mínimo en pantalla, en píxeles. El gráfico mide siempre al menos esto (y
   * crece con el contenedor): así los triángulos, los números y los puntos no se
   * encogen hasta ser ilegibles. El contenedor que lo envuelve se encarga de
   * desplazar en horizontal, de modo que las dos arcadas se desplacen juntas.
   * En papel se ignora.
   */
  minWidth?: number;
  className?: string;
}

const PeriodontogramArchSvgBase = ({
  arch,
  teeth,
  readOnly = false,
  paper = false,
  active = null,
  comparison = null,
  previous = null,
  onSelectSite,
  onSelectTooth,
  onCycleMobility,
  onCycleFurcation,
  minWidth,
  className,
}: PeriodontogramArchSvgProps) => {
  const palette = paper ? PRINT_PALETTE : SCREEN_PALETTE;
  const bandas = archBands(arch);
  const stripTopY = BAND_HEIGHT;

  return (
    <figure className={`m-0 ${className ?? ''}`}>
      <figcaption
        className={
          paper
            ? 'mb-1 text-[11px] text-[color:var(--brand-ink-subtle)]'
            : 'mb-1 text-[11px] text-ink-subtle'
        }
      >
        {archName(arch)} · {t('periodonto.grafico.pista')}
      </figcaption>
      <svg
        viewBox={`0 0 ${String(VIEW_WIDTH)} ${String(BAND_HEIGHT * 2 + TOOTH_STRIP_HEIGHT)}`}
        className="w-full"
        style={paper || minWidth === undefined ? undefined : { minWidth: `${String(minWidth)}px` }}
        role={readOnly ? 'img' : 'group'}
        aria-label={t('periodonto.grafico.aria', { arcada: archName(arch) })}
      >
        <g transform={`translate(${String(VIEW_PADDING_LEFT)},0)`}>
          {bandas.map((layout) => (
            <Band
              key={layout.side}
              layout={layout}
              teeth={teeth}
              palette={palette}
              readOnly={readOnly}
              active={active}
              comparison={comparison}
              previous={previous}
              onSelectSite={onSelectSite}
            />
          ))}

          {/* Franja central con el número FDI, la movilidad y las furcas. */}
          <rect
            x={0}
            y={stripTopY}
            width={ARCH_VIEW_WIDTH}
            height={30}
            fill={palette.surfaceMuted}
            stroke={palette.border}
            strokeWidth={0.5}
          />
          {teeth.map((tooth, toothIndex) => {
            const centerX = toothIndex * (ARCH_VIEW_WIDTH / ARCH_TOOTH_COUNT) + 20;
            const movilidad = tooth.missing ? null : tooth.mobility;
            const estado = tooth.missing
              ? t('periodonto.pieza.ausente')
              : tooth.implant
                ? t('periodonto.pieza.implante')
                : null;
            const esActiva = active?.fdi === tooth.fdi;
            return (
              <g key={`fdi-${String(tooth.fdi)}`}>
                <rect
                  x={toothIndex * TOOTH_COLUMN_WIDTH + TOOTH_CARD_INSET}
                  y={stripTopY + 3}
                  width={TOOTH_COLUMN_WIDTH - TOOTH_CARD_INSET * 2}
                  height={24}
                  rx={3}
                  fill={esActiva ? palette.surfaceMuted : palette.surface}
                  stroke={
                    esActiva
                      ? PERIODONTAL_COLORS.selection
                      : tooth.missing
                        ? palette.muted
                        : palette.border
                  }
                  strokeWidth={esActiva ? 1.4 : 0.8}
                  strokeDasharray={tooth.missing ? '2 1.5' : undefined}
                />
                <text
                  x={centerX}
                  y={stripTopY + 13.5}
                  textAnchor="middle"
                  fontSize={10.5}
                  fontWeight={600}
                  style={{ fill: tooth.missing ? palette.muted : palette.ink }}
                >
                  {tooth.fdi}
                </text>
                {/* Estado de la pieza, con palabra además del tachado: no solo color. */}
                <text
                  x={centerX}
                  y={stripTopY + 22}
                  textAnchor="middle"
                  fontSize={5.4}
                  style={{ fill: palette.muted }}
                >
                  {estado ?? (tooth.implant ? t('periodonto.pieza.implante') : '')}
                </text>
                {/* Blanco táctil de la pieza: todo el recuadro del FDI. Va antes de
                    la insignia de movilidad para no taparle el toque. */}
                {!readOnly && (
                  <rect
                    x={toothIndex * TOOTH_COLUMN_WIDTH + TOOTH_CARD_INSET}
                    y={stripTopY + 3}
                    width={TOOTH_COLUMN_WIDTH - TOOTH_CARD_INSET * 2}
                    height={24}
                    rx={3}
                    fill="transparent"
                    role="button"
                    tabIndex={0}
                    aria-label={t('periodonto.pieza.seleccionarAria', {
                      pieza: tooth.fdi,
                      estado: estado ?? t('periodonto.pieza.presente'),
                    })}
                    aria-pressed={esActiva}
                    className="cursor-pointer outline-none focus-visible:fill-[rgba(124,58,237,0.12)]"
                    onClick={() => onSelectTooth?.(tooth.fdi)}
                    onKeyDown={(event: KeyboardEvent<SVGRectElement>) => {
                      if (event.key !== 'Enter' && event.key !== ' ') return;
                      event.preventDefault();
                      onSelectTooth?.(tooth.fdi);
                    }}
                  />
                )}
                {/* Movilidad: se cicla tocando la insignia M. */}
                {!readOnly && !tooth.missing && !tooth.implant ? (
                  <g
                    role="button"
                    tabIndex={0}
                    aria-label={t('periodonto.pieza.movilidadAria', {
                      pieza: tooth.fdi,
                      grado: mobilityLabel(tooth.mobility),
                    })}
                    className="cursor-pointer outline-none focus-visible:opacity-70"
                    onClick={() => onCycleMobility?.(tooth.fdi)}
                    onKeyDown={(event: KeyboardEvent<SVGGElement>) => {
                      if (event.key !== 'Enter' && event.key !== ' ') return;
                      event.preventDefault();
                      onCycleMobility?.(tooth.fdi);
                    }}
                  >
                    <rect
                      x={toothIndex * TOOTH_COLUMN_WIDTH + TOOTH_CARD_INSET + 21}
                      y={stripTopY + 13}
                      width={TOOTH_COLUMN_WIDTH - TOOTH_CARD_INSET * 2 - 21}
                      height={10}
                      rx={1.5}
                      fill={palette.surface}
                      stroke={palette.border}
                      strokeWidth={0.6}
                    />
                    <text
                      x={toothIndex * TOOTH_COLUMN_WIDTH + TOOTH_CARD_INSET + 30}
                      y={stripTopY + 20.8}
                      textAnchor="middle"
                      fontSize={6.2}
                      fontWeight={600}
                      style={{ fill: palette.ink }}
                    >
                      {movilidad === null
                        ? t('periodonto.movilidad.cortaSin')
                        : t('periodonto.movilidad.corta', { grado: movilidad })}
                    </text>
                  </g>
                ) : null}
                {/* Furcas: una entrada por triángulo, con su grado. */}
                {!tooth.missing &&
                  (tooth.implant ? [] : furcationEntrancesFor(tooth.fdi)).map((entrance) => {
                    const punto = furcationMarkerPosition(arch, toothIndex, entrance);
                    const grado = tooth.furcation[entrance];
                    const etiqueta = t('periodonto.pieza.furcaAria', {
                      pieza: tooth.fdi,
                      entrada: furcationEntranceLabel(entrance).toLowerCase(),
                      grado: furcationLabel(grado ?? null),
                    });
                    if (readOnly) {
                      return (
                        <FurcationTriangle
                          key={`furca-${entrance}`}
                          x={punto.x}
                          y={punto.y}
                          grade={grado}
                          color={palette.ink}
                        />
                      );
                    }
                    return (
                      <g
                        key={`furca-${entrance}`}
                        role="button"
                        tabIndex={0}
                        aria-label={etiqueta}
                        className="cursor-pointer outline-none focus-visible:opacity-70"
                        onClick={() => onCycleFurcation?.(tooth.fdi, entrance)}
                        onKeyDown={(event: KeyboardEvent<SVGGElement>) => {
                          if (event.key !== 'Enter' && event.key !== ' ') return;
                          event.preventDefault();
                          onCycleFurcation?.(tooth.fdi, entrance);
                        }}
                      >
                        <FurcationTriangle
                          x={punto.x}
                          y={punto.y}
                          grade={grado}
                          color={palette.ink}
                        />
                        <rect
                          x={punto.x - 7}
                          y={punto.y - 7}
                          width={14}
                          height={14}
                          fill="transparent"
                        />
                      </g>
                    );
                  })}
              </g>
            );
          })}
        </g>
      </svg>
    </figure>
  );
};

/** Arcada memoizada (ver comentario del componente). */
export const PeriodontogramArchSvg = memo(PeriodontogramArchSvgBase);

/** Ayuda para armar el mapa de sitios de la comparación desde el panel. */
export const siteKeyOf = comparisonSiteKey;

/** Nombres anatómicos cortos de los 6 sitios, para la tabla de la arcada. */
export const faceSiteShortNames = (
  tooth: PeriodontalTooth,
  side: PeriodontalSide,
): readonly [string, string, string] => [
  siteShortName(tooth.fdi, side, 0),
  siteShortName(tooth.fdi, side, 1),
  siteShortName(tooth.fdi, side, 2),
];

/** Nombre de la cara según la arcada (para los encabezados del gráfico). */
export const faceName = sideName;
