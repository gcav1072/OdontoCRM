import { useQuery } from '@tanstack/react-query';
import { createContext, useContext, type ReactNode } from 'react';

import type { ClinicIdentityView } from '@odontocrm/contracts';

import { identityApi } from '../lib/endpoints';

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
 * Se cachea con holgura (`staleTime` de 5 minutos): la identidad cambia rarísimas veces,
 * y quien la edita invalida la consulta al guardar.
 */
const ClinicIdentityContext = createContext<ClinicIdentityView | null>(null);

export const ClinicIdentityProvider = ({ children }: { children: ReactNode }) => {
  const consulta = useQuery({
    queryKey: ['identidad-consultorio'],
    queryFn: ({ signal }) => identityApi.clinic(signal),
    staleTime: 5 * 60_000,
    // En las pantallas públicas y kiosko (sin sesión) la consulta da 401: no se
    // reintenta en bucle, el miembrete cae al respaldo del código y ya está.
    retry: false,
  });

  return (
    <ClinicIdentityContext.Provider value={consulta.data ?? null}>
      {children}
    </ClinicIdentityContext.Provider>
  );
};

/** Expuesto para quien edita la identidad (invalidar la consulta al guardar). */
export const CLINIC_IDENTITY_QUERY_KEY = ['identidad-consultorio'] as const;

/** La identidad del consultorio, o `null` si aún no se ha cargado (o no hay proveedor). */
export const useClinicIdentity = (): ClinicIdentityView | null => useContext(ClinicIdentityContext);
