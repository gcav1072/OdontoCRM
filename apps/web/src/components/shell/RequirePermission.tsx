import type { Permission } from '@odontocrm/contracts';
import type { ReactNode } from 'react';

import { ForbiddenPage } from '../../pages/ForbiddenPage';
import { useAuth } from '../../providers/AuthProvider';

export interface RequirePermissionProps {
  permission: Permission;
  children: ReactNode;
}

/**
 * Segunda barrera tras el menú: si alguien llega por URL a un módulo para el
 * que no tiene permiso, ve la página 403 (nunca una pantalla rota). La primera
 * barrera es la API, que responde 403 por su cuenta.
 */
export const RequirePermission = ({ permission, children }: RequirePermissionProps) => {
  const { hasPermission } = useAuth();

  if (!hasPermission(permission)) return <ForbiddenPage permission={permission} />;

  return <>{children}</>;
};
