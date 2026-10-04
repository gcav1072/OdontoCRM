import {
  PATIENT_STATUSES,
  REPORT_GRANULARITIES,
  SEXES,
  type PatientStatus,
  type Sex,
} from '@odontocrm/contracts';
import { Button, Field, Input, Select, cn } from '@odontocrm/ui';
import { RefreshCw, RotateCcw } from 'lucide-react';

import { PATIENT_STATUS_LABELS, SEX_LABELS, t } from '../../lib/i18n';
import {
  GRANULARITY_LABELS,
  hasActiveFilters,
  isAgeRangeInverted,
  isDateRangeInverted,
  type ReportFiltersState,
} from '../../lib/reports';

export interface ReportFiltersProps {
  value: ReportFiltersState;
  onChange: (next: ReportFiltersState) => void;
  /** Vuelve a la ventana de 30 días con la agrupación semanal. */
  onReset: () => void;
  /** Fuerza una nueva consulta con los filtros que ya están puestos. */
  onRefresh: () => void;
  /** Hay una consulta en vuelo: el botón «Actualizar» lo muestra. */
  isFetching?: boolean;
  className?: string;
}

/**
 * Barra de filtros común a los seis reportes: fechas, rango de edad, sexo,
 * estado del paciente y agrupación de las series.
 *
 * Los filtros no se aplican solos al cambiar un campo: la consulta la dispara el
 * botón «Actualizar» (o el cambio, que ya vuelve a consultar). El rango de edad
 * invertido se avisa en el propio campo y no se manda; el rango de **fechas**
 * invertido además bloquea la consulta, porque el contrato lo rechaza.
 */
export const ReportFilters = ({
  value,
  onChange,
  onReset,
  onRefresh,
  isFetching = false,
  className,
}: ReportFiltersProps) => {
  const edadInvalida = isAgeRangeInverted(value);
  const fechasInvalidas = isDateRangeInverted(value);

  const set = (parcial: Partial<ReportFiltersState>): void => onChange({ ...value, ...parcial });

  return (
    <div className={cn('grid gap-3 sm:grid-cols-2 lg:grid-cols-4', className)}>
      <Field
        label={t('reportes.filtros.desde')}
        error={fechasInvalidas ? t('reportes.filtros.fechasInvalidas') : undefined}
      >
        <Input
          type="date"
          value={value.from}
          max={value.to === '' ? undefined : value.to}
          invalid={fechasInvalidas}
          onChange={(event) => set({ from: event.target.value })}
        />
      </Field>

      <Field label={t('reportes.filtros.hasta')}>
        <Input
          type="date"
          value={value.to}
          min={value.from === '' ? undefined : value.from}
          invalid={fechasInvalidas}
          onChange={(event) => set({ to: event.target.value })}
        />
      </Field>

      <Field label={t('reportes.filtros.edadMin')}>
        <Input
          type="number"
          min={0}
          max={120}
          inputMode="numeric"
          value={value.ageMin}
          invalid={edadInvalida}
          onChange={(event) => set({ ageMin: event.target.value })}
        />
      </Field>

      <Field
        label={t('reportes.filtros.edadMax')}
        error={edadInvalida ? t('reportes.filtros.edadInvalida') : undefined}
      >
        <Input
          type="number"
          min={0}
          max={120}
          inputMode="numeric"
          value={value.ageMax}
          invalid={edadInvalida}
          onChange={(event) => set({ ageMax: event.target.value })}
        />
      </Field>

      <Field label={t('reportes.filtros.sexo')}>
        <Select
          value={value.sex}
          onChange={(event) => set({ sex: event.target.value as '' | Sex })}
        >
          <option value="">{t('reportes.filtros.todos')}</option>
          {SEXES.map((sexo) => (
            <option key={sexo} value={sexo}>
              {SEX_LABELS[sexo]}
            </option>
          ))}
        </Select>
      </Field>

      <Field label={t('reportes.filtros.estado')}>
        <Select
          value={value.status}
          onChange={(event) => set({ status: event.target.value as '' | PatientStatus })}
        >
          <option value="">{t('reportes.filtros.todos')}</option>
          {PATIENT_STATUSES.map((estado) => (
            <option key={estado} value={estado}>
              {PATIENT_STATUS_LABELS[estado]}
            </option>
          ))}
        </Select>
      </Field>

      <Field
        label={t('reportes.filtros.granularidad')}
        hint={t('reportes.filtros.granularidadAyuda')}
      >
        <Select
          value={value.granularity}
          onChange={(event) =>
            set({ granularity: event.target.value as ReportFiltersState['granularity'] })
          }
        >
          {REPORT_GRANULARITIES.map((granularidad) => (
            <option key={granularidad} value={granularidad}>
              {GRANULARITY_LABELS[granularidad]}
            </option>
          ))}
        </Select>
      </Field>

      <div className="flex items-end gap-2">
        <Button
          variant="secondary"
          className="flex-1"
          onClick={onReset}
          disabled={!hasActiveFilters(value)}
          leadingIcon={<RotateCcw className="size-4" aria-hidden="true" />}
        >
          {t('comun.limpiar')}
        </Button>
        <Button
          className="flex-1"
          onClick={onRefresh}
          loading={isFetching}
          loadingLabel={t('reportes.filtros.actualizando')}
          leadingIcon={<RefreshCw className="size-4" aria-hidden="true" />}
        >
          {t('reportes.filtros.actualizar')}
        </Button>
      </div>
    </div>
  );
};
