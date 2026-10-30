import { describe, expect, it } from 'vitest';

import { direccionDesdeJid, esLid, jidDesdeDireccion } from './jid.js';

describe('direcciones de WhatsApp (D6)', () => {
  it('un JID con número se guarda como dígitos E.164 sin +', () => {
    expect(direccionDesdeJid('584141234567@s.whatsapp.net', null)).toBe('584141234567');
    expect(direccionDesdeJid('584141234567:12@s.whatsapp.net', null)).toBe('584141234567');
  });

  it('un LID con número alternativo prefiere el número', () => {
    expect(direccionDesdeJid('123456789012345@lid', '584141234567@s.whatsapp.net')).toBe(
      '584141234567',
    );
  });

  it('un LID sin número alternativo conserva el JID completo', () => {
    expect(direccionDesdeJid('123456789012345@lid', null)).toBe('123456789012345@lid');
    expect(esLid('123456789012345@lid')).toBe(true);
    expect(esLid('584141234567@s.whatsapp.net')).toBe(false);
  });

  it('normaliza los números locales al enviar y respeta los JID', () => {
    expect(jidDesdeDireccion('0414-1234567')).toBe('584141234567@s.whatsapp.net');
    expect(jidDesdeDireccion('584141234567@s.whatsapp.net')).toBe('584141234567@s.whatsapp.net');
    expect(jidDesdeDireccion('123456789012345@lid')).toBe('123456789012345@lid');
  });

  it('no inventa direcciones de grupos o estados', () => {
    expect(direccionDesdeJid('123-456@g.us', null)).toBeNull();
    expect(direccionDesdeJid('status@broadcast', null)).toBeNull();
    expect(direccionDesdeJid('canal@newsletter', null)).toBeNull();
    expect(direccionDesdeJid(null, null)).toBeNull();
    expect(direccionDesdeJid('', null)).toBeNull();
  });
});
