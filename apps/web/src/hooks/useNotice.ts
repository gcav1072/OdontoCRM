import type { AlertVariant } from '@odontocrm/ui';
import { useCallback, useState } from 'react';

/** Aviso en línea que se muestra tras una operación (éxito o error). */
export interface Notice {
  variant: AlertVariant;
  title?: string;
  message: string;
}

export interface UseNoticeResult {
  notice: Notice | null;
  mostrar: (notice: Notice) => void;
  exito: (message: string, title?: string) => void;
  error: (message: string, title?: string) => void;
  limpiar: () => void;
}

/**
 * Aviso efímero para las páginas con formularios: se escribe el mensaje
 * (ya traducido) y la página lo pinta con `<Alert>`.
 */
export const useNotice = (): UseNoticeResult => {
  const [notice, setNotice] = useState<Notice | null>(null);

  const mostrar = useCallback((nuevo: Notice) => setNotice(nuevo), []);
  const limpiar = useCallback(() => setNotice(null), []);
  const exito = useCallback((message: string, title?: string) => {
    setNotice(
      title === undefined
        ? { variant: 'success', message }
        : { variant: 'success', title, message },
    );
  }, []);
  const error = useCallback((message: string, title?: string) => {
    setNotice(
      title === undefined ? { variant: 'danger', message } : { variant: 'danger', title, message },
    );
  }, []);

  return { notice, mostrar, exito, error, limpiar };
};
