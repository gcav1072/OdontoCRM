import {
  CLINICAL_STATE_COLORS,
  CONDITION_LABELS,
  QUICK_CONDITION_KEYS,
  QUICK_SURFACE_KEYS,
  initialQuickEntryState,
  quickEntryKey,
  quickEntryLabel,
  SURFACE_LABELS,
  surfaceLabelFor,
} from '@odontocrm/contracts';
import type {
  OdontogramDetail,
  OdontogramMutationResult,
  QuickEntryIntent,
  QuickEntryState,
  ToothCondition,
} from '@odontocrm/contracts';
import { Badge, Button, Spinner } from '@odontocrm/ui';
import { Eraser, Keyboard } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';

import { findingsForTooth, odontogramApi } from '../../lib/odontogram-api';
import { t } from '../../lib/i18n';
import { findingLabel, conditionSurfaceLabel } from './GeometricTooth';

/**
 * Barra de carga rápida: la boca entera en menos de 30 segundos.
 *
 * Aquí no hay reglas clínicas: la máquina de teclado vive en el contrato
 * (`quickEntryKey`) y es pura. Esta barra solo la alimenta, ejecuta la petición
 * que devuelve (`record` / `delete` / `clear`) y pinta el estado.
 *
 * Dos detalles que hacen que se pueda teclear rápido de verdad:
 *  - las peticiones se **encolan** (una detrás de otra): si se dispararan a la
 *    vez, la respuesta de una pulsación antigua podría llegar después y pisar el
 *    gráfico con datos viejos;
 *  - las teclas se ignoran cuando el foco está en un campo de texto o cuando hay
 *    un modificador pulsado (`Ctrl+R` recarga la página, no pone una corona).
 */

/** Los tres intents que acaban en una llamada a la API. */
export type QuickEntryAction = Extract<QuickEntryIntent, { kind: 'record' | 'delete' | 'clear' }>;

/** Una tecla de condición con sus dos variantes (minúscula y mayúscula). */
interface ConditionShortcut {
  condition: ToothCondition;
  keys: readonly string[];
}

/** Agrupa `c`/`C` en una sola fila de la ayuda de teclas. */
const CONDITION_SHORTCUTS: readonly ConditionShortcut[] = (() => {
  const porCondicion = new Map<ToothCondition, string[]>();
  for (const [key, condition] of Object.entries(QUICK_CONDITION_KEYS)) {
    const teclas = porCondicion.get(condition) ?? [];
    teclas.push(key);
    porCondicion.set(condition, teclas);
  }
  return [...porCondicion].map(([condition, keys]) => ({ condition, keys }));
})();

/** `true` si el foco está en algo donde se escribe: ahí el teclado es del usuario. */
const esCampoDeTexto = (objetivo: EventTarget | null): boolean => {
  if (!(objetivo instanceof HTMLElement)) return false;
  if (objetivo.isContentEditable) return true;
  return (
    objetivo.tagName === 'INPUT' || objetivo.tagName === 'TEXTAREA' || objetivo.tagName === 'SELECT'
  );
};

/** Descripción de una acción ya aplicada, para el aviso y para deshacer. */
export const describeAction = (action: QuickEntryAction): string => {
  switch (action.kind) {
    case 'record':
      return t('odonto.accion.hallazgo', {
        pieza: action.input.toothNumber,
        detalle: findingLabel(
          {
            surface: action.input.surface,
            condition: action.input.condition,
            state: action.input.state,
          },
          // La pieza va delante para que el aviso diga «caries incisal» en el 11 y no
          // «oclusal»: es el mismo nombre que enseñan la tabla y el papel.
          action.input.toothNumber,
        ),
      });
    case 'delete':
      return t('odonto.accion.borrado', {
        pieza: action.input.toothNumber,
        detalle: conditionSurfaceLabel(
          action.input.condition,
          action.input.surface,
          action.input.toothNumber,
        ),
      });
    case 'clear':
      return t('odonto.accion.limpieza', {
        pieza: action.input.toothNumber,
        cara: surfaceLabelFor(action.input.toothNumber, action.input.surface).toLowerCase(),
      });
  }
};

/** Tecla dibujada como tal, para la ayuda y la etiqueta del estado. */
const Tecla = ({ children }: { children: ReactNode }) => (
  <kbd className="rounded border border-border-strong bg-surface px-1.5 py-0.5 font-mono text-[0.68rem] text-ink">
    {children}
  </kbd>
);

export interface QuickEntryBarProps {
  patientId: string;
  /** Odontograma vigente: sirve para enseñar lo que ya tiene la pieza activa. */
  detail: OdontogramDetail | null;
  /** Estado de la máquina; lo guarda el panel para que el gráfico marque la pieza. */
  state: QuickEntryState;
  onStateChange: (state: QuickEntryState) => void;
  /** Una mutación se aplicó: el panel actualiza la caché y apila el deshacer. */
  onApplied: (result: OdontogramMutationResult, action: QuickEntryAction) => void;
  onError: (error: unknown) => void;
  /** Peticiones en vuelo: el panel bloquea «deshacer» mientras haya alguna. */
  onPendingChange?: (pendientes: number) => void;
  onCancel?: () => void;
  /** Cambia de valor para pedir el foco (al pulsar una pieza del gráfico). */
  focusSignal?: number;
}

export const QuickEntryBar = ({
  patientId,
  detail,
  state,
  onStateChange,
  onApplied,
  onError,
  onPendingChange,
  onCancel,
  focusSignal = 0,
}: QuickEntryBarProps) => {
  const contenedor = useRef<HTMLDivElement>(null);
  const cola = useRef<Promise<void>>(Promise.resolve());
  const enVuelo = useRef(0);
  const [guardando, setGuardando] = useState(0);

  // El teclado es el protagonista: al abrir la pestaña (y cada vez que se pulsa
  // una pieza en el gráfico) el foco vuelve aquí para poder encadenar teclas.
  useEffect(() => {
    contenedor.current?.focus({ preventScroll: true });
  }, [focusSignal]);

  const ejecutar = async (intent: QuickEntryAction): Promise<void> => {
    try {
      if (intent.kind === 'record') {
        onApplied(await odontogramApi.recordFinding(patientId, intent.input), intent);
      } else if (intent.kind === 'delete') {
        onApplied(await odontogramApi.removeFinding(patientId, intent.input), intent);
      } else {
        onApplied(await odontogramApi.clearSurface(patientId, intent.input), intent);
      }
    } catch (fallo) {
      onError(fallo);
    }
  };

  const encolar = (intent: QuickEntryAction): void => {
    enVuelo.current += 1;
    setGuardando(enVuelo.current);
    onPendingChange?.(enVuelo.current);

    cola.current = cola.current
      .then(() => ejecutar(intent))
      .finally(() => {
        enVuelo.current -= 1;
        setGuardando(enVuelo.current);
        onPendingChange?.(enVuelo.current);
      });
  };

  const alTeclear = (event: KeyboardEvent<HTMLDivElement>): void => {
    // Los atajos del navegador no son hallazgos clínicos.
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (esCampoDeTexto(event.target)) return;
    // Una tecla mantenida dispararía decenas de peticiones: la carga rápida es a
    // pulsación limpia.
    if (event.repeat) return;

    const { state: siguiente, intent } = quickEntryKey(state, event.key);
    // Si la tecla no era nuestra se deja pasar tal cual (no se secuestra el navegador).
    if (intent.kind === 'ignored') return;

    event.preventDefault();
    onStateChange(siguiente);

    if (intent.kind === 'cancel') {
      onCancel?.();
      return;
    }
    if (intent.kind === 'state') return;

    encolar(intent);
  };

  const etiqueta = quickEntryLabel(state);
  const hallazgos = state.toothNumber === null ? [] : findingsForTooth(detail, state.toothNumber);

  const limpiar = (): void => {
    onStateChange(initialQuickEntryState());
    onCancel?.();
    contenedor.current?.focus({ preventScroll: true });
  };

  return (
    <div
      ref={contenedor}
      tabIndex={0}
      role="group"
      aria-label={t('odonto.rapida.titulo')}
      onKeyDown={alTeclear}
      className="rounded-card border border-border bg-surface-muted/60 p-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-focus"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-sm font-medium text-ink">
          <Keyboard className="size-4 text-primary" aria-hidden />
          {t('odonto.rapida.titulo')}
        </p>
        <div className="flex items-center gap-2">
          {guardando > 0 && (
            <span className="inline-flex items-center gap-2 text-xs text-ink-muted">
              <Spinner size="sm" />
              {t('comun.guardando')}
            </span>
          )}
          <Button
            variant="ghost"
            size="sm"
            leadingIcon={<Eraser className="size-4" aria-hidden />}
            onClick={limpiar}
          >
            {t('comun.limpiar')}
          </Button>
        </div>
      </div>

      <p className="mt-1 text-xs text-ink-subtle">{t('odonto.rapida.ayuda')}</p>

      <div className="mt-3 rounded-control border border-border-strong bg-surface px-3 py-2.5">
        <p aria-live="polite" className="font-mono text-lg font-semibold text-ink">
          {etiqueta === '' ? (
            <span className="font-sans text-sm font-normal text-ink-subtle">
              {t('odonto.rapida.placeholder')}
            </span>
          ) : (
            etiqueta
          )}
        </p>

        {state.toothNumber !== null && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {state.surfaces.length === 0 ? (
              <span className="text-xs text-ink-muted">{t('odonto.rapida.sinCaras')}</span>
            ) : (
              state.surfaces.map((surface) => (
                <Badge key={surface} variant="primary">
                  {state.toothNumber === null
                    ? SURFACE_LABELS[surface]
                    : surfaceLabelFor(state.toothNumber, surface)}
                </Badge>
              ))
            )}
          </div>
        )}

        {state.toothNumber !== null && (
          <p className="mt-1.5 text-xs text-ink-subtle">
            {hallazgos.length === 0
              ? t('odonto.rapida.piezaSana', { pieza: state.toothNumber })
              : t('odonto.rapida.piezaTiene', {
                  pieza: state.toothNumber,
                  detalle: hallazgos.map(findingLabel).join('; '),
                })}
          </p>
        )}
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div>
          <p className="text-xs font-medium text-ink-muted">{t('odonto.rapida.condiciones')}</p>
          <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1.5 text-xs text-ink-muted">
            {CONDITION_SHORTCUTS.map(({ condition, keys }) => (
              <li key={condition} className="flex items-center gap-1">
                {keys.map((key) => (
                  <Tecla key={key}>{key}</Tecla>
                ))}
                <span>{CONDITION_LABELS[condition]}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-subtle">
            <span className="flex items-center gap-1">
              <span
                className="inline-block size-2.5 rounded-full"
                style={{ backgroundColor: CLINICAL_STATE_COLORS.pendiente }}
                aria-hidden
              />
              {t('odonto.rapida.pendiente')}
            </span>
            <span className="flex items-center gap-1">
              <span
                className="inline-block size-2.5 rounded-full"
                style={{ backgroundColor: CLINICAL_STATE_COLORS.completado }}
                aria-hidden
              />
              {t('odonto.rapida.completado')}
            </span>
          </p>
        </div>

        <div>
          <p className="text-xs font-medium text-ink-muted">{t('odonto.rapida.caras')}</p>
          <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1.5 text-xs text-ink-muted">
            {Object.entries(QUICK_SURFACE_KEYS).map(([key, surface]) => (
              <li key={key} className="flex items-center gap-1">
                <Tecla>{key}</Tecla>
                {/*
                  La tecla es la misma para la cara de masticación, pero el nombre no:
                  en incisivos y caninos esa cara es el **borde incisal**.
                */}
                <span>
                  {surface === 'occlusal'
                    ? t('odonto.rapida.caraMasticacion')
                    : SURFACE_LABELS[surface]}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-subtle">
            <span className="flex items-center gap-1">
              <Tecla>Supr</Tecla>
              {t('odonto.rapida.suprimir')}
            </span>
            <span className="flex items-center gap-1">
              <Tecla>Retroceso</Tecla>
              {t('odonto.rapida.soltar')}
            </span>
            <span className="flex items-center gap-1">
              <Tecla>Esc</Tecla>
              {t('odonto.rapida.salir')}
            </span>
          </p>
        </div>
      </div>
    </div>
  );
};
