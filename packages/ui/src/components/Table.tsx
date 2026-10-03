import type {
  HTMLAttributes,
  ReactNode,
  TableHTMLAttributes,
  TdHTMLAttributes,
  ThHTMLAttributes,
} from 'react';

import { cn } from '../lib/cn';

export interface TableProps extends TableHTMLAttributes<HTMLTableElement> {
  /** Contenedor con desplazamiento horizontal (tablas anchas en pantallas pequeñas). */
  containerClassName?: string;
  caption?: string;
}

export const Table = ({
  className,
  containerClassName,
  caption,
  children,
  ...rest
}: TableProps) => (
  <div
    className={cn(
      'w-full overflow-x-auto rounded-card border border-border bg-surface',
      containerClassName,
    )}
  >
    <table className={cn('w-full border-collapse text-sm text-ink', className)} {...rest}>
      {caption && (
        <caption className="px-4 py-2 text-left text-xs text-ink-subtle">{caption}</caption>
      )}
      {children}
    </table>
  </div>
);

export const TableHeader = ({ className, ...rest }: HTMLAttributes<HTMLTableSectionElement>) => (
  <thead className={cn('bg-surface-muted', className)} {...rest} />
);

export const TableBody = ({ className, ...rest }: HTMLAttributes<HTMLTableSectionElement>) => (
  <tbody className={cn('divide-y divide-border', className)} {...rest} />
);

export const TableFooter = ({ className, ...rest }: HTMLAttributes<HTMLTableSectionElement>) => (
  <tfoot className={cn('border-t border-border bg-surface-muted', className)} {...rest} />
);

export const TableRow = ({ className, ...rest }: HTMLAttributes<HTMLTableRowElement>) => (
  <tr className={cn('transition-colors hover:bg-surface-muted/60', className)} {...rest} />
);

export const TableHead = ({ className, ...rest }: ThHTMLAttributes<HTMLTableCellElement>) => (
  <th
    scope="col"
    className={cn(
      'px-4 py-2.5 text-left text-xs font-semibold tracking-wide text-ink-muted uppercase whitespace-nowrap',
      className,
    )}
    {...rest}
  />
);

export const TableCell = ({ className, ...rest }: TdHTMLAttributes<HTMLTableCellElement>) => (
  <td className={cn('px-4 py-3 align-middle', className)} {...rest} />
);

export interface TableEmptyProps {
  colSpan: number;
  children: ReactNode;
}

/** Fila para cuando la consulta no devuelve resultados. */
export const TableEmpty = ({ colSpan, children }: TableEmptyProps) => (
  <tr>
    <td colSpan={colSpan} className="px-4 py-10 text-center text-sm text-ink-muted">
      {children}
    </td>
  </tr>
);
