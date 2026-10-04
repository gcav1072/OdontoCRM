import { CLINIC, clinicFullAddress } from '@odontocrm/contracts';
import { describe, expect, it } from 'vitest';

import { loadSchedulingConfig } from './config.js';

/**
 * Los datos del consultorio salen de `CLINIC` (`packages/contracts/src/clinic.ts`),
 * no de un literal repartido por el código: si alguien vuelve a escribir el nombre a
 * mano, esta prueba lo dice.
 */
describe('datos del consultorio en la agenda', () => {
  it('el nombre y la dirección por defecto son los de la sección editable', () => {
    const config = loadSchedulingConfig({ DATABASE_URL: 'postgres://odonto/x' });
    expect(config.CLINIC_NAME).toBe(CLINIC.name);
    expect(config.CLINIC_ADDRESS).toBe(clinicFullAddress());
  });

  it('el `.env` puede sustituirlos sin tocar el código', () => {
    const config = loadSchedulingConfig({
      DATABASE_URL: 'postgres://odonto/x',
      CLINIC_NAME: 'Consultorio de prueba',
      CLINIC_ADDRESS: 'Otra dirección',
    });
    expect(config.CLINIC_NAME).toBe('Consultorio de prueba');
    expect(config.CLINIC_ADDRESS).toBe('Otra dirección');
  });
});
