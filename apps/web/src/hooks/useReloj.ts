import { useEffect, useState } from 'react';

/**
 * La hora **actual**, viva, para el reloj de la pantalla.
 *
 * Se actualiza justo al cambiar de minuto (y no cada segundo): el televisor solo
 * muestra `HH:MM`, así que re-renderizar sesenta veces por minuto sería tirar trabajo.
 * Al alinear el temporizador con el próximo minuto, el reloj nunca se queda atrás ni
 * un segundo de más.
 *
 * Devuelve un `Date` para que quien lo pinte lo formatee con `formatTime` (la zona del
 * consultorio), sin duplicar aquí las reglas del ADR 0025.
 */
export const useReloj = (): Date => {
  const [ahora, setAhora] = useState<Date>(() => new Date());

  useEffect(() => {
    let temporizador: number | undefined;

    const programar = (): void => {
      // Milisegundos que faltan para el próximo minuto, con 50 de margen.
      const restante = 60_000 - (Date.now() % 60_000) + 50;
      temporizador = window.setTimeout(() => {
        setAhora(new Date());
        programar();
      }, restante);
    };

    programar();
    return () => {
      if (temporizador !== undefined) window.clearTimeout(temporizador);
    };
  }, []);

  return ahora;
};
