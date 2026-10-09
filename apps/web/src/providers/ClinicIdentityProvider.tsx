import { useQuery } from '@tanstack/react-query';
import { createContext, useContext, type ReactNode } from 'react';

import type { ClinicIdentityView } from '@odontocrm/contracts';

import { identityApi } from '../lib/endpoints';
import { CLINIC_IDENTITY_QUERY_KEY } from '../lib/queryKeys';
import { useAuth } from './AuthProvider';

/**
 * La **identidad del consultorio** para toda la interfaz (ADR 0056): nombre, RIF,
 * teléfonos, odontólogos y logo. La lee **una sola vez** este proveedor y la reparten
 * por contexto los componentes que la necesitan (el membrete y la marca de agua de los
 * imprimibles del navegador).
 *
 * **¿Por qué un contexto y no un hook con `useQuery` en cada componente?** Porque los
 * documentos imprimibles también se montan en las pruebas, sin proveedores de datos: con
 * el contexto, `null` significa «no lo sé» y el componente cae al respaldo del código
 * (`CLINIC`), en vez de reventar por falta de `QueryClientProvider`.
 *
 * **Sin sesión no se pide**: la identidad es del personal autenticado y pedirla antes de
 * restaurar la sesión daba 401 (la pantalla de login y el arranque en frío la disparaban
 * sin token). Por eso el proveedor vive **dentro** de `AuthProvider` y la consulta espera
 * a que haya sesión; el arranque en frío y el login no ensucian la red. Cuando se entra,
 * la consulta sale con el token ya puesto —`applyLoginResponse` la invalida para que se
 * refresque sin esperar al `staleTime`—.
 *
 * Se cachea con holgura (`staleTime` de 5 minutos): la identidad cambia rarísimas veces,
 * y quien la edita invalida la consulta al guardar.
 */
const ClinicIdentityContext = createContext<ClinicIdentityView | null>(null);

export const ClinicIdentityProvider = ({ children }: { children: ReactNode }) => {
  const { status } = useAuth();

  const consulta = useQuery({
    queryKey: CLINIC_IDENTITY_QUERY_KEY,
    queryFn: ({ signal }) => identityApi.clinic(signal),
    // Solo con sesión: sin ella la consulta daría 401 y no hay nada que mostrar.
    enabled: status === 'autenticado',
    staleTime: 5 * 60_000,
    // Si aun con sesión la consulta falla (permiso o red), no se reintenta en bucle: el
    // membrete cae al respaldo del código y ya está.
    retry: false,
  });

  return (
    <ClinicIdentityContext.Provider value={consulta.data ?? null}>
      {children}
    </ClinicIdentityContext.Provider>
  );
};

/** Expuesto para quien edita la identidad (invalidar la consulta al guardar). */
export { CLINIC_IDENTITY_QUERY_KEY };

/** La identidad del consultorio, o `null` si aún no se ha cargado (o no hay proveedor). */
export const useClinicIdentity = (): ClinicIdentityView | null => useContext(ClinicIdentityContext);
