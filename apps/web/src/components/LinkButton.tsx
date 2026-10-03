import { buttonClasses, cn, type ButtonSize, type ButtonVariant } from '@odontocrm/ui';
import type { ReactNode } from 'react';
import { Link, type LinkProps } from 'react-router-dom';

export interface LinkButtonProps extends Omit<LinkProps, 'className'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  leadingIcon?: ReactNode;
}

/**
 * Enlace con el aspecto de un botón: usa las mismas clases que `Button` para
 * que la navegación y las acciones no se vean distintas.
 */
export const LinkButton = ({
  variant = 'primary',
  size = 'md',
  className,
  leadingIcon,
  children,
  ...rest
}: LinkButtonProps) => (
  <Link className={cn(buttonClasses({ variant, size }), className)} {...rest}>
    {leadingIcon}
    <span className="truncate">{children}</span>
  </Link>
);
