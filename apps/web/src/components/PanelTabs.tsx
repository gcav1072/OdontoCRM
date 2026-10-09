import { cn } from '@odontocrm/ui';
import { useRef, type KeyboardEvent, type ReactNode } from 'react';

/**
 * Identificadores del patrón `tab`/`tabpanel`: los comparte quien monta las pestañas.
 * Se exportan para que la página arme su `aria-controls` y `aria-labelledby` sin
 * inventar los ids a mano.
 */
export const panelTabId = (prefijo: string, key: string): string => `${prefijo}-pestana-${key}`;
export const panelPanelId = (prefijo: string, key: string): string => `${prefijo}-panel-${key}`;

export interface PanelTabDefinition<K extends string> {
  key: K;
  label: string;
  /** Contenido a la derecha del rótulo (un contador, una insignia…). */
  hint?: ReactNode;
  /** Pestaña todavía no disponible: se pinta deshabilitada. */
  disabled?: boolean;
}

export interface PanelTabsProps<K extends string> {
  /** Prefijo de los ids: distingue este tablist de otros de la aplicación. */
  idPrefix: string;
  /** Nombre accesible del conjunto de pestañas. */
  label: string;
  tabs: readonly PanelTabDefinition<K>[];
  active: K;
  onSelect: (key: K) => void;
  className?: string;
}

/**
 * Pestañas de una página: cambian la sección visible sin recargar ni navegar.
 *
 * No hay `Tabs` en `@odontocrm/ui`, así que se arma con botones y el patrón ARIA
 * completo (`tablist`/`tab` con `aria-selected`, `aria-controls` y `aria-labelledby`)
 * y la navegación por teclado que espera un tablist: flechas para moverse, Inicio y
 * Fin para los extremos, y un único tabulador activo (roving tabindex).
 */
export const PanelTabs = <K extends string>({
  idPrefix,
  label,
  tabs,
  active,
  onSelect,
  className,
}: PanelTabsProps<K>) => {
  const botones = useRef<Array<HTMLButtonElement | null>>([]);

  const enfocar = (indice: number): void => {
    const tab = tabs[indice];
    if (tab === undefined) return;
    onSelect(tab.key);
    botones.current[indice]?.focus();
  };

  const mover = (desde: number, salto: number): void => {
    if (tabs.length === 0) return;
    enfocar((desde + salto + tabs.length) % tabs.length);
  };

  const alTeclear = (event: KeyboardEvent<HTMLButtonElement>, indice: number): void => {
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault();
      mover(indice, 1);
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault();
      mover(indice, -1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      enfocar(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      enfocar(tabs.length - 1);
    }
  };

  return (
    <div
      role="tablist"
      aria-label={label}
      aria-orientation="horizontal"
      className={cn('flex flex-wrap gap-1 border-b border-border', className)}
    >
      {tabs.map((tab, indice) => {
        const esActiva = tab.key === active;
        return (
          <button
            key={tab.key}
            ref={(nodo) => {
              botones.current[indice] = nodo;
            }}
            type="button"
            role="tab"
            id={panelTabId(idPrefix, tab.key)}
            aria-controls={panelPanelId(idPrefix, tab.key)}
            aria-selected={esActiva}
            tabIndex={esActiva ? 0 : -1}
            disabled={tab.disabled}
            onClick={() => onSelect(tab.key)}
            onKeyDown={(event) => alTeclear(event, indice)}
            className={cn(
              '-mb-px flex items-center gap-2 border-b-2 px-4 py-2 text-sm font-medium transition-colors',
              'disabled:cursor-not-allowed disabled:opacity-55',
              esActiva
                ? 'border-primary text-primary'
                : 'border-transparent text-ink-muted hover:text-ink',
            )}
          >
            {tab.label}
            {tab.hint}
          </button>
        );
      })}
    </div>
  );
};
