/**
 * Identificadores de agregados que **no** tienen id propio.
 *
 * `stableUuid` (`@odontocrm/kernel`) deriva un UUID determinista de una clave natural,
 * así que el mismo hecho produce siempre el mismo identificador y sus eventos se
 * agrupan y se pueden buscar en la auditoría. Se usa para los cambios de horario, que
 * no tienen fila propia (el agregado es «el día N de la semana»).
 */
import { stableUuid } from '@odontocrm/kernel';

export { stableUuid };
