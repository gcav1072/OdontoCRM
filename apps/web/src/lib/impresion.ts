import { useEffect, useState } from 'react';

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

/* ── El papel: tamaño y márgenes (ajustables) ──────────────────────────────── */

/**
 * El margen del papel de los documentos que imprime el navegador (odontograma e
 * historia clínica). El tamaño está fijado en **carta** —es el que usa la clínica—;
 * lo que se ajusta desde la vista de impresión es cuánto blanco deja el borde.
 *
 * La regla `@page` de `index.css` trae el valor por defecto (15 mm) y sirve de red
 * cuando nadie la ajusta. Mientras una vista de impresión está montada, el margen
 * elegido la **sustituye** con una hoja de estilo propia.
 */
export const MARGEN_POR_DEFECTO_MM = 15;

/** Los límites del margen: por debajo de 5 mm la impresora se come el borde; por encima de 30 mm no cabe el documento. */
export const MARGEN_MIN_MM = 5;
export const MARGEN_MAX_MM = 30;

/**
 * El margen que se puede usar: un entero dentro de los límites. Lo que no sea un
 * número (o se salga del rango) cae en el valor por defecto o se recorta, para que
 * una tecla de más nunca deje el papel sin margen.
 */
export const normalizarMargen = (valor: number | string): number => {
  const numero = typeof valor === 'string' ? Number.parseInt(valor, 10) : Math.trunc(valor);
  if (!Number.isFinite(numero)) return MARGEN_POR_DEFECTO_MM;
  return Math.min(MARGEN_MAX_MM, Math.max(MARGEN_MIN_MM, numero));
};

/** La regla `@page` del papel: **carta** con el margen elegido. */
export const cssDePagina = (margenMm: number): string =>
  `@page { size: letter; margin: ${String(normalizarMargen(margenMm))}mm; }`;

/** Marca la hoja de estilo que pone el margen: es la que se busca para actualizarla. */
const ATRIBUTO_HOJA = 'data-odontocrm-margen';

/**
 * Margen de impresión **ajustable** desde la vista. Devuelve el valor actual y su
 * "setter"; mientras el componente está montado, la regla `@page` con ese margen
 * está puesta (y al salir se retira, para que no se quede pegada a otras pantallas).
 */
export const useMargenDeImpresion = (
  inicial: number = MARGEN_POR_DEFECTO_MM,
): readonly [number, (margenMm: number) => void] => {
  const [margen, setMargen] = useState(() => normalizarMargen(inicial));

  // La hoja se crea al montar y se retira al salir.
  useEffect(() => {
    const doc = globalThis.document;
    if (doc === undefined) return undefined;
    const hoja = doc.createElement('style');
    hoja.setAttribute(ATRIBUTO_HOJA, '');
    doc.head.append(hoja);
    return () => hoja.remove();
  }, []);

  // El contenido se reescribe cada vez que cambia el margen.
  useEffect(() => {
    const doc = globalThis.document;
    const hoja = doc?.head.querySelector<HTMLStyleElement>(`style[${ATRIBUTO_HOJA}]`);
    if (hoja !== null && hoja !== undefined) hoja.textContent = cssDePagina(margen);
  }, [margen]);

  return [margen, setMargen] as const;
};
