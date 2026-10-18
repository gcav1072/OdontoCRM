/**
 * Identificadores de agregados que **no** tienen id propio.
 *
 * El cupo de un día se identifica por su clave natural (fecha + consultorio) y el
 * sobre de los eventos exige un UUID: `stableUuid` (`@odontocrm/kernel`) deriva uno
 * determinista, así que el mismo día produce siempre el mismo identificador y sus
 * eventos se agrupan y se pueden buscar en la auditoría.
 */
import { stableUuid } from '@odontocrm/kernel';

export { stableUuid };

/** Identificador estable del cupo de un **consultorio** en un día (clave `date + chair`). */
export const dayCapacityId = (date: string, chairId: string): string =>
  stableUuid(`day_capacity:${date}:${chairId}`);
