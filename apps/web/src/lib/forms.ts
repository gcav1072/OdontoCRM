import type { FieldValues, Path, UseFormSetError } from 'react-hook-form';

import { isApiError } from './api';

/**
 * Vuelca en el formulario los errores por campo que devuelve la API
 * (`errors: [{ path, message }]` del RFC 7807). El servidor nombra los campos
 * igual que los esquemas de `@odontocrm/contracts`, así que coinciden sin
 * traducción; si un `path` no existe en el formulario, react-hook-form lo
 * ignora y el mensaje general sigue visible en el aviso de la página.
 */
export const applyApiFieldErrors = <T extends FieldValues>(
  setError: UseFormSetError<T>,
  error: unknown,
): boolean => {
  if (!isApiError(error)) return false;

  let aplicado = false;
  for (const [path, message] of Object.entries(error.fieldErrors)) {
    setError(path as Path<T>, { type: 'servidor', message });
    aplicado = true;
  }
  return aplicado;
};
