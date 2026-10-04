import { CLINIC } from '@odontocrm/contracts';
import { describe, expect, it } from 'vitest';

import { loadScreensConfig } from './config.js';

/** El nombre que sale en las pantallas es el del consultorio editable. */
describe('datos del consultorio en las pantallas', () => {
  it('el nombre por defecto es el de la sección editable', () => {
    const config = loadScreensConfig({ DATABASE_URL: 'postgres://odonto/x' });
    expect(config.CLINIC_NAME).toBe(CLINIC.name);
  });

  it('el `.env` puede sustituirlo sin tocar el código', () => {
    const config = loadScreensConfig({
      DATABASE_URL: 'postgres://odonto/x',
      CLINIC_NAME: 'Consultorio de prueba',
    });
    expect(config.CLINIC_NAME).toBe('Consultorio de prueba');
  });
});
