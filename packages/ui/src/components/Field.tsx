import { useId, type ReactNode } from 'react';

import { cn } from '../lib/cn';
import { FieldContext } from './field-context';
import { Label } from './Label';

export interface FieldProps {
  label: string;
  /** Identificador del control. Si se omite, se genera y se comparte por contexto. */
  id?: string;
  /** Mensaje de error: además de mostrarse, marca el control como inválido. */
  error?: string;
  /** Ayuda breve bajo el control (se oculta si hay error para no saturar). */
  hint?: string;
  required?: boolean;
  className?: string;
  children: ReactNode;
}

/**
 * Etiqueta + control + ayuda + error, con el cableado de accesibilidad hecho:
 * `htmlFor`, `aria-invalid` y `aria-describedby` se comparten con el control
 * mediante contexto, así que los formularios solo escriben el mensaje.
 */
export const Field = ({
  label,
  id,
  error,
  hint,
  required = false,
  className,
  children,
}: FieldProps) => {
  const autoId = useId();
  const controlId = id ?? `campo-${autoId}`;
  const errorId = `${controlId}-error`;
  const hintId = `${controlId}-hint`;
  const describedBy =
    [hint ? hintId : null, error ? errorId : null].filter((value) => value !== null).join(' ') ||
    undefined;

  return (
    <FieldContext.Provider
      value={{ id: controlId, invalid: Boolean(error), required, describedBy }}
    >
      <div className={cn('flex flex-col gap-1.5', className)}>
        <Label htmlFor={controlId} required={required}>
          {label}
        </Label>
        {children}
        {hint && !error && (
          <p id={hintId} className="text-xs text-ink-subtle">
            {hint}
          </p>
        )}
        {error && (
          <p id={errorId} role="alert" className="text-xs font-medium text-danger">
            {error}
          </p>
        )}
      </div>
    </FieldContext.Provider>
  );
};
