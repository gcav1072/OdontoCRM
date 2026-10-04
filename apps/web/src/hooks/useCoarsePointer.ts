import { useEffect, useState } from 'react';

/**
 * `true` cuando el dispositivo apunta con el **dedo** (o con un lápiz) y no con un
 * ratón: `pointer: coarse`.
 *
 * El odontograma lo usan dos cosas muy distintas: un ratón (con teclado, donde
 * acertar una cara de 12 px es razonable) y una tableta en el consultorio, donde
 * no lo es. Con esto la interfaz decide **cómo** se toca una pieza: con ratón se
 * pulsa la cara concreta; con el dedo, la pieza entera abre la hoja de botones
 * grandes y nadie tiene que apuntar a un polígono diminuto.
 *
 * Se escucha el cambio de `matchMedia` (una tableta con teclado conectado cambia de
 * puntero sin recargar) y en un entorno sin `matchMedia` se asume ratón.
 */
const CONSULTA = '(pointer: coarse)';

const leer = (): boolean =>
  typeof globalThis.matchMedia === 'function' ? globalThis.matchMedia(CONSULTA).matches : false;

export const useCoarsePointer = (): boolean => {
  const [grueso, setGrueso] = useState<boolean>(leer);

  useEffect(() => {
    if (typeof globalThis.matchMedia !== 'function') return;

    const consulta = globalThis.matchMedia(CONSULTA);
    const alCambiar = (event: MediaQueryListEvent): void => setGrueso(event.matches);

    setGrueso(consulta.matches);
    consulta.addEventListener('change', alCambiar);
    return () => consulta.removeEventListener('change', alCambiar);
  }, []);

  return grueso;
};
