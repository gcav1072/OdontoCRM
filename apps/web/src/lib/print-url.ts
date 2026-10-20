/**
 * Parámetros de la URL que llevan una preferencia de la vista al papel.
 *
 * Los imprimibles se abren en otra pestaña (o en otro equipo, si se copia el enlace),
 * así que la única forma de que el papel salga como la pantalla es la query. La
 * preferencia guardada en `localStorage` **no** viaja: el documento no la ve.
 *
 * Lo usan el periodontograma (`?siluetas=`) y el odontograma (`?piezas=`), y la
 * lógica vive en un solo sitio para que los dos se comporten igual: se reemplaza el
 * valor si ya estaba, se respeta el resto de la query y no se toca el fragmento.
 */

/** Valor de la query para un flag: `1` encendido, `0` apagado. */
export const withQueryFlag = (url: string, name: string, enabled: boolean): string => {
  const [conQuery, hash = ''] = url.split('#', 2) as [string, string?];
  const [ruta, query = ''] = conQuery.split('?', 2) as [string, string?];
  const params = new URLSearchParams(query);
  params.set(name, enabled ? '1' : '0');
  const sufijo = hash === '' ? '' : `#${hash}`;
  return `${ruta}?${params.toString()}${sufijo}`;
};

/**
 * Lee un flag de la query. `undefined` si no viene (o si no es `0`/`1`): así cada
 * página decide su valor de fábrica en vez de heredar uno inventado.
 */
export const queryFlag = (value: string | null): boolean | undefined => {
  if (value === '1') return true;
  if (value === '0') return false;
  return undefined;
};
