import { useCallback, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

import type {
  FurcationEntrance,
  PeriodontalDiagnosis,
  PeriodontalExamDetail,
  PeriodontalRiskFactors,
} from '@odontocrm/contracts';

import {
  applyPeriodontalDigit,
  applyPeriodontalMillimeters,
  applySuggestedDiagnosis,
  clearActiveSite,
  cycleFurcation,
  cycleMobility as cycleMobilityAction,
  initialPeriodontalState,
  movePeriodontalCursor,
  selectPeriodontalSite,
  selectPeriodontalTooth,
  setAutoAdvance,
  setDiagnosis,
  setExamNotes,
  setPeriodontalExamDate,
  setPeriodontalField,
  setRiskFactors,
  toggleFaceFlag,
  toggleGmSign,
  toggleImplantTooth,
  toggleMissingTooth,
  toggleSiteFlag,
  type PeriodontalChartState,
  type PeriodontalControllerState,
  type PeriodontalField,
  type PeriodontalNavDirection,
  type PeriodontalSiteFlag,
  type PendingPeriodontalDigit,
} from './controller';

/**
 * Envoltorio React del controlador puro del periodontograma: estado, **deshacer** y
 * el mapeo del **teclado físico** como método secundario.
 *
 * Toda la lógica clínica sigue en `controller.ts` (probada sin navegador); este hook
 * solo le pone memoria y traduce teclas. Así el pad táctil, el SVG, la tabla y el
 * teclado disparan exactamente las mismas acciones.
 *
 * Atajos (documentados en el pad):
 * - `0–9`: escribe los milímetros en el sitio activo; dos dígitos seguidos dentro de
 *   la ventana de composición escriben la decena (`1`+`2` → 12 mm).
 * - Flechas: izquierda/derecha dentro de la cara; arriba/abajo cambia de cara.
 * - `Tab` / `Shift+Tab`: sitio siguiente/anterior (solo cuando el foco está en el
 *   grupo del pad, para no secuestrar la navegación por controles).
 * - `B` BOP, `P` placa, `S` supuración (en el sitio activo).
 * - `M` movilidad, `F` furca de la pieza activa.
 * - `+`/`-`: signo del margen; `Supr`/`Retroceso`: deja el sitio sin dato.
 * - `Ctrl+Z` / `Cmd+Z`: deshacer.
 */

/** Cuántos cambios se pueden deshacer hacia atrás. */
export const MAX_PERIODONTAL_UNDO = 40;

/** Opciones del escucha de teclado del pad. */
export interface PeriodontalKeyboardOptions {
  /** `true` cuando el foco está en el propio grupo del pad (habilita Tab como avance). */
  containerFocused?: boolean;
}

/** Resultado del hook: estado y acciones semánticas para pad, SVG y tabla. */
export interface UsePeriodontalControllerResult {
  state: PeriodontalControllerState | null;
  canUndo: boolean;
  /** Carga un examen: el estado local pasa a ser editable. */
  reset: (detail: PeriodontalExamDetail) => void;
  selectSite: (
    fdi: number,
    side: PeriodontalControllerState['cursor']['side'],
    siteIndex: 0 | 1 | 2,
  ) => void;
  selectTooth: (fdi: number) => void;
  setField: (field: PeriodontalField) => void;
  setAutoAdvanceMode: (autoAdvance: boolean) => void;
  applyMillimeters: (value: number) => void;
  toggleFlag: (flag: PeriodontalSiteFlag) => void;
  toggleFace: (flag: PeriodontalSiteFlag) => void;
  toggleSign: () => void;
  cycleMobility: (fdi?: number) => void;
  cycleFurcation: (fdi?: number, entrance?: FurcationEntrance) => void;
  toggleMissing: (fdi?: number) => void;
  toggleImplant: (fdi?: number) => void;
  clearSite: () => void;
  undo: () => void;
  move: (direction: PeriodontalNavDirection) => void;
  setExamDate: (examDate: string) => void;
  setRiskFactors: (riskFactors: PeriodontalRiskFactors) => void;
  setDiagnosis: (diagnosis: PeriodontalDiagnosis | null) => void;
  setNotes: (notes: string | null) => void;
  applySuggestion: () => void;
  /** Teclado físico (método secundario); se engancha al grupo del pad. */
  handleKeyDown: (
    event: ReactKeyboardEvent<HTMLElement>,
    options?: PeriodontalKeyboardOptions,
  ) => void;
}

/** `true` si el objetivo es un campo donde el usuario escribe: ahí no hay atajos. */
const esCampoDeTexto = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
};

/** Atajos de una sola tecla que conmutan un flag del sitio activo. */
const FLAG_KEYS: Readonly<Record<string, PeriodontalSiteFlag>> = {
  b: 'bop',
  p: 'plaque',
  s: 'suppuration',
};

export const usePeriodontalController = (): UsePeriodontalControllerResult => {
  const [state, setState] = useState<PeriodontalControllerState | null>(null);
  const [history, setHistory] = useState<readonly PeriodontalControllerState[]>([]);
  // El estado vigente también en una referencia: las acciones se llaman desde
  // eventos y necesitan el valor actual sin depender del cierre del render.
  const stateRef = useRef<PeriodontalControllerState | null>(null);
  stateRef.current = state;
  /** Primer dígito a la espera de una decena (`1`+`2` → 12 mm). */
  const digitRef = useRef<PendingPeriodontalDigit | null>(null);

  /** Aplica una acción pura apilando el estado anterior para deshacer. */
  const commit = useCallback(
    (action: (prev: PeriodontalControllerState) => PeriodontalControllerState): void => {
      const current = stateRef.current;
      if (current === null) return;
      const next = action(current);
      if (next === current) return;
      setHistory((stack) => [...stack.slice(-(MAX_PERIODONTAL_UNDO - 1)), current]);
      stateRef.current = next;
      setState(next);
    },
    [],
  );

  const reset = useCallback((detail: PeriodontalExamDetail): void => {
    const next = initialPeriodontalState(detail);
    digitRef.current = null;
    stateRef.current = next;
    setState(next);
    setHistory([]);
  }, []);

  const selectSite = useCallback<UsePeriodontalControllerResult['selectSite']>(
    (fdi, side, siteIndex) => {
      commit((prev) => selectPeriodontalSite(prev, fdi, side, siteIndex));
    },
    [commit],
  );

  const selectTooth = useCallback(
    (fdi: number) => commit((prev) => selectPeriodontalTooth(prev, fdi)),
    [commit],
  );

  const setField = useCallback(
    (field: PeriodontalField) => commit((prev) => setPeriodontalField(prev, field)),
    [commit],
  );

  const setAutoAdvanceMode = useCallback(
    (autoAdvance: boolean) => commit((prev) => setAutoAdvance(prev, autoAdvance)),
    [commit],
  );

  const applyMillimeters = useCallback(
    (value: number) => commit((prev) => applyPeriodontalMillimeters(prev, value)),
    [commit],
  );

  const toggleFlag = useCallback(
    (flag: PeriodontalSiteFlag) => commit((prev) => toggleSiteFlag(prev, flag)),
    [commit],
  );

  const toggleFace = useCallback(
    (flag: PeriodontalSiteFlag) => commit((prev) => toggleFaceFlag(prev, flag)),
    [commit],
  );

  const toggleSign = useCallback(() => commit((prev) => toggleGmSign(prev)), [commit]);

  const cycleMobility = useCallback(
    (fdi?: number) => commit((prev) => cycleMobilityAction(prev, fdi)),
    [commit],
  );

  const cycleFurcationAction = useCallback(
    (fdi?: number, entrance?: FurcationEntrance) =>
      commit((prev) => cycleFurcation(prev, fdi, entrance)),
    [commit],
  );

  const toggleMissing = useCallback(
    (fdi?: number) => commit((prev) => toggleMissingTooth(prev, fdi)),
    [commit],
  );

  const toggleImplant = useCallback(
    (fdi?: number) => commit((prev) => toggleImplantTooth(prev, fdi)),
    [commit],
  );

  const clearSite = useCallback(() => commit((prev) => clearActiveSite(prev)), [commit]);

  const undo = useCallback((): void => {
    setHistory((stack) => {
      const previous = stack[stack.length - 1];
      if (previous === undefined) return stack;
      stateRef.current = previous;
      setState(previous);
      return stack.slice(0, -1);
    });
  }, []);

  const move = useCallback(
    (direction: PeriodontalNavDirection) =>
      commit((prev) => movePeriodontalCursor(prev, direction)),
    [commit],
  );

  const setExamDate = useCallback(
    (examDate: string) => commit((prev) => setPeriodontalExamDate(prev, examDate)),
    [commit],
  );

  const setRiskFactorsAction = useCallback(
    (riskFactors: PeriodontalRiskFactors) => commit((prev) => setRiskFactors(prev, riskFactors)),
    [commit],
  );

  const setDiagnosisAction = useCallback(
    (diagnosis: PeriodontalDiagnosis | null) => commit((prev) => setDiagnosis(prev, diagnosis)),
    [commit],
  );

  const setNotes = useCallback(
    (notes: string | null) => commit((prev) => setExamNotes(prev, notes)),
    [commit],
  );

  const applySuggestion = useCallback(
    () => commit((prev) => applySuggestedDiagnosis(prev)),
    [commit],
  );

  const handleKeyDown = useCallback<UsePeriodontalControllerResult['handleKeyDown']>(
    (event, options = {}) => {
      if (event.defaultPrevented) return;
      if (esCampoDeTexto(event.target)) return;

      const meta = event.ctrlKey || event.metaKey;
      if (meta) {
        // Deshacer es lo único con modificador: el resto de `Ctrl+X` es del navegador.
        if (event.key.toLowerCase() === 'z') {
          event.preventDefault();
          undo();
        }
        return;
      }
      if (event.altKey) return;

      // Teclas de una sola pulsación sobre el sitio activo.
      const tecla = event.key;
      if (/^[0-9]$/.test(tecla)) {
        event.preventDefault();
        const actual = stateRef.current;
        if (actual === null) return;
        const resultado = applyPeriodontalDigit(
          actual,
          Number.parseInt(tecla, 10),
          digitRef.current,
          Date.now(),
        );
        digitRef.current = resultado.pending;
        commit(() => resultado.state);
        return;
      }

      const flag = FLAG_KEYS[tecla.toLowerCase()];
      if (flag !== undefined) {
        event.preventDefault();
        toggleFlag(flag);
        return;
      }

      switch (tecla) {
        case 'ArrowRight':
          event.preventDefault();
          move('right');
          return;
        case 'ArrowLeft':
          event.preventDefault();
          move('left');
          return;
        case 'ArrowUp':
          event.preventDefault();
          move('up');
          return;
        case 'ArrowDown':
          event.preventDefault();
          move('down');
          return;
        case 'Tab':
          // Solo se secuestra cuando el foco está en el propio grupo del pad: si no,
          // Tab tiene que seguir recorriendo controles (accesibilidad).
          if (options.containerFocused === true) {
            event.preventDefault();
            move(event.shiftKey ? 'previous' : 'next');
          }
          return;
        case 'Delete':
        case 'Backspace':
          event.preventDefault();
          clearSite();
          return;
        case '+':
        case '-':
          // El signo es del margen: en la PS no cambia nada y sería un atajo engañoso.
          if (stateRef.current?.cursor.field !== 'gm') return;
          event.preventDefault();
          toggleSign();
          return;
        default:
          break;
      }

      if (tecla.toLowerCase() === 'm') {
        event.preventDefault();
        commit((prev) => cycleMobilityAction(prev));
        return;
      }
      if (tecla.toLowerCase() === 'f') {
        event.preventDefault();
        commit((prev) => cycleFurcation(prev));
      }
    },
    [clearSite, commit, move, toggleFlag, toggleSign, undo],
  );

  return {
    state,
    canUndo: history.length > 0,
    reset,
    selectSite,
    selectTooth,
    setField,
    setAutoAdvanceMode,
    applyMillimeters,
    toggleFlag,
    toggleFace,
    toggleSign,
    cycleMobility,
    cycleFurcation: cycleFurcationAction,
    toggleMissing,
    toggleImplant,
    clearSite,
    undo,
    move,
    setExamDate,
    setRiskFactors: setRiskFactorsAction,
    setDiagnosis: setDiagnosisAction,
    setNotes,
    applySuggestion,
    handleKeyDown,
  };
};

/** Estado mínimo que el panel guarda para detectar cambios sin guardar. */
export type { PeriodontalChartState };
