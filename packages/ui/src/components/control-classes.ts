/**
 * Piel común de los controles de formulario (input, select y textarea).
 *
 * Vive aquí y no en cada pantalla porque la cadena estaba **copiada en más de una
 * docena de archivos**: cualquier ajuste tiene que llegar a todos a la vez. Los
 * síntomas que lo motivaron fueron reales: en pantallas pequeñas el control
 * desbordaba su columna y tapaba la etiqueta o el texto de al lado.
 *
 * Tres decisiones que se explican solas:
 *
 *  - `min-w-0`: sin esto, un hijo de grid/flex conserva `min-width: auto` y su
 *    ancho mínimo es el del contenido, así que revienta la columna y se monta
 *    encima del vecino en vez de encogerse.
 *  - `text-sm` con **16 px en pantallas táctiles**: iOS/iPadOS hace un auto-zoom al
 *    enfocar un campo de menos de 16 px, y ese zoom es lo que dejaba la pantalla
 *    «descuadrada» y con solapes. Se usa el tipo de puntero (`pointer: coarse`) y no
 *    el ancho porque un iPad mide 768–1024 px —más que un portátil pequeño— y con un
 *    breakpoint de ancho se quedaba en 14 px y volvía a hacer zoom. En escritorio con
 *    ratón se mantiene 14 px para no cambiar la densidad. El `max-sm` es un respaldo
 *    por si el entorno no declara el puntero.
 *  - `w-full`: el control ocupa su columna; el ancho lo decide el contenedor.
 */
const CONTROL_VISUAL = [
  'w-full min-w-0 rounded-control border bg-surface text-sm text-ink shadow-xs transition-colors',
  'max-sm:text-base [@media(pointer:coarse)]:text-base',
  'placeholder:text-ink-subtle',
  'disabled:cursor-not-allowed disabled:bg-surface-muted disabled:text-ink-muted',
  'read-only:bg-surface-muted',
  'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-solid focus-visible:outline-focus',
].join(' ');

/**
 * Control de una línea (input, select): alto fijo y relleno horizontal. El color
 * del borde lo añade el componente, porque el estado inválido lo cambia a
 * `border-danger`.
 */
export const controlVisualClasses = CONTROL_VISUAL;

/**
 * Control de caja con su borde por defecto, para quien no distingue estado
 * inválido (p. ej. el `<textarea>` de las pantallas).
 */
export const controlBoxClasses = `${CONTROL_VISUAL} border-border-strong`;

/**
 * `<textarea>`: misma piel que el resto de controles, con relleno en las dos
 * direcciones en vez de alto fijo.
 */
export const textareaClasses = `${CONTROL_VISUAL} border-border-strong px-3 py-2`;
