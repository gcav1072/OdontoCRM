import { describe, expect, it } from 'vitest';

import { loadSchedulingConfig } from './config.js';

/**
 * Los datos del consultorio **no** salen del código (`CLINIC` es neutro): los sirve el
 * registro del titular vía identity (`aplicarDatosDelConsultorio`). Sin configurar quedan
 * sin valor y el aviso se **difiere**.
 */
describe('datos del consultorio en la agenda', () => {
  it('sin el registro, quedan sin valor (no hay respaldo con datos)', () => {
    const config = loadSchedulingConfig({ DATABASE_URL: 'postgres://odonto/x' });
    expect(config.CLINIC_NAME).toBeUndefined();
    expect(config.CLINIC_ADDRESS).toBeUndefined();
  });
});
