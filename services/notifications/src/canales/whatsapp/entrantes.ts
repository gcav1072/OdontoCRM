import {
  normalizeMessageContent,
  type WAMessage,
  type WAMessageContent,
} from '@whiskeysockets/baileys';

import type { InboundMessage } from '@odontocrm/contracts';

import { direccionDesdeJid } from './jid.js';

/**
 * De `WAMessage` de Baileys a `InboundMessage` del núcleo (ADR 0029).
 *
 * Es una función **pura**: no abre sockets ni toca la base. El llamador filtra
 * `messages.upsert` con `type === 'notify'` (los `append` son sincronización de
 * historial, no mensajes nuevos) y aquí se descartan grupos, estados, canales,
 * difusiones, los mensajes propios y los de protocolo/reacción (D11).
 */

const CONTENIDOS_IGNORADOS = new Set([
  'protocolMessage',
  'senderKeyDistributionMessage',
  'reactionMessage',
  'pollUpdateMessage',
  'pollCreationMessage',
  'pollCreationMessageV2',
  'pollCreationMessageV3',
  'keepInChatMessage',
  'messageContextInfo',
  'deviceSentMessage',
]);

const textoDe = (content: WAMessageContent): string | null => {
  const candidatos = [
    content.conversation,
    content.extendedTextMessage?.text,
    content.imageMessage?.caption,
    content.videoMessage?.caption,
    content.documentMessage?.caption,
    content.buttonsResponseMessage?.selectedDisplayText,
    content.listResponseMessage?.title,
  ];
  for (const candidato of candidatos) {
    if (typeof candidato === 'string' && candidato.trim() !== '') return candidato;
  }
  return null;
};

const accionDe = (content: WAMessageContent): string | null => {
  const boton = content.buttonsResponseMessage?.selectedButtonId;
  if (typeof boton === 'string' && boton.trim() !== '') return boton;
  const fila = content.listResponseMessage?.singleSelectReply?.selectedRowId;
  if (typeof fila === 'string' && fila.trim() !== '') return fila;
  return null;
};

const segundosDe = (valor: unknown, now: number): number => {
  if (typeof valor === 'number' && Number.isFinite(valor)) return valor;
  if (typeof valor === 'string' && valor.trim() !== '' && Number.isFinite(Number(valor))) {
    return Number(valor);
  }
  if (typeof valor === 'object' && valor !== null) {
    const toNumber = (valor as { toNumber?: () => number }).toNumber;
    if (typeof toNumber === 'function') {
      const numero = toNumber.call(valor);
      if (Number.isFinite(numero)) return numero;
    }
  }
  return Math.floor(now / 1000);
};

export const toInboundMessage = (
  message: WAMessage | null | undefined,
  options: { ahora?: Date; prefijoPorDefecto?: string } = {},
): InboundMessage | null => {
  if (message === null || message === undefined) return null;

  const key = message.key;
  if (key === undefined || key === null) return null;
  // Los mensajes propios (incluido lo que alguien escriba a mano desde el
  // teléfono del consultorio) no se reinyectan al asistente (D11/D12).
  if (key.fromMe === true) return null;

  const remoteJid = key.remoteJid ?? null;
  const direccion = direccionDesdeJid(
    remoteJid,
    key.remoteJidAlt ?? null,
    options.prefijoPorDefecto,
  );
  if (direccion === null) return null;

  const content = normalizeMessageContent(message.message);
  if (content === undefined || content === null) return null;

  const claves = Object.keys(content).filter((clave) => {
    const valor = (content as unknown as Record<string, unknown>)[clave];
    return valor !== null && valor !== undefined;
  });
  // Si todo lo que trae es protocolo/reacción, no hay nada que conversar; si
  // viene acompañado de un texto o un documento, se procesa igualmente.
  if (claves.length === 0 || claves.every((clave) => CONTENIDOS_IGNORADOS.has(clave))) {
    return null;
  }

  const eventoId = key.id ?? '';
  if (eventoId === '') return null;

  const ahora = options.ahora ?? new Date();
  const segundos = segundosDe(message.messageTimestamp, ahora.getTime());
  const fecha = new Date(segundos * 1000);
  const recibidoEn = Number.isNaN(fecha.getTime()) ? ahora : fecha;

  return {
    canal: 'whatsapp',
    direccion,
    usuario: message.pushName ?? null,
    // Un audio o una imagen sin pie llega con `texto: null`: el núcleo repite
    // el paso (no hay transcripción ni OCR que inventar).
    texto: textoDe(content),
    accion: accionDe(content),
    eventoId,
    recibidoEn: recibidoEn.toISOString(),
  };
};
