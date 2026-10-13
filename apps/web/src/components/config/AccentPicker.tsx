import { UI_ACCENTS, UI_ACCENT_IDS, type UIAccentId } from '@odontocrm/contracts';
import { cn } from '@odontocrm/ui';

export interface AccentPickerProps {
  /** Acento seleccionado. */
  value: UIAccentId;
  onChange: (value: UIAccentId) => void;
  /** Etiqueta accesible del grupo de radios. */
  ariaLabel: string;
}

/**
 * Selector del **color de acento**: los diez presets del espectro, cada uno con su
 * color real en claro y en oscuro, así la elección se ve antes de guardar.
 *
 * Lo comparten la configuración de la aplicación (`AcentoSection`) y la de cada pantalla
 * kiosko (que reutiliza los mismos presets, solo que aplicados a su propio cromo).
 */
export const AccentPicker = ({ value, onChange, ariaLabel }: AccentPickerProps) => (
  <div role="radiogroup" aria-label={ariaLabel} className="flex flex-wrap gap-3">
    {UI_ACCENT_IDS.map((id) => {
      const preset = UI_ACCENTS[id];
      const elegido = id === value;
      return (
        <button
          key={id}
          type="button"
          role="radio"
          aria-checked={elegido}
          onClick={() => onChange(id)}
          className={cn(
            'flex items-center gap-2 rounded-control border-2 px-3 py-2 text-sm transition-colors',
            elegido ? 'border-primary bg-surface-muted' : 'border-border hover:bg-surface-muted',
          )}
        >
          <span
            className="inline-block size-5 rounded-full border border-border"
            style={{ background: preset.light.primary }}
            aria-hidden="true"
          />
          <span
            className="inline-block size-5 rounded-full border border-border"
            style={{ background: preset.dark.primary }}
            aria-hidden="true"
          />
          {preset.label}
        </button>
      );
    })}
  </div>
);
