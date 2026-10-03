/**
 * Consecutivo de tickets de solicitud de cita.
 *
 * Decisión del usuario (2026-10-02): mostrar `#000123` con una secuencia global
 * de PostgreSQL y, si algún día se superan 999.999 solicitudes, saltar
 * automáticamente a `A-000001`, luego `B-000001`, y así sucesivamente
 * (`Z`, `AA`, `AB`…). El número nunca se repite y nunca colisiona, porque el
 * valor lo entrega `nextval()` de una secuencia, que es atómico.
 */

export const TICKET_SEQUENCE_MAX = 999_999;

export interface TicketDisplay {
  /** Texto listo para mostrar y para dictar por teléfono. */
  value: string;
  /** Número dentro del ciclo actual (1 … 999.999). */
  number: number;
  /** 0 = sin prefijo (`#000123`), 1 = `A`, 2 = `B`… */
  cycle: number;
  /** Prefijo alfabético del ciclo (`''`, `A`, `B`, `AA`…). */
  prefix: string;
}

const ALPHABET_SIZE = 26;
const CODE_OF_A = 65;

/** Convierte el número de ciclo (1, 2, 27…) en su prefijo alfabético (A, B, AA…). */
export const cyclePrefix = (cycle: number): string => {
  if (!Number.isInteger(cycle) || cycle < 0) {
    throw new RangeError(`Ciclo de ticket inválido: ${String(cycle)}`);
  }
  let remaining = cycle;
  let prefix = '';
  while (remaining > 0) {
    const remainder = (remaining - 1) % ALPHABET_SIZE;
    prefix = String.fromCharCode(CODE_OF_A + remainder) + prefix;
    remaining = Math.floor((remaining - 1) / ALPHABET_SIZE);
  }
  return prefix;
};

/** Formatea el valor entregado por la secuencia de tickets. */
export const formatTicket = (sequenceValue: number): TicketDisplay => {
  if (!Number.isInteger(sequenceValue) || sequenceValue < 1) {
    throw new RangeError(`Valor de secuencia de ticket inválido: ${String(sequenceValue)}`);
  }
  const cycle = Math.floor((sequenceValue - 1) / TICKET_SEQUENCE_MAX);
  const number = ((sequenceValue - 1) % TICKET_SEQUENCE_MAX) + 1;
  const prefix = cyclePrefix(cycle);
  const digits = String(number).padStart(6, '0');
  return {
    value: prefix === '' ? `#${digits}` : `${prefix}-${digits}`,
    number,
    cycle,
    prefix,
  };
};

/**
 * Traduce lo que el paciente escribe en el bot (`#000123`, `A-000001`,
 * `000123`) a un valor comparable. Devuelve `null` si no es un ticket válido.
 */
export const parseTicket = (input: string): TicketDisplay | null => {
  const normalized = input.trim().toUpperCase().replace(/\s+/g, '');
  const match = /^(?:#|(?<prefix>[A-Z]{1,3})-?)?(?<digits>\d{1,6})$/.exec(normalized);
  if (!match?.groups) return null;

  const digits = Number(match.groups['digits']);
  if (!Number.isInteger(digits) || digits < 1 || digits > TICKET_SEQUENCE_MAX) return null;

  const prefix = match.groups['prefix'] ?? '';
  let cycle = 0;
  for (const character of prefix) {
    cycle = cycle * ALPHABET_SIZE + (character.charCodeAt(0) - CODE_OF_A + 1);
  }

  const sequenceValue = cycle * TICKET_SEQUENCE_MAX + digits;
  return formatTicket(sequenceValue);
};
