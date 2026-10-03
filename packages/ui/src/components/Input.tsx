import { forwardRef, type InputHTMLAttributes } from 'react';

import { cn } from '../lib/cn';
import { useFieldControl } from './field-context';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Fuerza el estado inválido; por defecto lo toma del `Field` que lo envuelve. */
  invalid?: boolean;
}

const BASE_CLASSES = [
  'h-10 w-full rounded-control border bg-surface px-3 text-sm text-ink shadow-xs transition-colors',
  'placeholder:text-ink-subtle',
  'disabled:cursor-not-allowed disabled:bg-surface-muted disabled:text-ink-muted',
  'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-solid focus-visible:outline-focus',
].join(' ');

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  {
    className,
    invalid,
    id,
    'aria-describedby': ariaDescribedBy,
    'aria-invalid': ariaInvalid,
    'aria-required': ariaRequired,
    ...rest
  },
  ref,
) {
  const field = useFieldControl();
  const isInvalid = invalid ?? field?.invalid ?? false;

  return (
    <input
      ref={ref}
      id={id ?? field?.id}
      /* `aria-required` en vez de `required`: la validación y sus mensajes en
         español los da Zod, no el navegador. */
      aria-required={ariaRequired ?? (field?.required || undefined)}
      aria-invalid={ariaInvalid ?? (isInvalid || undefined)}
      aria-describedby={ariaDescribedBy ?? field?.describedBy}
      className={cn(
        BASE_CLASSES,
        isInvalid ? 'border-danger focus-visible:outline-danger' : 'border-border-strong',
        className,
      )}
      {...rest}
    />
  );
});
