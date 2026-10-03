import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';

import { FullScreenLoader } from '../../components/FullScreenLoader';
import { t } from '../../lib/i18n';
import { useAuth } from '../../providers/AuthProvider';

/**
 * Puerta de entrada: mientras se restaura la sesión se muestra la espera y, si
 * no hay sesión, se va a `/login` guardando a dónde quería llegar el usuario.
 */
export const RequireAuth = ({ children }: { children: ReactNode }) => {
  const { status } = useAuth();
  const location = useLocation();

  if (status === 'cargando') return <FullScreenLoader label={t('sesion.restaurando')} />;

  if (status === 'anonimo') {
    return (
      <Navigate to="/login" replace state={{ desde: `${location.pathname}${location.search}` }} />
    );
  }

  return <>{children}</>;
};
