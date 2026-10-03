import { useEffect, useState } from 'react';

/**
 * Reloj de la interfaz: se refresca cada `intervalMs` para que las reglas que
 * dependen de la hora (la tolerancia de la inasistencia) se activen solas sin
 * recargar la jornada. Vive en el componente que lo necesita, así el resto de
 * la pantalla no se vuelve a dibujar por el tic.
 */
export const useNow = (intervalMs = 30_000): Date => {
  const [ahora, setAhora] = useState(() => new Date());

  useEffect(() => {
    const temporizador = window.setInterval(() => setAhora(new Date()), intervalMs);
    return () => window.clearInterval(temporizador);
  }, [intervalMs]);

  return ahora;
};
