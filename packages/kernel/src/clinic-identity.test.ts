import type { LetterheadSnapshot } from '@odontocrm/contracts';
import { describe, expect, it } from 'vitest';

import { aplicarDatosDelConsultorio } from './clinic-identity.js';

/**
 * `aplicarDatosDelConsultorio` es el **cable** entre el registro del consultorio
 * (identity) y la configuración de los servicios que solo necesitan el nombre, la
 * dirección y el correo en textos (el bot, el `.ics` y las pantallas).
 *
 * Esta prueba existe por un fallo real: cuando los campos pasaron a ser **opcionales**,
 * el guard `if (config.CAMPO !== undefined)` dejaba de entrar (zod **omite** la clave
 * ausente) y el dato **nunca** se escribía; el bot saludaba «…de .» y el aviso salía sin
 * lugar. La comprobación de que el valor se **escribe** (no solo que el tipo encaja) es la
 * que lo habría cazado.
 */
const snapshot = (clinic: Partial<LetterheadSnapshot['clinic']>): LetterheadSnapshot => ({
  clinic: {
    name: '',
    legalName: null,
    address: '',
    city: null,
    phones: [],
    email: null,
    rif: null,
    website: null,
    logoPath: null,
    dentists: [],
    ...clinic,
  },
  dentist: null,
  logoDataUri: null,
  version: 'prueba',
});

const lookupDe = (value: LetterheadSnapshot) => async () => value;

describe('aplicarDatosDelConsultorio', () => {
  it('escribe el nombre, la dirección y el correo del registro en la configuración', async () => {
    const config: {
      CLINIC_NAME?: string | undefined;
      CLINIC_ADDRESS?: string | undefined;
      CLINIC_EMAIL?: string | undefined;
    } = {};

    await aplicarDatosDelConsultorio(
      config,
      lookupDe(
        snapshot({
          name: 'Consultorio de prueba',
          address: 'Calle de prueba 123',
          city: 'Maturín',
          email: 'citas@prueba.local',
        }),
      ),
    );

    expect(config.CLINIC_NAME).toBe('Consultorio de prueba');
    // La dirección se compone con la ciudad (`clinicFullAddress`).
    expect(config.CLINIC_ADDRESS).toBe('Calle de prueba 123, Maturín');
    expect(config.CLINIC_EMAIL).toBe('citas@prueba.local');
  });

  it('sin consultorio configurado deja los campos sin valor (no inventa identidad)', async () => {
    const config: {
      CLINIC_NAME?: string | undefined;
      CLINIC_ADDRESS?: string | undefined;
      CLINIC_EMAIL?: string | undefined;
    } = { CLINIC_NAME: 'viejo' };

    await aplicarDatosDelConsultorio(config, lookupDe(snapshot({})));

    expect(config.CLINIC_NAME).toBeUndefined();
    expect(config.CLINIC_ADDRESS).toBeUndefined();
    expect(config.CLINIC_EMAIL).toBeUndefined();
  });

  it('funciona aunque la configuración solo declare CLINIC_NAME (screens)', async () => {
    const config: { CLINIC_NAME?: string | undefined } = {};

    await aplicarDatosDelConsultorio(
      config,
      lookupDe(snapshot({ name: 'Consultorio de prueba', address: 'Calle 1' })),
    );

    expect(config.CLINIC_NAME).toBe('Consultorio de prueba');
  });

  it('ignora los espacios en blanco como «no configurado»', async () => {
    const config: {
      CLINIC_NAME?: string | undefined;
      CLINIC_ADDRESS?: string | undefined;
    } = {};

    await aplicarDatosDelConsultorio(config, lookupDe(snapshot({ name: '   ', address: '   ' })));

    expect(config.CLINIC_NAME).toBeUndefined();
    expect(config.CLINIC_ADDRESS).toBeUndefined();
  });
});
