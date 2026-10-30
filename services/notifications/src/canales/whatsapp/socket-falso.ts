import type { BaileysEventMap, WAMessage, WASocket } from '@whiskeysockets/baileys';

import type { WhatsAppSocket } from './sesion.js';

type Handler = (arg: unknown) => void;

/**
 * Socket de doble para las pruebas de la sesión y del kit de conformidad.
 *
 * No pretende imitar WhatsApp: solo emite los mismos eventos que Baileys y
 * registra lo que el adaptador envía. La fábrica de la sesión lo inyecta, así
 * que las pruebas no abren red ni necesitan una sesión real.
 */
export class FakeWhatsAppSocket implements WhatsAppSocket {
  private readonly handlers = new Map<string, Handler[]>();
  readonly enviados: { jid: string; contenido: unknown }[] = [];
  readonly presencias: { estado: string; jid: string | undefined }[] = [];
  logoutCalls = 0;
  endCalls = 0;
  pairingCode = 'ABCD-1234';
  user: WASocket['user'] = undefined;

  ev = {
    on: <T extends keyof BaileysEventMap>(
      evento: T,
      handler: (arg: BaileysEventMap[T]) => void,
    ): void => {
      const lista = this.handlers.get(evento) ?? [];
      lista.push(handler as Handler);
      this.handlers.set(evento, lista);
    },
    removeAllListeners: (evento?: keyof BaileysEventMap): void => {
      if (evento === undefined) this.handlers.clear();
      else this.handlers.delete(evento);
    },
  };

  emit<T extends keyof BaileysEventMap>(evento: T, arg: BaileysEventMap[T]): void {
    for (const handler of this.handlers.get(evento) ?? []) handler(arg);
  }

  sendMessage = (async (jid: string, contenido: unknown) => {
    this.enviados.push({ jid, contenido });
    const mensaje = {
      key: { remoteJid: jid, fromMe: true, id: `fake-${String(this.enviados.length)}` },
      message: { conversation: 'texto' in (contenido as object) ? 'texto' : '' },
    };
    return mensaje as WAMessage;
  }) as WASocket['sendMessage'];

  requestPairingCode = (async () => this.pairingCode) as WASocket['requestPairingCode'];

  sendPresenceUpdate = (async (estado: string, jid?: string) => {
    this.presencias.push({ estado, jid });
  }) as WASocket['sendPresenceUpdate'];

  logout = (async () => {
    this.logoutCalls += 1;
  }) as WASocket['logout'];

  end = (async () => {
    this.endCalls += 1;
  }) as WASocket['end'];
}
