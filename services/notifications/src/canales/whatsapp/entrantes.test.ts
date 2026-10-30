import type { WAMessage } from '@whiskeysockets/baileys';
import { describe, expect, it } from 'vitest';

import { toInboundMessage } from './entrantes.js';

const mensaje = (overrides: {
  key?: Record<string, unknown>;
  message?: Record<string, unknown> | null;
  pushName?: string;
  messageTimestamp?: number;
}): WAMessage =>
  ({
    key: {
      remoteJid: '584141234567@s.whatsapp.net',
      fromMe: false,
      id: '3EB0ABCDEF',
      ...overrides.key,
    },
    message: overrides.message === undefined ? { conversation: 'hola' } : overrides.message,
    pushName: overrides.pushName ?? 'María Pérez',
    messageTimestamp: overrides.messageTimestamp ?? 1_791_000_000,
  }) as unknown as WAMessage;

describe('entrantes de Baileys', () => {
  it('normaliza texto y conserva el eventoId de la clave del mensaje', () => {
    const entrante = toInboundMessage(mensaje({}));
    expect(entrante).toMatchObject({
      canal: 'whatsapp',
      direccion: '584141234567',
      usuario: 'María Pérez',
      texto: 'hola',
      accion: null,
      eventoId: '3EB0ABCDEF',
    });
    expect(entrante?.recibidoEn).toBe(new Date(1_791_000_000_000).toISOString());
  });

  it('lee el texto extendido y el pie de una imagen', () => {
    expect(
      toInboundMessage(mensaje({ message: { extendedTextMessage: { text: 'quiero cita' } } }))
        ?.texto,
    ).toBe('quiero cita');
    expect(
      toInboundMessage(
        mensaje({ message: { imageMessage: { caption: 'mi documento', mimetype: 'image/jpeg' } } }),
      )?.texto,
    ).toBe('mi documento');
  });

  it('procesa el texto aunque venga acompañado de una clave de distribución', () => {
    const entrante = toInboundMessage(
      mensaje({
        message: {
          senderKeyDistributionMessage: { groupId: 'x' },
          conversation: 'hola con sobre',
        },
      }),
    );
    expect(entrante?.texto).toBe('hola con sobre');
  });

  it('un audio sin pie llega con texto nulo para que el núcleo repita el paso', () => {
    const entrante = toInboundMessage(
      mensaje({ message: { audioMessage: { mimetype: 'audio/ogg', ptt: true } } }),
    );
    expect(entrante).not.toBeNull();
    expect(entrante?.texto).toBeNull();
  });

  it('descarta grupos, estados, canales, mensajes propios y protocolo', () => {
    expect(toInboundMessage(mensaje({ key: { remoteJid: '123-456@g.us' } }))).toBeNull();
    expect(toInboundMessage(mensaje({ key: { remoteJid: 'status@broadcast' } }))).toBeNull();
    expect(toInboundMessage(mensaje({ key: { remoteJid: 'canal@newsletter' } }))).toBeNull();
    expect(toInboundMessage(mensaje({ key: { fromMe: true } }))).toBeNull();
    expect(toInboundMessage(mensaje({ message: { protocolMessage: { type: 0 } } }))).toBeNull();
    expect(toInboundMessage(mensaje({ message: { reactionMessage: { text: '❤️' } } }))).toBeNull();
  });

  it('con LID prefiere el número alternativo; sin él conserva el JID', () => {
    const conAlt = toInboundMessage(
      mensaje({
        key: { remoteJid: '123456789012345@lid', remoteJidAlt: '584141234567@s.whatsapp.net' },
      }),
    );
    expect(conAlt?.direccion).toBe('584141234567');

    const sinAlt = toInboundMessage(mensaje({ key: { remoteJid: '123456789012345@lid' } }));
    expect(sinAlt?.direccion).toBe('123456789012345@lid');
  });

  it('conserva la acción de una respuesta interactiva si algún día llega', () => {
    const entrante = toInboundMessage(
      mensaje({
        message: {
          buttonsResponseMessage: {
            selectedButtonId: 'confirmar_cita:abc',
            selectedDisplayText: 'Confirmar',
          },
        },
      }),
    );
    expect(entrante?.accion).toBe('confirmar_cita:abc');
    expect(entrante?.texto).toBe('Confirmar');
  });
});
