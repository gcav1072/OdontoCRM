import {
  REPORT_DESCRIPTIONS,
  REPORT_LABELS,
  REPORT_ORDER,
  type ReportKey,
} from '@odontocrm/contracts';
import { Button, cn } from '@odontocrm/ui';
import { useRef, type KeyboardEvent } from 'react';

import { t } from '../../lib/i18n';

/** Identificadores del patrón `tab`/`tabpanel`: los comparte la página. */
export const reportTabId = (key: ReportKey): string => `reporte-pestana-${key}`;
export const reportPanelId = (key: ReportKey): string => `reporte-panel-${key}`;

export interface ReportTabsProps {
  /** Reportes que el rol puede abrir, en el orden del contrato. */
  keys: readonly ReportKey[];
  /**
   * Reportes que existen pero el rol no puede ver (los clínicos sin
   * `reports:clinical`). Se pintan deshabilitados con la explicación en el
   * `title` y en el aviso de la página: esconderlos del todo dejaría a la
   * secretaría sin saber que el sistema los tiene.
   */
  blockedKeys?: readonly ReportKey[];
  active: ReportKey;
  onSelect: (key: ReportKey) => void;
  className?: string;
}

/**
 * Pestañas de reportes. No hay `Tabs` en `@odontocrm/ui`, así que se arma con
 * botones y el patrón ARIA completo (`tablist`/`tab`, `aria-selected`,
 * `aria-controls`) con la navegación por teclado que espera un tablist: flechas
 * para moverse, Inicio y Fin para los extremos, y un solo tabulador activo.
 */
export const ReportTabs = ({
  keys,
  blockedKeys = [],
  active,
  onSelect,
  className,
}: ReportTabsProps) => {
  const botones = useRef<Array<HTMLButtonElement | null>>([]);

  const visibles = new Set(keys);
  const bloqueadas = new Set(blockedKeys);
  // Se recorre el orden del contrato para que las bloqueadas queden en su sitio.
  const orden = REPORT_ORDER.filter((key) => visibles.has(key) || bloqueadas.has(key));

  const enfocar = (indice: number): void => {
    const clave = keys[indice];
    if (clave === undefined) return;
    onSelect(clave);
    botones.current[indice]?.focus();
  };

  const mover = (desde: number, salto: number): void => {
    if (keys.length === 0) return;
    enfocar((desde + salto + keys.length) % keys.length);
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
      enfocar(keys.length - 1);
    }
  };

  return (
    <div
      role="tablist"
      aria-label={t('reportes.pestanas.titulo')}
      aria-orientation="horizontal"
      className={cn('flex flex-wrap gap-2', className)}
    >
      {orden.map((key) => {
        if (!visibles.has(key)) {
          return (
            <Button
              key={key}
              variant="secondary"
              size="sm"
              disabled
              title={t('reportes.pestanas.clinicaBloqueada')}
            >
              {REPORT_LABELS[key]}
            </Button>
          );
        }

        const indice = keys.indexOf(key);
        const esActiva = key === active;

        return (
          <Button
            key={key}
            ref={(nodo) => {
              botones.current[indice] = nodo;
            }}
            role="tab"
            id={reportTabId(key)}
            aria-controls={reportPanelId(key)}
            aria-selected={esActiva}
            tabIndex={esActiva ? 0 : -1}
            variant={esActiva ? 'primary' : 'secondary'}
            size="sm"
            title={REPORT_DESCRIPTIONS[key]}
            onClick={() => onSelect(key)}
            onKeyDown={(event) => alTeclear(event, indice)}
          >
            {REPORT_LABELS[key]}
          </Button>
        );
      })}
    </div>
  );
};
