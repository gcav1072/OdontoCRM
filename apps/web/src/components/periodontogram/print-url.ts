/**
 * Enlaces a la página de impresión del periodontograma.
 *
 * El switch «Piezas modeladas» del panel tiene que llegar al papel: el documento lo
 * abre el navegador en otra pestaña, así que la única forma de conservar la elección
 * es la URL. Sin parámetro la impresión sale con las siluetas encendidas (el valor
 * de fábrica), de modo que un enlace viejo o escrito a mano sigue funcionando.
 */

import { withQueryFlag } from '../../lib/print-url';

/** Nombre del parámetro de la URL. */
export const SILHOUETTES_PARAM = 'siluetas';

/**
 * Añade (o reemplaza) `siluetas=1|0` a una URL interna. Respeta la query existente
 * —`?examen=…&comparacion=…`— y no toca el fragmento.
 */
export const withSilhouettesParam = (url: string, enabled: boolean): string =>
  withQueryFlag(url, SILHOUETTES_PARAM, enabled);
