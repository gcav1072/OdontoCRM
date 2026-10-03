import type { HTMLAttributes, ReactNode } from 'react';

import { cn } from '../lib/cn';

export type CardProps = HTMLAttributes<HTMLDivElement>;

export const Card = ({ className, ...rest }: CardProps) => (
  <div
    className={cn('rounded-card border border-border bg-surface shadow-card', className)}
    {...rest}
  />
);

export const CardHeader = ({ className, ...rest }: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('flex flex-col gap-1.5 p-5', className)} {...rest} />
);

export interface CardTitleProps extends HTMLAttributes<HTMLHeadingElement> {
  /** Nivel del encabezado; por defecto `h2` para no romper la jerarquía del documento. */
  as?: 'h1' | 'h2' | 'h3' | 'h4';
}

export const CardTitle = ({ as: Tag = 'h2', className, ...rest }: CardTitleProps) => (
  <Tag className={cn('text-base font-semibold text-ink', className)} {...rest} />
);

export const CardDescription = ({ className, ...rest }: HTMLAttributes<HTMLParagraphElement>) => (
  <p className={cn('text-sm text-ink-muted', className)} {...rest} />
);

export const CardContent = ({ className, ...rest }: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('px-5 pb-5', className)} {...rest} />
);

export const CardFooter = ({ className, ...rest }: HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      'flex flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-3.5',
      className,
    )}
    {...rest}
  />
);

/** Acción opcional alineada a la derecha del encabezado. */
export const CardAction = ({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) => <div className={cn('ml-auto flex items-center gap-2', className)}>{children}</div>;
