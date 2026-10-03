import { createHash } from 'node:crypto';

/**
 * Generador de `.ics` (RFC 5545) para las citas.
 *
 * Decisiones:
 * - Las horas van en **UTC** (`...Z`): así el archivo abre con la hora correcta en
 *   Google Calendar, Apple Calendario y Outlook sin depender de que el cliente
 *   entienda la zona del consultorio. La interfaz y los mensajes siguen mostrando
 *   12 h (ADR 0025).
 * - Incluye `SEQUENCE`, que se incrementa al reprogramar: los calendarios
 *   actualizan el evento en lugar de duplicarlo.
 * - Las líneas se pliegan a 75 octetos y se separan con CRLF, como manda la norma.
 * - Un recordatorio (`VALARM`) 30 minutos antes.
 */

export interface IcsEventInput {
  /** Identificador estable del evento (se usa el de la cita). */
  uid: string;
  /** Versión del evento: se incrementa al reprogramar. */
  sequence: number;
  /** Inicio y fin en UTC. */
  start: Date;
  end: Date;
  summary: string;
  description: string;
  location: string;
  organizerName: string;
  organizerEmail: string;
  attendeeName: string;
  /** Cuándo se generó el archivo (por defecto, ahora). */
  stamp?: Date;
  status?: 'CONFIRMED' | 'CANCELLED';
}

/** Escapa texto según RFC 5545 (barras, comas, puntos y comas y saltos de línea). */
export const escapeIcsText = (value: string): string =>
  value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

/** Formato de fecha UTC: `20261005T123000Z`. */
export const toIcsDate = (date: Date): string =>
  `${date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z')}`;

/**
 * Pliega una línea a 75 octetos (las continuaciones empiezan con un espacio), que
 * es lo que exige la norma para que los clientes no corten el texto a su aire.
 */
export const foldIcsLine = (line: string): string => {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.byteLength <= 75) return line;

  const parts: string[] = [];
  let current = Buffer.alloc(0);
  let limit = 75;
  for (const character of line) {
    const chunk = Buffer.from(character, 'utf8');
    if (current.byteLength + chunk.byteLength > limit) {
      parts.push(current.toString('utf8'));
      current = Buffer.alloc(0);
      limit = 74; // las continuaciones llevan un espacio delante
    }
    current = Buffer.concat([current, chunk]);
  }
  if (current.byteLength > 0) parts.push(current.toString('utf8'));

  return parts.map((part, index) => (index === 0 ? part : ` ${part}`)).join('\r\n');
};

export const buildIcsEvent = (input: IcsEventInput): string => {
  const stamp = input.stamp ?? new Date();
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//OdontoCRM//Agenda//ES',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${input.uid}@odontocrm.local`,
    `DTSTAMP:${toIcsDate(stamp)}`,
    `DTSTART:${toIcsDate(input.start)}`,
    `DTEND:${toIcsDate(input.end)}`,
    `SEQUENCE:${String(input.sequence)}`,
    `STATUS:${input.status ?? 'CONFIRMED'}`,
    `SUMMARY:${escapeIcsText(input.summary)}`,
    `DESCRIPTION:${escapeIcsText(input.description)}`,
    `LOCATION:${escapeIcsText(input.location)}`,
    `ORGANIZER;CN=${escapeIcsText(input.organizerName)}:mailto:${input.organizerEmail}`,
    `ATTENDEE;CN=${escapeIcsText(input.attendeeName)};ROLE=REQ-PARTICIPANT:mailto:noreply@odontocrm.local`,
    'BEGIN:VALARM',
    'TRIGGER:-PT30M',
    'ACTION:DISPLAY',
    `DESCRIPTION:${escapeIcsText(`Recordatorio: ${input.summary}`)}`,
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ];

  return `${lines.map(foldIcsLine).join('\r\n')}\r\n`;
};

/** Huella del archivo: se guarda junto al `.ics` para poder auditarlo. */
export const icsSha256 = (content: string): string =>
  createHash('sha256').update(content, 'utf8').digest('hex');

/** Nombre del archivo adjunto: `cita-000123.ics`. */
export const icsFilename = (ticket: string | null, appointmentId: string): string => {
  const suffix = ticket === null ? appointmentId.slice(0, 8) : ticket.replace(/[^A-Za-z0-9]/g, '');
  return `cita-${suffix}.ics`;
};
