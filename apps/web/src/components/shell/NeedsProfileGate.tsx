import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';

import { useAuth } from '../../providers/AuthProvider';

/**
 * Un odontólogo que todavía no completó su **perfil profesional** (MPPS, especialidad…)
 * no puede usar el sistema: el gate lo lleva a `/completar-perfil` y solo deja seguir
 * cuando lo ha rellenado.
 *
 * Es el hermano de `MustChangePasswordGate` y el reflejo exacto de lo que hace el
 * servidor: mientras `needsProfile` sea `true`, el JWT no lleva permisos y el gateway
 * corta todo lo que no sea auth o identity (ADR 0056). No es una regla de la interfaz
 * que se pueda esquivar: es el mismo blindaje que la contraseña temporal.
 *
 * `App.tsx` deja `/completar-perfil` fuera del shell para que no haya adónde navegar
 * mientras falte el perfil.
 */
export const NeedsProfileGate = ({ children }: { children: ReactNode }) => {
  const { needsProfile } = useAuth();

  if (needsProfile) return <Navigate to="/completar-perfil" replace />;

  return <>{children}</>;
};
