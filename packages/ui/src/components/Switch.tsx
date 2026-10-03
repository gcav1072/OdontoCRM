import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react';

import { cn } from '../lib/cn';
import { useFieldControl } from './field-context';

export interface SwitchProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label?: ReactNode;
  description?: ReactNode;
}

/**
 * Interruptor de encendido/apagado. Se apoya en un `checkbox` nativo (así
 * funciona con `register()` de React Hook Form) con `role="switch"` y el dibujo
 * hecho con `peer-checked`, sin estado propio.
 */
export const Switch = forwardRef<HTMLInputElement, SwitchProps>(function Switch(
  { label, description, className, id, ...rest },
  ref,
) {
  const field = useFieldControl();
  const inputId = id ?? field?.id;

  return (
    <label
      htmlFor={inputId}
      className={cn(
        'flex items-start gap-3 text-sm',
        rest.disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
        className,
      )}
    >
      <span className="relative mt-0.5 inline-flex h-5 w-9 shrink-0 items-center">
        <input
          ref={ref}
          id={inputId}
          type="checkbox"
          role="switch"
          className="peer sr-only"
          {...rest}
        />
        <span
          aria-hidden="true"
          className={cn(
            'absolute inset-0 rounded-full bg-border-strong transition-colors',
            'peer-checked:bg-primary',
            'peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-solid peer-focus-visible:outline-focus',
          )}
        />
        <span
          aria-hidden="true"
          className="absolute left-0.5 size-4 rounded-full bg-surface shadow-xs transition-transform peer-checked:translate-x-4"
        />
      </span>
      {(label || description) && (
        <span className="min-w-0">
          {label && <span className="block font-medium text-ink">{label}</span>}
          {description && <span className="block text-xs text-ink-subtle">{description}</span>}
        </span>
      )}
    </label>
  );
});
