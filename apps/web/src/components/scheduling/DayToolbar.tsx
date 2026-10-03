import type { DayView } from '@odontocrm/contracts';
import { Badge, Button, Card, CardHeader, CardTitle, Field, Input } from '@odontocrm/ui';
import {
  BellRing,
  CalendarDays,
  CalendarRange,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
} from 'lucide-react';

import { formatDateOnly } from '../../lib/scheduling';
import { t } from '../../lib/i18n';

export interface DayToolbarProps {
  date: string;
  day: DayView | undefined;
  isFetching: boolean;
  canNotify: boolean;
  onShift: (days: number) => void;
  onToday: () => void;
  onDateChange: (date: string) => void;
  onReload: () => void;
  onNotify: () => void;
  onTemplates: () => void;
}

/**
 * Cabecera de la jornada: navegación por días (anterior, hoy, siguiente y campo
 * de fecha) y las acciones del día (recargar, plantillas de franjas y el aviso
 * en lote al paciente).
 */
export const DayToolbar = ({
  date,
  day,
  isFetching,
  canNotify,
  onShift,
  onToday,
  onDateChange,
  onReload,
  onNotify,
  onTemplates,
}: DayToolbarProps) => (
  <Card>
    <CardHeader className="gap-4 lg:flex-row lg:items-end lg:justify-between">
      <div className="min-w-0">
        <CardTitle as="h1" className="flex items-center gap-2">
          <CalendarRange className="size-5 text-primary" aria-hidden="true" />
          {t('programacion.titulo')}
        </CardTitle>
        <p className="flex flex-wrap items-center gap-2 pt-1 text-sm text-ink-muted">
          <CalendarDays className="size-4" aria-hidden="true" />
          {formatDateOnly(date)}
          {day !== undefined && <span className="first-letter:uppercase">{day.weekdayName}</span>}
          {day !== undefined && !day.isWorkingDay && (
            <Badge variant="warning">{t('programacion.fecha.noLaborable')}</Badge>
          )}
          {day !== undefined && (
            <Badge variant="info">
              {t('programacion.fecha.enEspera', { total: day.waiting.length })}
            </Badge>
          )}
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <Button
          variant="secondary"
          aria-label={t('programacion.fecha.anterior')}
          title={t('programacion.fecha.anterior')}
          onClick={() => onShift(-1)}
          leadingIcon={<ChevronLeft className="size-4" aria-hidden="true" />}
        >
          {t('programacion.fecha.anterior')}
        </Button>
        <Button variant="secondary" onClick={onToday}>
          {t('programacion.fecha.hoy')}
        </Button>
        <Button
          variant="secondary"
          aria-label={t('programacion.fecha.siguiente')}
          title={t('programacion.fecha.siguiente')}
          onClick={() => onShift(1)}
          trailingIcon={<ChevronRight className="size-4" aria-hidden="true" />}
        >
          {t('programacion.fecha.siguiente')}
        </Button>

        <Field label={t('programacion.fecha.campo')} className="w-44">
          <Input
            type="date"
            value={date}
            onChange={(event) => {
              if (event.target.value.length === 10) onDateChange(event.target.value);
            }}
          />
        </Field>

        <Button
          variant="secondary"
          loading={isFetching}
          onClick={onReload}
          leadingIcon={<RefreshCw className="size-4" aria-hidden="true" />}
        >
          {t('programacion.fecha.recargar')}
        </Button>

        <Button
          variant="secondary"
          onClick={onTemplates}
          leadingIcon={<CalendarDays className="size-4" aria-hidden="true" />}
        >
          {t('programacion.plantillas.abrir')}
        </Button>

        {canNotify && (
          <Button
            onClick={onNotify}
            leadingIcon={<BellRing className="size-4" aria-hidden="true" />}
          >
            {t('programacion.notificar.boton')}
          </Button>
        )}
      </div>
    </CardHeader>
  </Card>
);
