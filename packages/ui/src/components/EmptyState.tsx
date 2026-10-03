import type { ReactNode } from 'react';

import { cn } from '../lib/cn';

export interface EmptyStateProps {
  title: string;
  description?: string;
  icon?: ReactNode;
  action?: ReactNode;
  className?: string;
}

/** Estado vacío o de bloqueo: título, explicación y una acción de salida. */
export const EmptyState = ({ title, description, icon, action, className }: EmptyStateProps) => (
  <div
    className={cn(
      'flex flex-col items-center gap-3 rounded-card border border-dashed border-border-strong/70 bg-surface px-6 py-12 text-center',
      className,
    )}
  >
    {icon && (
      <span className="grid size-12 place-items-center rounded-full bg-primary/10 text-primary">
        {icon}
      </span>
    )}
    <h2 className="text-lg font-semibold text-ink">{title}</h2>
    {description && <p className="max-w-xl text-sm text-ink-muted">{description}</p>}
    {action && <div className="mt-1 flex flex-wrap justify-center gap-2">{action}</div>}
  </div>
);
