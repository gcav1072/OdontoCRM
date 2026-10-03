import type { HTMLAttributes, ReactNode } from 'react';

import { cn } from '../lib/cn';

export type BadgeVariant = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info';

const VARIANT_CLASSES: Record<BadgeVariant, string> = {
  neutral: 'border-border-strong/60 bg-surface-muted text-ink-muted',
  primary: 'border-primary/30 bg-primary/10 text-primary',
  success: 'border-success/30 bg-success/10 text-success',
  warning: 'border-warning/30 bg-warning/10 text-warning',
  danger: 'border-danger/30 bg-danger/10 text-danger',
  info: 'border-info/30 bg-info/10 text-info',
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
  /** Punto de color a la izquierda, útil para estados. */
  dot?: boolean;
  icon?: ReactNode;
}

export const Badge = ({
  variant = 'neutral',
  dot = false,
  icon,
  className,
  children,
  ...rest
}: BadgeProps) => (
  <span
    className={cn(
      'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap',
      VARIANT_CLASSES[variant],
      className,
    )}
    {...rest}
  >
    {dot && <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />}
    {icon}
    {children}
  </span>
);
