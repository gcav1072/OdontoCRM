import { useQueryClient } from '@tanstack/react-query';
import { useEffect, type ReactNode } from 'react';

import { abrirFlujoStaff, invalidacionesDe } from '../lib/realtime';
import { useAuth } from './AuthProvider';

/**
 * Sincronización en vivo para el personal.
 *
 * Abre el canal `staff` del servicio de pantallas mientras hay sesión y traduce cada aviso
 * en invalidar las consultas que quedaron viejas: cerrar una sesión en el consultorio hace
 * que la fila de `/flujo` cambie de estado y que el cobro aparezca en `/caja` **sin tocar
 * nada**. Es lo que la recepción hacía a mano recargando la página o cerrando un diálogo.
 *
 * No pinta nada y no guarda estado propio: si el canal se cae, la aplicación sigue
 * funcionando como antes (con los datos del último pedido) mientras reintenta por detrás.
 *
 * Se monta **dentro** de `AuthProvider` (necesita saber si hay sesión) y de
 * `QueryClientProvider` (necesita invalidar). Es a propósito: sin sesión no se abre canal,
 * así que la pantalla de acceso y las pantallas kiosko no lo usan.
 */
export const RealtimeSyncProvider = ({ children }: { children: ReactNode }) => {
  const { status } = useAuth();
  const cliente = useQueryClient();

  useEffect(() => {
    if (status !== 'autenticado') return undefined;

    return abrirFlujoStaff({
      onSenal: (senal) => {
        for (const clave of invalidacionesDe(senal.topic)) {
          // `invalidateQueries` solo vuelve a pedir lo que está montado: refrescar la
          // caché de una pantalla que nadie mira sería trabajo perdido.
          void cliente.invalidateQueries({ queryKey: clave });
        }
      },
    });
  }, [status, cliente]);

  return <>{children}</>;
};
