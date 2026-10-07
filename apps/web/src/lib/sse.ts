/**
 * Lector de `text/event-stream` para la interfaz.
 *
 * Los flujos en vivo de la aplicación —las pantallas kiosko y el canal del personal— se
 * abren con `fetch` y **no** con `EventSource`, porque `EventSource` no permite mandar la
 * cabecera `Authorization` y todos nuestros flujos van autenticados. Eso obliga a leer el
 * cuerpo a mano: aquí está esa parte, una sola vez, para que los dos consumidores no
 * acaben con dos interpretaciones distintas del mismo protocolo.
 *
 * Lo que hace es **partir tramas** y nada más: no sabe de estados ni de avisos, no
 * reconecta y no decide nada. De eso se encarga quien llama.
 */

/** Una trama SSE ya separada de sus líneas. */
export interface TramaSse {
  /** `id:` de la trama (para `Last-Event-ID`), o `null` si no venía. */
  id: string | null;
  /** `event:` de la trama, o `null` si no venía (entonces es un mensaje por defecto). */
  evento: string | null;
  /** Cuerpo ya unido: las líneas `data:` separadas son una sola cadena. */
  datos: string;
}

/** Convierte el texto de una trama en sus campos. `null` si no traía datos. */
export const parsearTramaSse = (bruto: string): TramaSse | null => {
  let id: string | null = null;
  let evento: string | null = null;
  const datos: string[] = [];

  for (const linea of bruto.split('\n')) {
    // Una línea que empieza por `:` es un comentario: así viaja el keepalive.
    if (linea.startsWith(':')) continue;
    if (linea.startsWith('event:')) evento = linea.slice(6).trim();
    else if (linea.startsWith('id:')) id = linea.slice(3).trim();
    else if (linea.startsWith('data:')) datos.push(linea.slice(5).trimStart());
  }

  // Sin `data` no hay mensaje: el `retry:` y los comentarios se ignoran solos.
  if (datos.length === 0) return null;
  return { id: id === '' ? null : id, evento, datos: datos.join('\n') };
};

/**
 * Lee el cuerpo de una respuesta SSE y entrega cada trama. Termina cuando el servidor
 * cierra el flujo; si la petición se aborta, el `read()` rechaza y el error sube a quien
 * llama (que es el único que sabe si era una cancelación esperada).
 */
export const leerTramas = async (
  respuesta: Response,
  onTrama: (trama: TramaSse) => void,
): Promise<void> => {
  const lector = respuesta.body?.getReader();
  if (lector === undefined) throw new Error('La respuesta no trae cuerpo');

  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { value, done } = await lector.read();
    if (done === true) return;
    buffer += decoder.decode(value, { stream: true });

    // Las tramas se separan con una línea en blanco; el resto queda en el buffer.
    let corte = buffer.indexOf('\n\n');
    while (corte !== -1) {
      const bruto = buffer.slice(0, corte);
      buffer = buffer.slice(corte + 2);
      corte = buffer.indexOf('\n\n');

      const trama = parsearTramaSse(bruto);
      if (trama !== null) onTrama(trama);
    }
  }
};
