import { useEffect } from 'react';

/**
 * **El papel es blanco.**
 *
 * Las páginas imprimibles (odontograma, historia clínica) usan los mismos tokens de
 * color que el resto de la aplicación, y esos tokens cambian con el tema oscuro. Si
 * el equipo está en modo oscuro, el informe salía con la paleta oscura: en pantalla
 * se veía raro y en papel, directamente mal (barras oscuras, líneas claras sobre
 * blanco, dibujos del odontograma casi invisibles).
 *
 * La solución es no depender del tema: mientras una página imprimible está montada,
 * se quita la clase `dark` de `<html>` —con eso los tokens vuelven a su valor
 * claro— y se restaura al salir, para no cambiarle el tema a nadie.
 *
 * La parte de decidir y restaurar está separada de React a propósito: así se puede
 * probar sin navegador (ver `impresion.test.ts`).
 */

/** Lo mínimo que se necesita de `<html>`: se acepta cualquier objeto con `classList`. */
export interface RaizConTema {
  classList: {
    contains: (clase: string) => boolean;
    add: (clase: string) => void;
    remove: (clase: string) => void;
  };
}

const CLASE_OSCURO = 'dark';

/**
 * Quita el tema oscuro de la raíz y **devuelve si lo tenía**, para poder restaurarlo.
 */
export const aplicarTemaClaro = (raiz: RaizConTema): boolean => {
  const estabaOscuro = raiz.classList.contains(CLASE_OSCURO);
  raiz.classList.remove(CLASE_OSCURO);
  return estabaOscuro;
};

/** Restaura el tema que había antes de {@link aplicarTemaClaro}. */
export const restaurarTema = (raiz: RaizConTema, estabaOscuro: boolean): void => {
  if (estabaOscuro) raiz.classList.add(CLASE_OSCURO);
};

/**
 * Hook para las páginas que se imprimen: fuerza el tema claro mientras están
 * montadas y devuelve el tema del usuario al salir.
 */
export const useTemaClaroParaImprimir = (): void => {
  useEffect(() => {
    const raiz = globalThis.document?.documentElement;
    if (raiz === undefined) return undefined;
    const estabaOscuro = aplicarTemaClaro(raiz);
    return () => {
      restaurarTema(raiz, estabaOscuro);
    };
  }, []);
};
