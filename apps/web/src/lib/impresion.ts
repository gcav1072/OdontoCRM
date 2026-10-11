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

/* ── Las fuentes del papel (que la impresión no caiga al respaldo) ───────────── */

/** Lo mínimo que se necesita de `document.fonts`; en las pruebas se pasa un doble. */
export interface FuentesDelDocumento {
  ready: Promise<unknown>;
  load?: (font: string) => Promise<unknown>;
}

/** Una familia de la marca tal como la ve la SPA: su nombre y sus archivos con peso/estilo. */
export interface FamiliaDeFuente {
  name: string;
  files: readonly { weight: number; style: string }[];
}

/**
 * Espera a que las fuentes del documento terminen de cargar antes de mandar a imprimir.
 *
 * Las `@font-face` de la marca van con `font-display: swap`: el navegador pinta el texto
 * con la **sans del sistema** y lo cambia a la fuente real cuando termina de cargarla. En
 * pantalla la vista ya se «swap»-eó y se ve bien, pero si se imprime justo en ese hueco el
 * papel sale con la tipografía equivocada —el bug del membrete—. Esperar a
 * `document.fonts.ready` cierra el hueco. Si algo falla, se imprime igual: un documento
 * nunca puede quedarse sin sacar por una fuente.
 */
export const esperarFuentes = async (
  fuentes: FuentesDelDocumento | undefined = globalThis.document?.fonts,
): Promise<void> => {
  if (fuentes === undefined) return;
  try {
    await fuentes.ready;
  } catch {
    /* imprimir igual */
  }
};

/**
 * Pide por adelantado las familias de la marca que ya están declaradas (`@font-face`).
 *
 * Con `font-display: swap`, la fuente no se pide hasta que se pinta algo con ella: la
 * **vista previa** de un documento puede quedarse un instante en el respaldo y el papel
 * (si se manda a imprimir enseguida) también. Adelantar la carga hace que el cambio de
 * tipografía llegue cuanto antes. Una familia sin `@font-face` (por ejemplo una subida que
 * nadie referencia) no se puede cargar: `load` falla y se ignora.
 */
export const precargarFuentes = (
  familias: readonly FamiliaDeFuente[],
  fuentes: FuentesDelDocumento | undefined = globalThis.document?.fonts,
): void => {
  if (fuentes === undefined || fuentes.load === undefined) return;
  for (const familia of familias) {
    const variantes = new Set(
      familia.files.map(
        (file) => `${file.style === 'italic' ? 'italic ' : ''}${String(file.weight)}`,
      ),
    );
    for (const variante of variantes) {
      void fuentes.load(`${variante} 1em "${familia.name}"`).catch(() => undefined);
    }
  }
};
