import { CLINIC, clinicFullAddress } from '@odontocrm/contracts';
import { describe, expect, it } from 'vitest';

import { loadNotificationsConfig } from './config.js';

/** Los mensajes del bot se firman con los datos del consultorio editable. */
describe('datos del consultorio en las notificaciones', () => {
  it('el nombre, la dirección y el correo salen de la sección editable', () => {
    const config = loadNotificationsConfig({ DATABASE_URL: 'postgres://odonto/x' });
    expect(config.CLINIC_NAME).toBe(CLINIC.name);
    expect(config.CLINIC_ADDRESS).toBe(clinicFullAddress());
    expect(config.CLINIC_EMAIL).toBe(CLINIC.email);
  });

  it('el `.env` puede sustituirlos sin tocar el código', () => {
    const config = loadNotificationsConfig({
      DATABASE_URL: 'postgres://odonto/x',
      CLINIC_NAME: 'Consultorio de prueba',
      CLINIC_EMAIL: 'hola@consultorio.local',
    });
    expect(config.CLINIC_NAME).toBe('Consultorio de prueba');
    expect(config.CLINIC_EMAIL).toBe('hola@consultorio.local');
  });
});
