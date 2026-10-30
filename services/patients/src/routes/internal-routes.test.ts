import { CHANNELS } from '@odontocrm/contracts';
import { describe, expect, it } from 'vitest';

import { internalPatientChannelSchema } from './internal-routes.js';

/**
 * El alta interna de pacientes acepta **todos** los canales del catálogo.
 *
 * Nació de un fallo real: el borde tenía una lista copiada a mano sin `whatsapp`,
 * así que el último paso del alta por WhatsApp respondía 400 y el paciente solo
 * veía «ahora mismo no puedo consultar el sistema del consultorio». La lista se
 * cambió por `CHANNELS`; esta prueba impide que vuelva a quedarse corta.
 */
describe('canal del alta interna de pacientes', () => {
  it('acepta cada canal del catálogo compartido, incluido WhatsApp', () => {
    for (const channel of CHANNELS) {
      expect(internalPatientChannelSchema.parse({ channel }).channel).toBe(channel);
    }
    expect(CHANNELS).toContain('whatsapp');
  });

  it('sin canal explícito usa «registro», como el alta presencial', () => {
    expect(internalPatientChannelSchema.parse({}).channel).toBe('registro');
  });

  it('rechaza un canal que no existe', () => {
    expect(internalPatientChannelSchema.safeParse({ channel: 'instagram' }).success).toBe(false);
  });
});
