import { useEffect, useState } from 'react';

/** Devuelve el valor tras un tiempo sin cambios: evita una consulta por tecla. */
export const useDebouncedValue = <T>(value: T, delayMs = 300): T => {
  const [diferido, setDiferido] = useState<T>(value);

  useEffect(() => {
    const temporizador = window.setTimeout(() => setDiferido(value), delayMs);
    return () => window.clearTimeout(temporizador);
  }, [value, delayMs]);

  return diferido;
};
