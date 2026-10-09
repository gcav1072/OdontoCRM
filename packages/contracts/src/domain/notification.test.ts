import { describe, expect, it } from 'vitest';

import { buildIcsEvent, escapeIcsText, foldIcsLine, icsFilename, toIcsDate } from './ics.js';
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

  it('el formato de fecha UTC es el de la norma', () => {
    expect(toIcsDate(new Date('2026-01-02T03:04:05Z'))).toBe('20260102T030405Z');
  });
});
