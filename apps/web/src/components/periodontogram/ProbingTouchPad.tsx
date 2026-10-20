import {
  PERIODONTAL_SITE_INDEXES,
  furcationEntrancesFor,
  type FurcationEntrance,
  type PeriodontalSide,
  type PeriodontalSiteIndex,
} from '@odontocrm/contracts';
import { Switch } from '@odontocrm/ui';
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Minus,
  Plus,
  Trash2,
  Undo2,
  Wrench,
} from 'lucide-react';
import type { ReactNode } from 'react';

import { t } from '../../lib/i18n';

import {
  activeCalOf,
  activeSiteOf,
  activeToothOf,
  type PeriodontalControllerState,
  type PeriodontalField,
  type PeriodontalSiteFlag,
} from './controller';
import {
  furcationEntranceLabel,
  furcationLabel,
  faceSiteTexts,
  gmText,
  mobilityLabel,
  numberText,
  siteAnatomyName,
  siteShortName,
  siteFieldText,
  sideName,
} from './presentation';

/**
 * Pad táctil de sondaje: el corazón de la captura «touch-first».
 *
 * **No hay ni un `<input type="number">`**: los milímetros se tocan en un teclado
 * clínico de 0 a 12 (el 12 es «≥12» en la PS) y todo lo demás son botones de al
 * menos 44×44 px (los números, 56 px), con `touch-manipulation` para que la tablet no
 * retrase el toque. El teclado físico funciona como método secundario porque llama a
 * las mismas acciones del controlador.
 *
 * El auto-avance (**apagado por defecto**: se enciende en el propio pad) convierte la
 * captura de una arcada en una cadena de toques sin tener que buscar cada sitio. Los
 * sitios sin sondar se enseñan como «—»: el pad nunca inventa un 0.
 */

/** Teclas del teclado clínico: 0–11 directos y 12 como «≥12» en la PS. */
const NUMBER_KEYS: readonly number[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

export interface ProbingTouchPadProps {
  state: PeriodontalControllerState;
  canUndo: boolean;
  onSelectSite: (side: PeriodontalSide, siteIndex: PeriodontalSiteIndex) => void;
  /**
   * Cambia de pieza sin tocar el gráfico (la insignia del SVG y estas flechas son
   * los únicos caminos táctiles: los sitios del SVG miden ~13 px de ancho).
   */
  onPreviousTooth: () => void;
  onNextTooth: () => void;
  onField: (field: PeriodontalField) => void;
  onMillimeters: (value: number) => void;
  onToggleSign: () => void;
  onToggleFlag: (flag: PeriodicPadFlag) => void;
  onCycleMobility: () => void;
  onCycleFurcation: (entrance?: FurcationEntrance) => void;
  onToggleMissing: () => void;
  onToggleImplant: () => void;
  onClearSite: () => void;
  onUndo: () => void;
  onAutoAdvance: (autoAdvance: boolean) => void;
}

/** Alias local del flag para no arrastrar el nombre del controlador en la API del pad. */
export type PeriodicPadFlag = PeriodontalSiteFlag;

/** Botón grande del pad: garantiza el área táctil mínima por construcción. */
const PadButton = ({
  onClick,
  pressed,
  disabled,
  children,
  label,
  tone = 'neutral',
  className = '',
}: {
  onClick: () => void;
  pressed?: boolean;
  disabled?: boolean;
  children: ReactNode;
  label?: string;
  tone?: 'neutral' | 'primary' | 'danger' | 'success';
  className?: string;
}) => {
  const tones: Record<typeof tone, string> = {
    neutral: 'border-border bg-surface text-ink hover:bg-surface-muted',
    primary: 'border-primary bg-primary text-primary-ink hover:bg-primary-hover',
    danger: 'border-danger bg-danger/10 text-danger hover:bg-danger/20',
    success: 'border-success bg-success/10 text-success hover:bg-success/20',
  };
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled}
      className={`inline-flex min-h-11 min-w-11 touch-manipulation items-center justify-center gap-1.5 rounded-control border px-2 py-1 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-solid focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-45 ${tones[tone]} ${className}`}
    >
      {children}
    </button>
  );
};

export const ProbingTouchPad = ({
  state,
  canUndo,
  onSelectSite,
  onPreviousTooth,
  onNextTooth,
  onField,
  onMillimeters,
  onToggleSign,
  onToggleFlag,
  onCycleMobility,
  onCycleFurcation,
  onToggleMissing,
  onToggleImplant,
  onClearSite,
  onUndo,
  onAutoAdvance,
}: ProbingTouchPadProps) => {
  const tooth = activeToothOf(state);
  const site = activeSiteOf(state);
  const { cursor } = state;
  /** Los tres sitios de la cara activa; cada tarjeta lee el suyo. */
  const sites = cursor.side === 'vestibular' ? tooth?.vestibular : tooth?.lingual;
  const siteTexts = sites === undefined ? null : faceSiteTexts(sites, cursor.field);
  const editable = tooth !== null && !tooth.missing;
  const esMargen = cursor.field === 'gm';
  const entradasFurca =
    tooth === null || tooth.missing || tooth.implant ? [] : furcationEntrancesFor(tooth.fdi);

  /** Un número del teclado se desactiva si no cabe en el rango del canal. */
  const numeroDeshabilitado = (value: number): boolean => {
    if (!editable) return true;
    // En el margen positivo el máximo es +10; en recesión cabe hasta −15 y el 12
    // sigue siendo un valor real (no el «≥12» de la PS).
    if (!esMargen) return false;
    return !cursor.gmNegative && value > 10;
  };

  if (tooth === null) {
    return (
      <div
        data-periodontal-pad
        role="group"
        aria-label={t('periodonto.pad.titulo')}
        className="rounded-card border border-border bg-surface-muted/60 p-4 text-sm text-ink-muted"
      >
        {t('periodonto.pad.sinPiezas')}
      </div>
    );
  }

  return (
    <div
      data-periodontal-pad
      role="group"
      aria-label={t('periodonto.pad.titulo')}
      tabIndex={0}
      className="rounded-card border border-border bg-surface-muted/60 p-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-focus"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold text-ink">{t('periodonto.pad.titulo')}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Switch
            checked={cursor.autoAdvance}
            onChange={(event) => onAutoAdvance(event.target.checked)}
            label={t('periodonto.pad.autoAvance')}
            description={t('periodonto.pad.autoAvanceAyuda')}
          />
          <PadButton onClick={onUndo} disabled={!canUndo} label={t('periodonto.pad.deshacer')}>
            <Undo2 className="size-4" aria-hidden />
            <span className="hidden sm:inline">{t('periodonto.pad.deshacer')}</span>
          </PadButton>
        </div>
      </div>

      {/* Diente y cara activos, siempre visibles: el operador sabe dónde escribe. */}
      <div className="mt-3 rounded-control border border-border-strong bg-surface px-3 py-2.5">
        <p aria-live="polite" className="text-base font-semibold text-ink">
          {t('periodonto.pad.activo', {
            pieza: tooth.fdi,
            cara: sideName(tooth.fdi, cursor.side),
            sitio: siteAnatomyName(tooth.fdi, cursor.side, cursor.siteIndex),
          })}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-muted">
          <span>
            {t('periodonto.tabla.ps')}:{' '}
            <strong>{site === null ? t('comun.sinDato') : siteFieldText(site, 'pd')}</strong>
          </span>
          <span>
            {t('periodonto.tabla.mg')}:{' '}
            <strong>{site === null ? t('comun.sinDato') : gmText(site.gm)}</strong>
          </span>
          <span>
            {t('periodonto.tabla.nic')}: <strong>{numberText(activeCalOf(state))}</strong>
          </span>
        </div>
        {/* Cambio de pieza a mano: dos botones grandes, sin depender del SVG. */}
        <div className="mt-2 grid grid-cols-2 gap-2">
          <PadButton
            onClick={onPreviousTooth}
            label={t('periodonto.pad.piezaAnterior')}
            className="min-h-12 justify-center"
          >
            <ChevronLeft className="size-4" aria-hidden />
            <span className="text-xs">{t('periodonto.pad.piezaAnterior')}</span>
          </PadButton>
          <PadButton
            onClick={onNextTooth}
            label={t('periodonto.pad.piezaSiguiente')}
            className="min-h-12 justify-center"
          >
            <span className="text-xs">{t('periodonto.pad.piezaSiguiente')}</span>
            <ChevronRight className="size-4" aria-hidden />
          </PadButton>
        </div>
      </div>

      {/* Tres tarjetas de sitio: se tocan para cambiar de sitio sin buscar en el SVG.
          Cada tarjeta enseña **su** valor: leer el sitio activo en las tres era el
          bug que hacía que un 6 en DV se pintara también en V y en MV. */}
      <div className="mt-3 grid grid-cols-3 gap-2">
        {PERIODONTAL_SITE_INDEXES.map((index) => {
          const selected = cursor.siteIndex === index;
          const valor = siteTexts?.[index] ?? null;
          return (
            <button
              key={index}
              type="button"
              onClick={() => onSelectSite(cursor.side, index)}
              aria-pressed={selected}
              aria-label={t('periodonto.pad.sitioAria', {
                sitio: siteAnatomyName(tooth.fdi, cursor.side, index),
                valor: valor ?? t('comun.sinDato'),
                canal: esMargen ? t('periodonto.tabla.mg') : t('periodonto.tabla.ps'),
              })}
              className={`flex min-h-14 touch-manipulation flex-col items-center justify-center rounded-control border px-1 py-2 transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-solid focus-visible:outline-focus ${
                selected
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border bg-surface text-ink hover:bg-surface-muted'
              }`}
            >
              <span className="text-[0.68rem] font-semibold tracking-wide uppercase">
                {siteShortName(tooth.fdi, cursor.side, index)}
              </span>
              <span className="mt-0.5 font-mono text-lg leading-none font-semibold">
                {valor ?? t('comun.sinDato')}
              </span>
            </button>
          );
        })}
      </div>

      {/* Canal de captura: PS o MG. El signo solo tiene sentido en el margen. */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <PadButton
          onClick={() => onField('pd')}
          pressed={!esMargen}
          tone={!esMargen ? 'primary' : 'neutral'}
          label={t('periodonto.pad.psAria')}
        >
          {t('periodonto.pad.ps')}
        </PadButton>
        <PadButton
          onClick={() => onField('gm')}
          pressed={esMargen}
          tone={esMargen ? 'primary' : 'neutral'}
          label={t('periodonto.pad.mgAria')}
        >
          {t('periodonto.pad.mg')}
        </PadButton>
        <PadButton
          onClick={onToggleSign}
          disabled={!esMargen}
          pressed={cursor.gmNegative}
          label={t('periodonto.pad.signoAria')}
        >
          {cursor.gmNegative ? (
            <Minus className="size-4" aria-hidden />
          ) : (
            <Plus className="size-4" aria-hidden />
          )}
          <span className="text-xs">
            {cursor.gmNegative
              ? t('periodonto.pad.sigRecesion')
              : t('periodonto.pad.sigHiperplasia')}
          </span>
        </PadButton>
        <PadButton
          onClick={onClearSite}
          disabled={!editable}
          label={t('periodonto.pad.limpiarSitio')}
        >
          <Trash2 className="size-4" aria-hidden />
          <span className="text-xs">{t('periodonto.pad.limpiarSitio')}</span>
        </PadButton>
      </div>

      {/* Teclado numérico clínico: 0–12, con 12 = «≥12» en la PS. */}
      {/* Cuatro columnas en pantalla estrecha: siete columnas dejarían teclas de
         36 px, por debajo del mínimo táctil de 44 px. */}
      <div className="mt-3 grid grid-cols-4 gap-1.5 sm:grid-cols-7">
        {NUMBER_KEYS.map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => onMillimeters(value)}
            disabled={numeroDeshabilitado(value)}
            aria-label={
              value === 12 && !esMargen
                ? t('periodonto.pad.numeroMayorAria')
                : t('periodonto.pad.numeroAria', { valor: value })
            }
            className="min-h-14 touch-manipulation rounded-control border border-border-strong bg-surface font-mono text-lg font-semibold text-ink transition-colors hover:bg-primary/10 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-solid focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-45"
          >
            {value === 12 && !esMargen ? t('periodonto.pad.mayorOIgual12') : value}
          </button>
        ))}
      </div>

      {/* Flags del sitio activo: un toque, sin mover el cursor. */}
      <div className="mt-3 grid grid-cols-3 gap-2">
        {(
          [
            ['bop', t('periodonto.pad.bop'), site?.bop ?? false],
            ['plaque', t('periodonto.pad.placa'), site?.plaque ?? false],
            ['suppuration', t('periodonto.pad.supuracion'), site?.suppuration ?? false],
          ] as const
        ).map(([flag, etiqueta, activo]) => (
          <PadButton
            key={flag}
            onClick={() => onToggleFlag(flag)}
            pressed={activo}
            disabled={!editable}
            tone={activo ? 'danger' : 'neutral'}
            label={t('periodonto.pad.flagAria', {
              flag: etiqueta,
              estado: activo ? t('periodonto.pad.marcado') : t('periodonto.pad.sinMarcar'),
            })}
            className="flex-col gap-0.5"
          >
            <span className="text-xs font-semibold">{etiqueta}</span>
            <span className="text-[0.6rem] text-current/80">
              {activo ? t('periodonto.pad.marcado') : t('periodonto.pad.sinMarcar')}
            </span>
          </PadButton>
        ))}
      </div>

      {/* Pieza: movilidad, furcas y estado (ausente/implante). */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <PadButton
          onClick={onCycleMobility}
          disabled={!editable || tooth.implant}
          label={t('periodonto.pad.movilidadAria', { valor: mobilityLabel(tooth.mobility) })}
        >
          <span className="text-xs font-semibold">{t('periodonto.pad.movilidad')}</span>
          <span className="font-mono">{mobilityLabel(tooth.mobility)}</span>
        </PadButton>
        {entradasFurca.map((entrance) => (
          <PadButton
            key={entrance}
            onClick={() => onCycleFurcation(entrance)}
            label={t('periodonto.pad.furcaAria', {
              entrada: furcationEntranceLabel(entrance),
              valor: furcationLabel(tooth.furcation[entrance] ?? null),
            })}
          >
            <span className="text-xs font-semibold">{furcationEntranceLabel(entrance)}</span>
            <span className="font-mono">{furcationLabel(tooth.furcation[entrance] ?? null)}</span>
          </PadButton>
        ))}
        <PadButton
          onClick={onToggleMissing}
          pressed={tooth.missing}
          tone={tooth.missing ? 'danger' : 'neutral'}
          label={t('periodonto.pad.ausenteAria')}
        >
          <AlertTriangle className="size-4" aria-hidden />
          <span className="text-xs">{t('periodonto.pad.ausente')}</span>
        </PadButton>
        <PadButton
          onClick={onToggleImplant}
          pressed={tooth.implant}
          tone={tooth.implant ? 'primary' : 'neutral'}
          label={t('periodonto.pad.implanteAria')}
        >
          <Wrench className="size-4" aria-hidden />
          <span className="text-xs">{t('periodonto.pad.implante')}</span>
        </PadButton>
      </div>

      <p className="mt-3 text-[0.68rem] text-ink-subtle">{t('periodonto.pad.tecladoAyuda')}</p>
    </div>
  );
};
