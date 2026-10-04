import type { ReportKpi } from '@odontocrm/contracts';
import { Card, CardContent, cn } from '@odontocrm/ui';

import { formatNumber } from '../../lib/format';
import { kpiToneClass } from '../../lib/reports';

export interface ReportKpisProps {
  /** Encabezado de la fila de tarjetas (ya traducido). Si falta, solo se pintan las tarjetas. */
  title?: string;
  kpis: readonly ReportKpi[];
  className?: string;
}

/**
 * Tarjetas de KPI del reporte (y del resumen del día).
 *
 * El tono (`good`, `warn`, `bad`) lo decide el **contrato**, no la interfaz: la
 * tarjeta solo lo traduce a un color del tema, así una cifra preocupante
 * —inasistencias, cupos agotados— se lee de un vistazo.
 */
export const ReportKpis = ({ title, kpis, className }: ReportKpisProps) => {
  if (kpis.length === 0) return null;

  return (
    <div className={cn('space-y-3', className)}>
      {title !== undefined && <h3 className="text-sm font-semibold text-ink-muted">{title}</h3>}
      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {kpis.map((kpi, indice) => (
          <li key={`${kpi.label}-${String(indice)}`}>
            <Card className="h-full">
              <CardContent className="space-y-1 px-4 py-3.5">
                <p className="text-xs font-medium tracking-wide text-ink-subtle uppercase">
                  {kpi.label}
                </p>
                <p
                  className={cn(
                    'flex flex-wrap items-baseline gap-x-1 text-2xl font-semibold tabular-nums',
                    kpiToneClass(kpi.tone),
                  )}
                >
                  {typeof kpi.value === 'number' ? formatNumber(kpi.value) : kpi.value}
                  {kpi.unit !== null && kpi.unit !== '' && (
                    <span className="text-sm font-medium text-ink-muted">{kpi.unit}</span>
                  )}
                </p>
                {kpi.hint !== null && kpi.hint !== '' && (
                  <p className="text-xs text-ink-muted">{kpi.hint}</p>
                )}
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
};
