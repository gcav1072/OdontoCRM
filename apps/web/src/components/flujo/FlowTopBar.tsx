import type { AppointmentSummary, DayView } from '@odontocrm/contracts';
import { formatTime12h } from '@odontocrm/contracts';
import { Badge, Button, Card, Field, Input } from '@odontocrm/ui';
import { CalendarDays, ChevronLeft, ChevronRight, RefreshCw, UserRound } from 'lucide-react';

import { t } from '../../lib/i18n';
import { formatDateOnly } from '../../lib/scheduling';
import { AppointmentStatusBadge } from '../scheduling/AppointmentStatusBadge';
import { DayCounters } from '../secretaria/DayCounters';

export interface FlowTopBarProps {
  date: string;
  day: DayView | undefined;
  isFetching: boolean;
  onShift: (days: number) => void;
  onToday: () => void;
  onDateChange: (date: string) => void;
  onReload: () => void;

  /** Cita en curso: la barra enseña de quién es el expediente que hay en el centro. */
  appointment: AppointmentSummary | null;
}

/**
 * Barra superior de `/flujo`: **el día en una franja**.
 *
 * Arriba la fecha de la jornada (anterior, hoy, siguiente y campo de fecha) con los
 * contadores del servidor; debajo, el paciente en curso con su hora, su documento y
 * su estado. Las acciones del flujo viven aquí al lado: es lo que hace que el doctor
 * no tenga que salir de la pantalla para llevar el día.
 */
export const FlowTopBar = ({
  date,
  day,
  isFetching,
  onShift,
  onToday,
  onDateChange,
  onReload,
  appointment,
}: FlowTopBarProps) => (
  <Card className="lg:sticky lg:top-4 lg:z-20">
    <div className="space-y-4 p-4 sm:p-5">
      {/* Fecha de la jornada y contadores del día. */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-lg font-semibold text-ink">
            <CalendarDays className="size-5 text-primary" aria-hidden />
            {t('flujo.titulo')}
          </h1>
          <p className="flex flex-wrap items-center gap-2 pt-0.5 text-sm text-ink-muted">
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
            leadingIcon={<ChevronLeft className="size-4" aria-hidden />}
          />
          <Button variant="secondary" onClick={onToday}>
            {t('secretaria.hoy')}
          </Button>
          <Button
            variant="secondary"
            aria-label={t('secretaria.diaSiguiente')}
            title={t('secretaria.diaSiguiente')}
            onClick={() => onShift(1)}
            leadingIcon={<ChevronRight className="size-4" aria-hidden />}
          />
          <Field label={t('flujo.fecha')} className="w-40">
            <Input
              type="date"
              value={date}
              onChange={(event) => {
                // El campo nativo avisa en cada tecla: solo se aplica la fecha completa.
                if (event.target.value.length === 10) onDateChange(event.target.value);
              }}
            />
          </Field>
          <Button
            variant="secondary"
            aria-label={t('programacion.fecha.recargar')}
            title={t('programacion.fecha.recargar')}
            loading={isFetching}
            onClick={onReload}
            leadingIcon={<RefreshCw className="size-4" aria-hidden />}
          />
        </div>
      </div>

      {day !== undefined && <DayCounters counts={day.counts} dense />}

      {/* Paciente en curso. */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-control border border-border bg-surface-muted/60 px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <UserRound className="size-4 shrink-0 text-primary" aria-hidden />
          {appointment === null ? (
            <p className="text-sm text-ink-muted">{t('flujo.sinPaciente')}</p>
          ) : (
            <p className="min-w-0 truncate text-sm text-ink">
              <span className="font-medium">{appointment.patientName}</span>
              <span className="text-ink-muted">
                {' · '}
                {t('programacion.accion.hora', {
                  inicio: formatTime12h(appointment.startTime),
                  fin: formatTime12h(appointment.endTime),
                })}
                {appointment.patientDocument !== null ? ` · ${appointment.patientDocument}` : ''}
              </span>
            </p>
          )}
          {appointment !== null && <AppointmentStatusBadge status={appointment.status} />}
        </div>
      </div>
    </div>
  </Card>
);
