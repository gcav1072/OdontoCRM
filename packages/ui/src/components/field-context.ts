import { createContext, useContext } from 'react';

/**
 * Estado compartido entre `Field` y sus controles: así el `<label>`, el
 * `aria-invalid` y la descripción (`hint`/error) quedan enlazados sin que cada
 * formulario tenga que repetir identificadores a mano.
 */
export interface FieldControlState {
  id: string;
  invalid: boolean;
  required: boolean;
  describedBy?: string;
}

export const FieldContext = createContext<FieldControlState | null>(null);

/** Devuelve el estado del `Field` que envuelve al control, si lo hay. */
export const useFieldControl = (): FieldControlState | null => useContext(FieldContext);
