import type { DayView } from '@odontocrm/contracts';
import { Badge, Button, Card, CardHeader, CardTitle, Field, Input } from '@odontocrm/ui';
import { CalendarDays, ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react';

import { t } from '../../lib/i18n';
import { formatDateOnly } from '../../lib/scheduling';

export interface SecretariaToolbarProps {
  date: string;
  /** Jornada cargada: de ella salen el día de la semana y si es laborable. */
  day: DayView | undefined;
  search: string;
  isFetching: boolean;
  onSearch: (value: string) => void;
  onShift: (days: number) => void;
  onToday: () => void;
  onDateChange: (date: string) => void;
  onReload: () => void;
}

/**
 * Cabecera de la secretaría: navegación por días (anterior, hoy, siguiente y
 * campo de fecha), el buscador de la jornada y la recarga manual. El buscador
 * filtra en memoria, así que el campo no dispara peticiones.
 */
export const SecretariaToolbar = ({
  date,
  day,
  search,
  isFetching,
  onSearch,
  onShift,
  onToday,
  onDateChange,
  onReload,
}: SecretariaToolbarProps) => (
  <Card>
    <CardHeader className="gap-4 xl:flex-row xl:items-end xl:justify-between">
      <div className="min-w-0">
        <CardTitle as="h2" className="flex items-center gap-2">
          <CalendarDays className="size-5 text-primary" aria-hidden="true" />
          {t('secretaria.fecha')}
        </CardTitle>
        <p className="flex flex-wrap items-center gap-2 pt-1 text-sm text-ink-muted">
          <span className="font-medium text-ink">{formatDateOnly(date)}</span>
          {day !== undefined && <span className="first-letter:uppercase">{day.weekdayName}</span>}
          {day !== undefined && !day.isWorkingDay && (
            <Badge variant="warning">{t('programacion.fecha.noLaborable')}</Badge>
          )}
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <Button
          variant="secondary"
          aria-label={t('secretaria.diaAnterior')}
          title={t('secretaria.diaAnterior')}
          onClick={() => onShift(-1)}
          leadingIcon={<ChevronLeft className="size-4" aria-hidden="true" />}
        >
          {t('secretaria.diaAnterior')}
        </Button>

        <Button variant="secondary" onClick={onToday}>
          {t('secretaria.hoy')}
        </Button>

        <Button
          variant="secondary"
          aria-label={t('secretaria.diaSiguiente')}
          title={t('secretaria.diaSiguiente')}
          onClick={() => onShift(1)}
          trailingIcon={<ChevronRight className="size-4" aria-hidden="true" />}
        >
          {t('secretaria.diaSiguiente')}
        </Button>

        <Field label={t('secretaria.fecha')} className="w-44">
          <Input
            type="date"
            value={date}
            onChange={(event) => {
              // El campo nativo avisa en cada tecla: solo se aplica la fecha completa.
              if (event.target.value.length === 10) onDateChange(event.target.value);
            }}
          />
        </Field>

        <Field label={t('secretaria.buscar')} className="w-full sm:w-64">
          <Input
            type="search"
            value={search}
            placeholder={t('secretaria.buscarPlaceholder')}
            onChange={(event) => onSearch(event.target.value)}
          />
        </Field>

        <Button
          variant="secondary"
          loading={isFetching}
          loadingLabel={t('secretaria.cargando')}
          onClick={onReload}
          leadingIcon={<RefreshCw className="size-4" aria-hidden="true" />}
        >
          {t('programacion.fecha.recargar')}
        </Button>
      </div>
    </CardHeader>
  </Card>
);
