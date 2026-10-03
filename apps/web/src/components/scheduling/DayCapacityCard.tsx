import type { DayView } from '@odontocrm/contracts';
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, cn } from '@odontocrm/ui';
import { GaugeCircle, Pencil } from 'lucide-react';

import { formatNumber } from '../../lib/format';
import { CAPACITY_SOURCE_LABELS, t } from '../../lib/i18n';

export interface DayCapacityCardProps {
  day: DayView;
  canWrite: boolean;
  onEdit: () => void;
}

const Contador = ({ etiqueta, valor }: { etiqueta: string; valor: number }) => (
  <div className="rounded-control border border-border bg-surface-muted px-3 py-2">
    <dt className="text-xs text-ink-subtle">{etiqueta}</dt>
    <dd className="text-lg font-semibold text-ink">{formatNumber(valor)}</dd>
  </div>
);

/**
 * Cupo y ocupación del día: contador grande `asignados/cupo`, procedencia del
 * cupo (`explicito` | `plantilla` | `defecto`), barra de ocupación, contadores
 * por estado y los avisos (día completo y el `warning` del servidor cuando el
 * cupo queda por debajo de lo asignado).
 */
export const DayCapacityCard = ({ day, canWrite, onEdit }: DayCapacityCardProps) => {
  const { capacity, counts } = day;
  const asignados = capacity.assigned;
  const cupo = capacity.capacity;
  const porcentaje = cupo <= 0 ? 100 : Math.min(100, Math.round((asignados / cupo) * 100));

  return (
    <Card>
      <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <CardTitle as="h2" className="flex items-center gap-2">
            <GaugeCircle className="size-4 text-primary" aria-hidden="true" />
            {t('programacion.cupo.titulo')}
          </CardTitle>
          <p className="pt-1 text-sm text-ink-muted">
            {t('programacion.cupo.procedencia', {
              fuente: CAPACITY_SOURCE_LABELS[capacity.source],
            })}
          </p>
        </div>
        {canWrite && (
          <Button
            variant="secondary"
            onClick={onEdit}
            leadingIcon={<Pencil className="size-4" aria-hidden="true" />}
          >
            {t('programacion.cupo.editar')}
          </Button>
        )}
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
          <p
            className="flex items-baseline gap-1"
            aria-label={t('programacion.cupo.contadorEtiqueta')}
          >
            <span
              className={cn(
                'text-4xl font-semibold tabular-nums',
                capacity.isFull ? 'text-danger' : 'text-ink',
              )}
            >
              {t('programacion.cupo.contador', { asignados, cupo })}
            </span>
            <span className="text-sm text-ink-muted">
              {t('programacion.cupo.disponibles', { disponibles: capacity.available })}
            </span>
          </p>

          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={capacity.source === 'explicito' ? 'primary' : 'neutral'}>
              {CAPACITY_SOURCE_LABELS[capacity.source]}
            </Badge>
            {capacity.explicitCapacity !== null && (
              <Badge variant="info">
                {t('programacion.cupo.explicito', { cupo: capacity.explicitCapacity })}
              </Badge>
            )}
            {capacity.isFull && <Badge variant="danger">{t('programacion.cupo.completo')}</Badge>}
          </div>
        </div>

        <div>
          <p className="pb-1 text-xs text-ink-subtle">{t('programacion.ocupacion')}</p>
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={cupo}
            aria-valuenow={asignados}
            aria-label={t('programacion.ocupacion.barra', { asignados, cupo })}
            className="h-2.5 w-full overflow-hidden rounded-full bg-surface-muted"
          >
            <div
              className={cn(
                'h-full rounded-full transition-[width]',
                capacity.isFull ? 'bg-danger' : porcentaje >= 80 ? 'bg-warning' : 'bg-primary',
              )}
              style={{ width: `${porcentaje}%` }}
            />
          </div>
        </div>

        {capacity.isFull && (
          <Alert variant="warning" title={t('programacion.cupo.completo')}>
            {t('programacion.cupo.completoTexto', { cupo })}
          </Alert>
        )}

        {capacity.warning !== null && (
          <Alert variant="warning" title={t('programacion.cupo.aviso')}>
            {capacity.warning}
          </Alert>
        )}

        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          <Contador etiqueta={t('programacion.contador.programadas')} valor={counts.programadas} />
          <Contador etiqueta={t('programacion.contador.notificadas')} valor={counts.notificadas} />
          <Contador etiqueta={t('programacion.contador.enSala')} valor={counts.enSala} />
          <Contador etiqueta={t('programacion.contador.atendidas')} valor={counts.atendidas} />
          <Contador etiqueta={t('programacion.contador.noAsistio')} valor={counts.noAsistio} />
          <Contador etiqueta={t('programacion.contador.canceladas')} valor={counts.canceladas} />
        </dl>
      </CardContent>
    </Card>
  );
};
