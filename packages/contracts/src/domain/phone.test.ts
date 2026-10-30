import { describe, expect, it } from 'vitest';

import { isWhatsAppJid, toE164Digits } from './phone.js';

describe('toE164Digits', () => {
  it('convierte los formatos locales venezolanos al E.164 sin +', () => {
    expect(toE164Digits('0414-1234567')).toBe('584141234567');
    expect(toE164Digits('04141234567')).toBe('584141234567');
    expect(toE164Digits('4141234567')).toBe('584141234567');
    expect(toE164Digits('+58 414 123 4567')).toBe('584141234567');
    expect(toE164Digits('0058 414 1234567')).toBe('584141234567');
    expect(toE164Digits('584141234567')).toBe('584141234567');
  });

  it('respeta un prefijo distinto y los números de otro país ya completos', () => {
    expect(toE164Digits('04141234567', '57')).toBe('574141234567');
    expect(toE164Digits('+34 612 345 678')).toBe('34612345678');
    expect(toE164Digits('34612345678')).toBe('34612345678');
  });

  it('sin dígitos devuelve la cadena vacía', () => {
    expect(toE164Digits('  ')).toBe('');
    expect(toE164Digits('sin número')).toBe('');
  });
});

describe('isWhatsAppJid', () => {
  it('reconoce los JID que se envían tal cual y no confunde un teléfono', () => {
    expect(isWhatsAppJid('584141234567@s.whatsapp.net')).toBe(true);
    expect(isWhatsAppJid('123456789012345@lid')).toBe(true);
    expect(isWhatsAppJid('584141234567')).toBe(false);
    expect(isWhatsAppJid('584141234567@example.com')).toBe(false);
  });
});
