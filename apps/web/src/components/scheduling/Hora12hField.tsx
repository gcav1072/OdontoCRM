import { Select, cn } from '@odontocrm/ui';
import { useId } from 'react';

import { t } from '../../lib/i18n';
import { fromTime12, minuteOptions, toTime12, type Time12 } from '../../lib/schedule-config';

export interface Hora12hFieldProps {
  label: string;
  /** Hora en 24 h (`HH:MM`), como la guarda el contrato. */
  value: string;
  onChange: (time: string) => void;
  error?: string;
  hint?: string;
  disabled?: boolean;
  className?: string;
}

const HORAS = Array.from({ length: 12 }, (_, index) => index + 1);

/**
 * Hora en **12 h** (ADR 0025) con tres selectores: hora, minutos y a. m./p. m.
 *
 * Se usan `<select>` y no un `input type="time"` porque el control nativo se pinta
 * en 24 h según el idioma del sistema, y aquí las horas se leen y se dicen en 12 h.
 * El valor viaja siempre en 24 h: la conversión ocurre solo al mostrar.
 */
export const Hora12hField = ({
  label,
  value,
  onChange,
  error,
  hint,
  disabled = false,
  className,
}: Hora12hFieldProps) => {
  const labelId = useId();
  const hora = toTime12(value === '' ? '08:00' : value);
  const cambiar = (siguiente: Partial<Time12>) => {
    onChange(fromTime12({ ...hora, ...siguiente }));
  };

  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <span id={labelId} className="text-sm font-medium text-ink">
        {label}
      </span>
      <div role="group" aria-labelledby={labelId} className="flex min-w-0 items-center gap-1">
        <Select
          className="w-20"
          aria-label={`${label}: ${t('programacion.jornada.hora')}`}
          value={hora.hour}
          disabled={disabled}
          invalid={error !== undefined}
          onChange={(event) => cambiar({ hour: Number(event.target.value) })}
        >
          {HORAS.map((numero) => (
            <option key={numero} value={numero}>
              {numero}
            </option>
          ))}
        </Select>
        <span aria-hidden="true" className="text-ink-subtle">
          :
        </span>
        <Select
          className="w-20"
          aria-label={`${label}: ${t('programacion.jornada.minutos')}`}
          value={hora.minute}
          disabled={disabled}
          invalid={error !== undefined}
          onChange={(event) => cambiar({ minute: Number(event.target.value) })}
        >
          {minuteOptions(hora.minute).map((minuto) => (
            <option key={minuto} value={minuto}>
              {String(minuto).padStart(2, '0')}
            </option>
          ))}
        </Select>
        <Select
          className="w-24"
          aria-label={`${label}: ${t('programacion.jornada.meridiano')}`}
          value={hora.meridiem}
          disabled={disabled}
          invalid={error !== undefined}
          onChange={(event) => cambiar({ meridiem: event.target.value === 'pm' ? 'pm' : 'am' })}
        >
          <option value="am">a. m.</option>
          <option value="pm">p. m.</option>
        </Select>
      </div>
      {hint !== undefined && error === undefined && (
        <p className="text-xs text-ink-subtle">{hint}</p>
      )}
      {error !== undefined && (
        <p role="alert" className="text-xs font-medium text-danger">
          {error}
        </p>
      )}
    </div>
  );
};
