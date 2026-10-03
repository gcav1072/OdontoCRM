import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';

import { useAuth } from '../../providers/AuthProvider';

/**
 * Con la contraseña temporal puesta no se puede usar el sistema: el gate lleva
 * a `/cambiar-contrasena` y solo deja seguir cuando el cambio está hecho.
 * `App.tsx` deja esa ruta fuera del shell para que no haya adónde navegar.
 */
export const MustChangePasswordGate = ({ children }: { children: ReactNode }) => {
  const { mustChangePassword } = useAuth();

  if (mustChangePassword) return <Navigate to="/cambiar-contrasena" replace />;

  return <>{children}</>;
};
