import type { ReactNode } from 'react';

/**
 * Lista de datos etiqueta → valor de la bandeja de notificaciones. Es
 * presentacional: el detalle de un envío, la vinculación y los diálogos la usan
 * para no repetir el marcado de `<dl>`.
 */
export interface DescriptionListProps {
  items: readonly (readonly [string, ReactNode])[];
  className?: string;
  /** Una sola columna cuando los valores son textos largos. */
  columns?: 1 | 2;
}

export const DescriptionList = ({ items, className, columns = 2 }: DescriptionListProps) => (
  <dl
    className={className ?? (columns === 2 ? 'grid gap-3 sm:grid-cols-2' : 'flex flex-col gap-3')}
  >
    {items.map(([etiqueta, valor]) => (
      <div key={etiqueta} className="min-w-0">
        <dt className="text-xs font-medium tracking-wide text-ink-subtle uppercase">{etiqueta}</dt>
        <dd className="break-words text-ink">{valor}</dd>
      </div>
    ))}
  </dl>
);
