import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react';

import { cn } from '../lib/cn';
import { useFieldControl } from './field-context';

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label?: ReactNode;
  /** Texto secundario bajo la etiqueta (por ejemplo, los permisos de un rol). */
  description?: ReactNode;
  invalid?: boolean;
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { label, description, className, invalid, id, ...rest },
  ref,
) {
  const field = useFieldControl();
  const inputId = id ?? field?.id;
  const isInvalid = invalid ?? field?.invalid ?? false;

  const control = (
    <input
      ref={ref}
      id={inputId}
      type="checkbox"
      aria-invalid={isInvalid || undefined}
      className={cn(
        'mt-0.5 size-4 shrink-0 rounded-xs border-border-strong accent-primary',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-focus',
        'disabled:cursor-not-allowed disabled:opacity-55',
        className,
      )}
      {...rest}
    />
  );

  if (!label && !description) return control;

  return (
    <label htmlFor={inputId} className="flex cursor-pointer items-start gap-2.5 text-sm">
      {control}
      <span className="min-w-0">
        {label && <span className="block font-medium text-ink">{label}</span>}
        {description && <span className="block text-xs text-ink-subtle">{description}</span>}
      </span>
    </label>
  );
});
