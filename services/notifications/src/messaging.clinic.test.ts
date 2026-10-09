import { describe, expect, it } from 'vitest';

import { ClinicNotConfiguredError, clinicReady } from './messaging.js';

/**
 * El **gate del consultorio** (ADR 0058): mientras el titular no complete el registro, los
 * servicios que necesitan el nombre o la dirección **difieren** en vez de inventar identidad.
 * `clinicReady` es la comprobación que decide entre enviar y esperar; el error es lo que
 * lanza el generador de `.ics` si se le llama antes de tiempo.
 */
describe('gate del consultorio configurado', () => {
  it('está listo solo con nombre y dirección', () => {
    expect(clinicReady({ CLINIC_NAME: 'Consultorio de prueba', CLINIC_ADDRESS: 'Calle 1' })).toBe(
      true,
    );
  });

  it('sin configurar (o a medias) no está listo', () => {
    expect(clinicReady({})).toBe(false);
    expect(clinicReady({ CLINIC_NAME: 'Consultorio de prueba' })).toBe(false);
    expect(clinicReady({ CLINIC_ADDRESS: 'Calle 1' })).toBe(false);
  });

  it('el error de «consultorio sin configurar» tiene un nombre reconocible', () => {
    const error = new ClinicNotConfiguredError();
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ClinicNotConfiguredError');
    expect(error.message).toContain('consultorio');
  });
});
