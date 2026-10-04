import type { ReportColumn, ReportTable as ReportTableData } from '@odontocrm/contracts';
import {
  EmptyState,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  cn,
} from '@odontocrm/ui';
import { Table2 } from 'lucide-react';

import { formatNumber } from '../../lib/format';
import { t } from '../../lib/i18n';
import { formattedCell } from '../../lib/reports';

export interface ReportTableProps {
  /** Encabezado de la sección (ya traducido). */
  title?: string;
  table: ReportTableData;
  /** Texto del `<caption>`: describe la tabla a quien usa lector de pantalla. */
  caption?: string;
  className?: string;
}

const esNumerica = (columna: ReportColumn): boolean =>
  columna.type === 'number' || columna.type === 'percent';

/**
 * Tabla del reporte. Es la misma para los seis reportes porque el contrato
 * declara las columnas y su tipo (`text`, `number`, `percent`, `date`): la
 * interfaz solo formatea cada celda, y lo que se ve es exactamente lo que sale
 * en el CSV (el servidor lo arma de esta misma tabla).
 *
 * Cuando la tabla viene recortada (un top N), el contrato lo dice en `total` y
 * aquí se avisa: un ranking sin su total se lee como si fuera la lista completa.
 */
export const ReportTable = ({ title, table, caption, className }: ReportTableProps) => {
  const filas = table.rows.length;
  const total = table.total;
  const recortada = total !== null && total > filas;

  if (filas === 0) {
    return (
      <div className={cn('space-y-3', className)}>
        {title !== undefined && <h3 className="text-sm font-semibold text-ink-muted">{title}</h3>}
        <EmptyState
          icon={<Table2 className="size-6" aria-hidden="true" />}
          title={t('reportes.tabla.vacioTitulo')}
          description={t('reportes.tabla.vacia')}
        />
      </div>
    );
  }

  return (
    <div className={cn('space-y-3', className)}>
      {title !== undefined && <h3 className="text-sm font-semibold text-ink-muted">{title}</h3>}

      <Table caption={caption}>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            {table.columns.map((columna) => (
              <TableHead
                key={columna.key}
                className={esNumerica(columna) ? 'text-right' : undefined}
              >
                {columna.label}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {table.rows.map((fila, indice) => (
            <TableRow key={indice}>
              {table.columns.map((columna) => (
                <TableCell
                  key={columna.key}
                  className={esNumerica(columna) ? 'text-right tabular-nums' : 'text-ink-muted'}
                >
                  {formattedCell(fila[columna.key] ?? null, columna.type)}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {recortada && total !== null && (
        <p className="text-xs text-ink-subtle">
          {t('reportes.tabla.recortada', {
            filas: formatNumber(filas),
            total: formatNumber(total),
          })}
        </p>
      )}
    </div>
  );
};
