import { forwardRef, type SelectHTMLAttributes } from 'react';

import { cn } from '../lib/cn';
import { useFieldControl } from './field-context';

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  invalid?: boolean;
}

const BASE_CLASSES = [
  'h-10 w-full appearance-none rounded-control border bg-surface px-3 pr-9 text-sm text-ink transition-colors',
  'disabled:cursor-not-allowed disabled:bg-surface-muted disabled:text-ink-muted',
  'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-solid focus-visible:outline-focus',
  // Flecha dibujada con CSS para no depender de iconos externos en el paquete ui.
  "bg-[url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22%2364748b%22 stroke-width=%222%22 stroke-linecap=%22round%22><path d=%22m6 9 6 6 6-6%22/></svg>')] bg-[length:1rem_1rem] bg-[right_0.625rem_center] bg-no-repeat",
].join(' ');

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  {
    className,
    invalid,
    id,
    'aria-describedby': ariaDescribedBy,
    'aria-invalid': ariaInvalid,
    'aria-required': ariaRequired,
    children,
    ...rest
  },
  ref,
) {
  const field = useFieldControl();
  const isInvalid = invalid ?? field?.invalid ?? false;

  return (
    <select
      ref={ref}
      id={id ?? field?.id}
      aria-required={ariaRequired ?? (field?.required || undefined)}
      aria-invalid={ariaInvalid ?? (isInvalid || undefined)}
      aria-describedby={ariaDescribedBy ?? field?.describedBy}
      className={cn(
        BASE_CLASSES,
        isInvalid ? 'border-danger focus-visible:outline-danger' : 'border-border-strong',
        className,
      )}
      {...rest}
    >
      {children}
    </select>
  );
});
