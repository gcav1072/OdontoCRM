import { describe, expect, it } from 'vitest';

import { loadScreensConfig } from './config.js';

/**
 * El nombre que sale en las pantallas **no** viene del código (`CLINIC` es neutro): lo
 * sirve el registro del titular vía identity (`aplicarDatosDelConsultorio`). Mientras no
 * esté, la cabecera sale sin nombre.
 */
describe('datos del consultorio en las pantallas', () => {
  it('sin el registro, el nombre queda sin valor', () => {
    const config = loadScreensConfig({ DATABASE_URL: 'postgres://odonto/x' });
    expect(config.CLINIC_NAME).toBeUndefined();
  });
});
