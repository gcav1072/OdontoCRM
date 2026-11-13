import { describe, expect, it } from 'vitest';

import {
  documentChannelOptions,
  documentSendInput,
  documentSendMessageKey,
  groupDocumentChannels,
} from './document-send';
import type { PatientChannel } from '@odontocrm/contracts';

/** Un vínculo completo; los campos que no importan al caso toman un valor neutro. */
const canal = (
  id: string,
  channel: PatientChannel['channel'],
  overrides: Partial<PatientChannel> = {},
): PatientChannel => ({
  id,
  patientId: '11111111-1111-4111-8111-111111111111',
  patientName: 'María Pérez',
  channel,
  direccionMasked: `••• ${id}`,
  usuario: null,
  linkedAt: '2026-11-01T10:00:00.000Z',
  lastInboundAt: null,
  isPrimary: false,
  isBlocked: false,
  ...overrides,
});

describe('documentChannelOptions', () => {
  it('solo ofrece canales que llevan documentos (Telegram y WhatsApp)', () => {
    const opciones = documentChannelOptions([
      canal('1', 'telefono'),
      canal('2', 'whatsapp'),
      canal('3', 'registro'),
      canal('4', 'telegram'),
    ]);

    expect(opciones.map((opcion) => opcion.id)).toEqual(['2', '4']);
    expect(opciones.map((opcion) => opcion.channel)).toEqual(['whatsapp', 'telegram']);
  });

  it('conserva el orden del servidor: el principal va primero', () => {
    const opciones = documentChannelOptions([
      canal('principal', 'whatsapp', { isPrimary: true }),
      canal('otro', 'whatsapp'),
      canal('telegram', 'telegram'),
    ]);

    expect(opciones[0]?.id).toBe('principal');
    expect(opciones[0]?.isPrimary).toBe(true);
    expect(opciones[1]?.id).toBe('otro');
  });

  it('no inventa campos: copia el id, el canal y la dirección enmascarada', () => {
    expect(documentChannelOptions([canal('1', 'telegram')])).toEqual([
      {
        id: '1',
        channel: 'telegram',
        direccionMasked: '••• 1',
        isPrimary: false,
      },
    ]);
  });
});

describe('groupDocumentChannels', () => {
  it('agrupa varios vínculos del mismo canal sin perder ninguno', () => {
    const grupos = groupDocumentChannels([
      canal('w1', 'whatsapp', { isPrimary: true }),
      canal('w2', 'whatsapp'),
      canal('t1', 'telegram'),
    ]);

    expect(grupos.map((grupo) => grupo.channel)).toEqual(['telegram', 'whatsapp']);
    expect(grupos[0]?.options.map((opcion) => opcion.id)).toEqual(['t1']);
    expect(grupos[1]?.options.map((opcion) => opcion.id)).toEqual(['w1', 'w2']);
  });

  it('omite los grupos sin vínculos y respeta el orden Telegram → WhatsApp', () => {
    const soloWhatsApp = groupDocumentChannels([canal('w1', 'whatsapp')]);

    expect(soloWhatsApp).toHaveLength(1);
    expect(soloWhatsApp[0]?.channel).toBe('whatsapp');
  });

  it('sin canales documentales devuelve una lista vacía', () => {
    expect(groupDocumentChannels([])).toEqual([]);
    expect(groupDocumentChannels([canal('1', 'telefono')])).toEqual([]);
  });
});

describe('documentSendInput', () => {
  it('manda el vínculo elegido y el id de idempotencia del clic', () => {
    expect(
      documentSendInput({
        kind: 'prescription',
        entityId: '22222222-2222-4222-8222-222222222222',
        patientId: '11111111-1111-4111-8111-111111111111',
        channelId: '33333333-3333-4333-8333-333333333333',
        clientRequestId: '44444444-4444-4444-8444-444444444444',
      }),
    ).toEqual({
      kind: 'prescription',
      entityId: '22222222-2222-4222-8222-222222222222',
      patientId: '11111111-1111-4111-8111-111111111111',
      channelId: '33333333-3333-4333-8333-333333333333',
      clientRequestId: '44444444-4444-4444-8444-444444444444',
    });
  });

  it('omite los opcionales en vez de mandarlos como undefined', () => {
    const cuerpo = documentSendInput({
      kind: 'invoice',
      entityId: '22222222-2222-4222-8222-222222222222',
      patientId: '11111111-1111-4111-8111-111111111111',
    });

    expect(Object.keys(cuerpo).sort()).toEqual(['entityId', 'kind', 'patientId']);
    expect('channelId' in cuerpo).toBe(false);
    expect('clientRequestId' in cuerpo).toBe(false);
  });
});

describe('documentSendMessageKey', () => {
  it('distingue el envío encolado del duplicado', () => {
    expect(documentSendMessageKey({ status: 'queued' })).toBe('notificaciones.envio.encolado');
    expect(documentSendMessageKey({ status: 'duplicado' })).toBe('notificaciones.envio.duplicado');
  });
});
