import type { HTMLAttributes, ReactNode } from 'react';

import { cn } from '../lib/cn';

export type AlertVariant = 'info' | 'success' | 'warning' | 'danger';

const VARIANT_CLASSES: Record<AlertVariant, string> = {
  info: 'border-info/35 bg-info/10 text-info',
  success: 'border-success/35 bg-success/10 text-success',
  warning: 'border-warning/35 bg-warning/10 text-warning',
  danger: 'border-danger/35 bg-danger/10 text-danger',
};

const ICONOS: Record<AlertVariant, ReactNode> = {
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </>
  ),
  success: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m8.5 12.5 2.5 2.5 4.5-5" />
    </>
  ),
  warning: (
    <>
      <path d="M10.3 3.9 1.9 18a2 2 0 0 0 1.7 3h16.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4M12 17h.01" />
    </>
  ),
  danger: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M15 9l-6 6M9 9l6 6" />
    </>
  ),
};

export interface AlertProps extends HTMLAttributes<HTMLDivElement> {
  variant?: AlertVariant;
  title?: string;
  /** Oculta el icono de la variante si el contenido ya trae el suyo. */
  hideIcon?: boolean;
  onDismiss?: () => void;
  dismissLabel?: string;
}

/**
 * Mensaje de estado en línea. Los avisos y errores usan `role="alert"` para que
 * el lector de pantalla los anuncie en cuanto aparecen.
 */
export const Alert = ({
  variant = 'info',
  title,
  hideIcon = false,
  onDismiss,
  dismissLabel = 'Cerrar el aviso',
  className,
  children,
  ...rest
}: AlertProps) => (
  <div
    role={variant === 'danger' || variant === 'warning' ? 'alert' : 'status'}
    className={cn(
      'flex items-start gap-3 rounded-control border px-3.5 py-3',
      VARIANT_CLASSES[variant],
      className,
    )}
    {...rest}
  >
    {!hideIcon && (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className="mt-0.5 size-4 shrink-0"
      >
        {ICONOS[variant]}
      </svg>
    )}
    <div className="min-w-0 flex-1 text-sm text-ink">
      {title && <p className="font-semibold">{title}</p>}
      {children && <div className={cn(title && 'mt-0.5', 'text-ink-muted')}>{children}</div>}
    </div>
    {onDismiss && (
      <button
        type="button"
        onClick={onDismiss}
        aria-label={dismissLabel}
        className="-mr-1 rounded-control p-1 text-ink-subtle transition-colors hover:bg-surface/60 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-solid focus-visible:outline-focus"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          aria-hidden="true"
          className="size-3.5"
        >
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>
    )}
  </div>
);
