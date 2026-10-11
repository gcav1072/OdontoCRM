import { describe, expect, it } from 'vitest';

import {
  ICS_FORMAT_VERSION,
  ICS_PRODID,
  buildIcsEvent,
  escapeIcsParam,
  escapeIcsText,
  foldIcsLine,
  icsFilename,
  icsFormatVersionOf,
  toIcsDate,
} from './ics.js';
import {
  ANTI_FLOOD_MAX_MESSAGES,
  DEFAULT_MESSAGE_TEMPLATES,
  NOTIFICATION_MAX_ATTEMPTS,
  NOTIFICATION_RETRY_DELAYS_SECONDS,
  NOTIFICATION_TEMPLATE_KEYS,
  botDraftSchema,
  markContactedSchema,
  maskDocument,
  maskPhone,
  messageTemplateInputSchema,
  normalizeBotName,
  parseBotDate,
  renderMessage,
} from './notification.js';

describe('asistente: nombre', () => {
  it('colapsa espacios, quita números y emojis y pone mayúsculas de título', () => {
    expect(normalizeBotName('  maría   pérez 123 🦷 ').value).toBe('María Pérez');
    expect(normalizeBotName("o'brien fernández").value).toBe("O'Brien Fernández");
    expect(normalizeBotName('JEAN-CARLOS  boada').value).toBe('Jean-Carlos Boada');
  });

  it('rechaza lo que no es un nombre', () => {
    expect(normalizeBotName('12').ok).toBe(false);
    expect(normalizeBotName('ab').ok).toBe(false);
    expect(normalizeBotName('🙂🙂🙂').ok).toBe(false);
    expect(normalizeBotName('a'.repeat(130)).ok).toBe(false);
  });
});

describe('asistente: fecha de nacimiento', () => {
  const now = new Date('2026-10-03T12:00:00Z');

  it('acepta dd/mm/aaaa, dd-mm-aaaa y el año de dos cifras', () => {
    expect(parseBotDate('15/05/1990', now)).toEqual({ ok: true, value: '1990-05-15' });
    expect(parseBotDate('1-2-1985', now)).toEqual({ ok: true, value: '1985-02-01' });
    expect(parseBotDate('07.11.99', now)).toEqual({ ok: true, value: '1999-11-07' });
  });

  it('rechaza fechas imposibles, futuras y de más de 120 años', () => {
    expect(parseBotDate('31/02/1990', now).ok).toBe(false);
    expect(parseBotDate('01/01/2030', now).ok).toBe(false);
    expect(parseBotDate('01/01/1850', now).ok).toBe(false);
    expect(parseBotDate('ayer', now).ok).toBe(false);
  });
});

describe('asistente: datos enmascarados', () => {
  it('deja ver solo el final del documento y del teléfono', () => {
    expect(maskDocument('V', '12345678')).toBe('V-•••••678');
    expect(maskPhone('+584121234567')).toBe('+58412•••••••');
  });
});

describe('plantillas de mensajes', () => {
  it('todas las claves del catálogo tienen su plantilla por defecto', () => {
    const keys = DEFAULT_MESSAGE_TEMPLATES.map((template) => template.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of NOTIFICATION_TEMPLATE_KEYS) expect(keys).toContain(key);
  });

  it('los marcadores declarados aparecen en el texto', () => {
    for (const template of DEFAULT_MESSAGE_TEMPLATES) {
      for (const placeholder of template.placeholders) {
        expect(template.body).toContain(`{${placeholder}}`);
      }
    }
  });

  it('la confirmación de cita usa la misma redacción que la vista previa de la agenda', () => {
    const confirmation = DEFAULT_MESSAGE_TEMPLATES.find(
      (template) => template.key === 'cita_confirmada',
    );
    expect(confirmation?.body).toContain('{fecha}');
    expect(confirmation?.body).toContain('{hora}');
    expect(confirmation?.body).toContain('{lugar}');
    expect(confirmation?.body).toContain('{ticket}');
  });

  it('renderiza y deja los marcadores que falten', () => {
    const texto = renderMessage('Hola {paciente}, ticket {ticket}. {otro}', {
      paciente: 'María',
      ticket: '#000123',
      otro: null,
    });
    expect(texto).toBe('Hola María, ticket #000123. {otro}');
  });

  it('valida la edición de una plantilla', () => {
    expect(messageTemplateInputSchema.safeParse({ body: '' }).success).toBe(false);
    expect(messageTemplateInputSchema.safeParse({ body: 'Hola {paciente}' }).success).toBe(true);
  });
});

describe('anti-flood y reintentos', () => {
  it('los límites son los del plan', () => {
    expect(ANTI_FLOOD_MAX_MESSAGES).toBe(10);
    expect(NOTIFICATION_RETRY_DELAYS_SECONDS).toEqual([60, 300, 900, 3600, 21600]);
    expect(NOTIFICATION_MAX_ATTEMPTS).toBe(6);
  });

  it('el aviso manual exige una nota', () => {
    expect(markContactedSchema.safeParse({ note: 'ok' }).success).toBe(false);
    expect(markContactedSchema.safeParse({ note: 'llamada a las 10, confirmó' }).success).toBe(
      true,
    );
  });
});

describe('borrador de la conversación', () => {
  it('empieza vacío y admite los datos que llegan paso a paso', () => {
    const empty = botDraftSchema.parse({});
    expect(empty.fullName).toBeNull();

    const filled = botDraftSchema.parse({
      fullName: 'María Pérez',
      docType: 'V',
      docNumber: '12345678',
      phone: '+584121234567',
      birthDate: '1990-05-15',
      sex: 'F',
      reason: 'Dolor en la muela del juicio',
    });
    expect(filled.docType).toBe('V');
    expect(botDraftSchema.safeParse({ docType: 'X' }).success).toBe(false);
  });
});

describe('.ics de la cita', () => {
  const input = {
    uid: '00000000-0000-4000-8000-000000000000',
    sequence: 1,
    start: new Date('2026-10-05T12:30:00Z'),
    end: new Date('2026-10-05T13:00:00Z'),
    summary: 'Cita odontológica · ticket #000123',
    description: 'Paciente: María Pérez\nMotivo: limpieza',
    location: 'Calle de prueba 123',
    organizerName: 'Consultorio de prueba',
    organizerEmail: 'citas@odontocrm.local',
    attendeeName: 'María Pérez',
    stamp: new Date('2026-10-02T10:00:00Z'),
  };

  it('arma un VCALENDAR válido con las horas en UTC', () => {
    const ics = buildIcsEvent(input);
    const lines = ics.split('\r\n');

    expect(lines[0]).toBe('BEGIN:VCALENDAR');
    expect(ics).toContain('VERSION:2.0');
    expect(ics).toContain('BEGIN:VEVENT');
    expect(ics).toContain('DTSTART:20261005T123000Z');
    expect(ics).toContain('DTEND:20261005T130000Z');
    expect(ics).toContain('DTSTAMP:20261002T100000Z');
    expect(ics).toContain('SEQUENCE:1');
    expect(ics).toContain('STATUS:CONFIRMED');
    expect(ics).toContain('UID:00000000-0000-4000-8000-000000000000@odontocrm.local');
    expect(ics).toContain('BEGIN:VALARM');
    expect(ics).toContain('TRIGGER:-PT30M');
    expect(ics.trimEnd().endsWith('END:VCALENDAR')).toBe(true);
    // Todas las líneas terminan en CRLF, como pide la norma.
    expect(ics.endsWith('\r\n')).toBe(true);
  });

  it('escapa los caracteres especiales y los saltos de línea', () => {
    const ics = buildIcsEvent(input);
    expect(ics).toContain('DESCRIPTION:Paciente: María Pérez\\nMotivo: limpieza');
    expect(escapeIcsText('uno; dos, tres\\cuatro')).toBe('uno\\; dos\\, tres\\\\cuatro');
    // Un `\r` suelto también: crudo partiría la línea por la mitad.
    expect(escapeIcsText('uno\rdos')).toBe('uno\\ndos');
    expect(escapeIcsParam('sin nada raro')).toBe('"sin nada raro"');
  });

  it('pliega las líneas largas a 75 octetos', () => {
    const long = `DESCRIPTION:${'a'.repeat(200)}`;
    const folded = foldIcsLine(long);
    for (const line of folded.split('\r\n')) {
      expect(Buffer.from(line, 'utf8').byteLength).toBeLessThanOrEqual(75);
    }
    expect(folded.split('\r\n').length).toBeGreaterThan(2);
    // Al desplegar vuelve a ser la línea original.
    expect(folded.replace(/\r\n /g, '')).toBe(long);
  });

  it('respeta los acentos al plegar (no corta un carácter a la mitad)', () => {
    const line = `SUMMARY:${'á'.repeat(100)}`;
    const folded = foldIcsLine(line);
    expect(folded.replace(/\r\n /g, '')).toBe(line);
  });

  it('el nombre del archivo adjunto es el esperado', () => {
    expect(icsFilename('#000123', input.uid)).toBe('cita-000123.ics');
    expect(icsFilename(null, input.uid)).toBe(`cita-${input.uid.slice(0, 8)}.ics`);
  });

  it('marca la cancelación cuando corresponde', () => {
    const ics = buildIcsEvent({ ...input, status: 'CANCELLED', sequence: 2 });
    expect(ics).toContain('STATUS:CANCELLED');
    expect(ics).toContain('SEQUENCE:2');
  });

  it('el `PRODID` lleva la versión del formato, y se puede leer de un archivo guardado', () => {
    // La versión es lo que permite rehacer un `.ics` que quedó guardado con un formato
    // viejo (si no, un arreglo no llegaría a las citas que ya lo tienen).
    const ics = buildIcsEvent(input);
    expect(ics).toContain(`PRODID:${ICS_PRODID}`);
    expect(ics).toContain(`Agenda ${String(ICS_FORMAT_VERSION)}//ES`);
    expect(icsFormatVersionOf(ics)).toBe(ICS_FORMAT_VERSION);

    // Un archivo de antes de la marca: hay que rehacerlo.
    expect(icsFormatVersionOf('PRODID:-//OdontoCRM//Agenda//ES\r\n')).toBe(0);
    expect(icsFormatVersionOf('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n')).toBe(0);
  });

  it('el formato de fecha UTC es el de la norma', () => {
    expect(toIcsDate(new Date('2026-01-02T03:04:05Z'))).toBe('20260102T030405Z');
  });

  it('entrecomilla los parámetros con coma, punto y coma o dos puntos', () => {
    // El defecto que hacía que el `.ics` «no abriera» en el celular: el nombre del
    // consultorio real suele traer coma («…, C.A.») y se escapaba con barras, que es la
    // regla de los **valores**, no la de los **parámetros** (RFC 5545 §3.2).
    const ics = buildIcsEvent({ ...input, organizerName: 'Clínica Sonrisa, C.A.' });
    expect(ics).toContain('ORGANIZER;CN="Clínica Sonrisa, C.A.":mailto:citas@odontocrm.local');
    expect(ics).not.toContain('CN=Clínica Sonrisa\\, C.A.');
  });

  it('un punto y coma o dos puntos en el nombre no rompe la propiedad', () => {
    const ics = buildIcsEvent({
      ...input,
      organizerName: 'Odontología: Dra. Gómez; y asociados',
    });
    // Sin comillas, el primer `:` cortaría la línea y el `;` crearía un parámetro falso.
    expect(ics).toContain('ORGANIZER;CN="Odontología: Dra. Gómez; y asociados":mailto:');
    expect(ics).not.toContain('CN=Odontología:');
  });

  it('el nombre del paciente con coma también va entrecomillado', () => {
    const ics = buildIcsEvent({ ...input, attendeeName: 'Pérez, Ana' });
    expect(ics).toContain('ATTENDEE;CN="Pérez, Ana";ROLE=REQ-PARTICIPANT:mailto:');
  });

  it('codifica comillas y acentos del nombre según RFC 6868', () => {
    const ics = buildIcsEvent({ ...input, organizerName: 'Clínica "Sonrisa" ^ Ñandú' });
    expect(ics).toContain('ORGANIZER;CN="Clínica ^\'Sonrisa^\' ^^ Ñandú":mailto:');
  });

  it('un salto de línea en el nombre no parte el archivo en dos', () => {
    // El nombre del consultorio puede venir en dos líneas (ADR 0064): en un parámetro no
    // cabe un salto. Y un `\r` suelto en un valor tampoco (partiría la línea).
    const ics = buildIcsEvent({
      ...input,
      organizerName: 'Consultorio\nOdontológico',
      description: 'Paciente: Ana\rMotivo: control',
    });
    expect(ics).toContain('ORGANIZER;CN="Consultorio Odontológico":mailto:');
    expect(ics).toContain('DESCRIPTION:Paciente: Ana\\nMotivo: control');
    // La estructura sobrevive: al desplegar, cada línea es una propiedad.
    for (const linea of ics.replace(/\r\n /g, '').split('\r\n').slice(0, -1)) {
      expect(linea).toMatch(/^[A-Z0-9-]+(;[^:]*)?:/);
    }
  });

  it('un organizador sin correo no deja un mailto vacío', () => {
    const ics = buildIcsEvent({ ...input, organizerEmail: '  ' });
    expect(ics).toContain(':mailto:noreply@odontocrm.local');
    expect(ics).not.toContain(':mailto:\r\n');
  });

  it('todas las líneas quedan dentro de los 75 octetos con un nombre largo', () => {
    const ics = buildIcsEvent({
      ...input,
      organizerName: `Clínica Odontológica ${'Sonrisa, C.A. '.repeat(6)}`,
    });
    for (const linea of ics.split('\r\n').slice(0, -1)) {
      expect(Buffer.from(linea, 'utf8').byteLength).toBeLessThanOrEqual(75);
    }
    // Y al desplegar, el nombre entrecomillado sigue entero.
    expect(ics.replace(/\r\n /g, '')).toContain('Sonrisa, C.A.":mailto:');
  });
});
