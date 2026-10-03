import { QueryClient } from '@tanstack/react-query';

import { ApiError } from './api';

/**
 * Cliente de TanStack Query. Los 4xx no se reintentan (la respuesta no va a
 * cambiar: faltó un permiso o los datos son inválidos); los fallos de red o del
 * servidor sí, una sola vez, para no castigar al backend con una tormenta.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (intentos, error) => {
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
        return intentos < 1;
      },
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
    mutations: {
      retry: false,
    },
  },
});
