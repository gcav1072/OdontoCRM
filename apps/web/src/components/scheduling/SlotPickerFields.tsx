import { formatTime12h, minutesBetween, type DaySlot, type SlotKind } from '@odontocrm/contracts';
import { Alert, Field, Input, Select, cn } from '@odontocrm/ui';

import { SLOT_KIND_LABELS, t } from '../../lib/i18n';

export interface SlotPickerValue {
  slotKind: SlotKind;
  startTime: string;
  durationMinutes: number;
}

export interface SlotPickerFieldsProps {
  /** Franjas del día destino (incluye libres y ocupadas). */
  slots: readonly DaySlot[];
  value: SlotPickerValue;
  onChange: (next: Partial<SlotPickerValue>) => void;
  errorStartTime?: string;
  errorDuration?: string;
  disabled?: boolean;
}

/**
 * Elección de la hora de la cita: una franja libre de la rejilla o una hora
 * manual (`slotKind: 'manual'`) con su duración. Son radios nativos, así que se
 * recorren con las flechas del teclado sin código extra.
 */
export const SlotPickerFields = ({
  slots,
  value,
  onChange,
  errorStartTime,
  errorDuration,
  disabled = false,
}: SlotPickerFieldsProps) => {
  const libres = slots.filter((slot) => slot.state === 'libre');
  const franjaElegida = libres.find((slot) => slot.startTime === value.startTime);

  const elegirFranja = (inicio: string) => {
    const franja = libres.find((slot) => slot.startTime === inicio);
    onChange({
      slotKind: 'franja',
      startTime: inicio,
      durationMinutes:
        franja === undefined
          ? value.durationMinutes
          : Math.max(5, minutesBetween(franja.startTime, franja.endTime)),
    });
  };

  return (
    <div className="space-y-4">
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-ink">
          {t('programacion.asignar.modalidad')}
        </legend>
        <div className="flex flex-wrap gap-4">
          {(['franja', 'manual'] as const).map((tipo) => (
            <label
              key={tipo}
              className={cn(
                'flex cursor-pointer items-center gap-2 rounded-control border px-3 py-2 text-sm',
                value.slotKind === tipo
                  ? 'border-primary bg-primary/5 text-ink'
                  : 'border-border text-ink-muted',
              )}
            >
              <input
                type="radio"
                name="modalidad-hora"
                className="size-4 accent-primary"
                value={tipo}
                checked={value.slotKind === tipo}
                disabled={disabled}
                onChange={() => onChange({ slotKind: tipo })}
              />
              {SLOT_KIND_LABELS[tipo]}
            </label>
          ))}
        </div>
      </fieldset>

      {value.slotKind === 'franja' ? (
        <Field
          label={t('programacion.asignar.franja')}
          error={errorStartTime}
          hint={
            franjaElegida === undefined
              ? undefined
              : t('programacion.franja.total', { total: libres.length })
          }
          required
        >
          <Select
            value={value.startTime}
            disabled={disabled || libres.length === 0}
            onChange={(event) => elegirFranja(event.target.value)}
          >
            {franjaElegida === undefined && value.startTime !== '' && (
              <option value={value.startTime}>{formatTime12h(value.startTime)}</option>
            )}
            {libres.map((slot) => (
              <option key={`${slot.kind}-${slot.startTime}`} value={slot.startTime}>
                {formatTime12h(slot.startTime)} – {formatTime12h(slot.endTime)}
              </option>
            ))}
          </Select>
        </Field>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('programacion.asignar.hora')} error={errorStartTime} required>
            <Input
              type="time"
              step={300}
              value={value.startTime}
              disabled={disabled}
              onChange={(event) => onChange({ startTime: event.target.value, slotKind: 'manual' })}
            />
          </Field>
          <Field label={t('programacion.asignar.duracion')} error={errorDuration}>
            <Input
              type="number"
              min={5}
              max={240}
              inputMode="numeric"
              value={value.durationMinutes}
              disabled={disabled}
              onChange={(event) =>
                onChange({ durationMinutes: Number(event.target.value), slotKind: 'manual' })
              }
            />
          </Field>
        </div>
      )}

      {value.slotKind === 'franja' && libres.length === 0 && (
        <Alert variant="warning">{t('programacion.asignar.sinFranjas')}</Alert>
      )}
      {value.slotKind === 'manual' && (
        <Alert variant="info">{t('programacion.asignar.manualAviso')}</Alert>
      )}
    </div>
  );
};
