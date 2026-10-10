import { forwardRef, type TextareaHTMLAttributes } from 'react';

import { cn } from '../lib/cn';
import { controlVisualClasses } from './control-classes';
import { useFieldControl } from './field-context';

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** Fuerza el estado inválido; por defecto lo toma del `Field` que lo envuelve. */
  invalid?: boolean;
}

/**
 * Control multilínea. Comparte la piel con [`Input`](./Input.tsx) y
 * [`Select`](./Select.tsx) —borde, foco, tamaño de letra en móvil— para que un
 * `<textarea>` no se desincronice del resto del formulario.
 */
const BASE_CLASSES = `px-3 py-2 ${controlVisualClasses}`;

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
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
    <textarea
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
    />
  );
});
