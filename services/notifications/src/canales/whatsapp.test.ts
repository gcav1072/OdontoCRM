import { createHmac } from 'node:crypto';
import type { InboundMessage } from '@odontocrm/contracts';
import { describe, expect, it } from 'vitest';

import { loadNotificationsConfig } from '../config.js';
import { createWhatsAppAdapter, toInboundMessages, validateSignature } from './whatsapp.js';

/**
 * Detalles del adaptador de WhatsApp que el kit de conformidad no cubre: la
 * normalización del webhook de Meta y que un mensaje fallido no tumbe el lote.
 */
const config = loadNotificationsConfig({
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgres://odonto_notifications:clave@127.0.0.1:5432/odonto_notifications',
});

const credentials = {
  token: 'token-de-prueba-para-la-prueba',
  phoneNumberId: '1234567890',
  verifyToken: 'verify-token-de-prueba',
  appSecret: 'app-secret-de-prueba',
};

const payload = (mensajes: { from: string; id: string; texto?: string; accion?: string }[]) =>
  JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '1',
        changes: [
          {
            field: 'messages',
            value: {
              contacts: [{ profile: { name: 'María' }, wa_id: mensajes[0]?.from ?? '' }],
              messages: mensajes.map((mensaje) => ({
                from: mensaje.from,
                id: mensaje.id,
                timestamp: '1791000000',
                type: mensaje.accion === undefined ? 'text' : 'interactive',
                ...(mensaje.accion === undefined
                  ? { text: { body: mensaje.texto ?? '' } }
                  : {
                      interactive: {
                        type: 'button_reply',
                        button_reply: { id: mensaje.accion, title: 'opción' },
                      },
                    }),
              })),
            },
          },
        ],
      },
    ],
  });

describe('adaptador de WhatsApp: webhook de Meta', () => {
  it('normaliza los mensajes y sus botones', () => {
    const entrantes = toInboundMessages(
      JSON.parse(payload([{ from: '584121234567', id: 'wamid.1', texto: 'quiero una cita' }])),
    );

    expect(entrantes).toHaveLength(1);
    expect(entrantes[0]).toMatchObject({
      canal: 'whatsapp',
      direccion: '584121234567',
      usuario: 'María',
      texto: 'quiero una cita',
      accion: null,
      eventoId: 'wamid.1',
    });
    expect(entrantes[0]?.recibidoEn).toContain('T');

    const boton = toInboundMessages(
      JSON.parse(payload([{ from: '584121234567', id: 'wamid.2', accion: 'doc:V' }])),
    );
    expect(boton[0]).toMatchObject({ accion: 'doc:V', texto: 'opción' });
  });

  it('la firma de Meta se valida sobre el cuerpo exacto', () => {
    const cuerpo = payload([{ from: '584121234567', id: 'wamid.3', texto: 'hola' }]);
    const firma = `sha256=${createHmac('sha256', credentials.appSecret).update(cuerpo, 'utf8').digest('hex')}`;

    expect(validateSignature(cuerpo, firma, credentials.appSecret)).toBe(true);
    // Un cuerpo manipulado (o sin firma) no pasa.
    expect(validateSignature(`${cuerpo} `, firma, credentials.appSecret)).toBe(false);
    expect(validateSignature(cuerpo, undefined, credentials.appSecret)).toBe(false);
    expect(validateSignature(cuerpo, 'sha1=1234', credentials.appSecret)).toBe(false);
  });

  it('un mensaje que falla no tumba el lote y queda contado', async () => {
    const entregados: InboundMessage[] = [];
    const errores: string[] = [];
    const adapter = createWhatsAppAdapter({
      credentials,
      config,
      onInbound: async (entrante) => {
        if (entrante.direccion === '584120000000') throw new Error('destinatario bloqueado');
        entregados.push(entrante);
      },
      onError: (error) => errores.push(error instanceof Error ? error.message : String(error)),
    });

    const cuerpo = payload([
      { from: '584120000000', id: 'wamid.4', texto: 'falla' },
      { from: '584129999999', id: 'wamid.5', texto: 'llega' },
    ]);
    const firma = `sha256=${createHmac('sha256', credentials.appSecret).update(cuerpo, 'utf8').digest('hex')}`;

    const respuesta = await adapter.webhook?.({
      metodo: 'POST',
      query: {},
      headers: { 'x-hub-signature-256': firma },
      rawBody: cuerpo,
      json: JSON.parse(cuerpo) as unknown,
    });

    expect(respuesta?.estado).toBe(200);
    expect(respuesta?.cuerpo).toEqual({ recibidos: 2, fallidos: 1 });
    expect(entregados).toHaveLength(1);
    expect(errores).toEqual(['destinatario bloqueado']);
  });
});
