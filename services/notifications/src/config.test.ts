import { CLINIC, clinicFullAddress } from '@odontocrm/contracts';
import { describe, expect, it } from 'vitest';

import { loadNotificationsConfig, telegramMode } from './config.js';

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

/**
 * El bloqueo que pide el plan §12: con el modo test activo **ningún mensaje sale
 * a un paciente**, ni aunque el bot tenga token de verdad.
 */
describe('modo test: los envíos reales quedan bloqueados', () => {
  const conToken = {
    DATABASE_URL: 'postgres://odonto/x',
    TELEGRAM_BOT_TOKEN: '1234567890:token-de-prueba-del-modo-test',
    TELEGRAM_BOT_USERNAME: 'bot_de_prueba',
  };

  it('con token y sin modo test, el bot es el real', () => {
    expect(telegramMode(loadNotificationsConfig(conToken))).toBe('real');
  });

  it('con modo test activo, el bot pasa a simulado aunque haya token', () => {
    const config = loadNotificationsConfig({
      ...conToken,
      TEST_MODE: 'true',
      ALLOW_TEST_MODE: 'true',
    });

    expect(telegramMode(config)).toBe('simulado');
  });

  it('en producción el modo test no se activa y el token manda', () => {
    const config = loadNotificationsConfig({
      ...conToken,
      NODE_ENV: 'production',
      TEST_MODE: 'true',
      ALLOW_TEST_MODE: 'true',
    });

    expect(telegramMode(config)).toBe('real');
  });

  it('pedir el modo test sin permiso no bloquea nada (la bandera sola no basta)', () => {
    expect(telegramMode(loadNotificationsConfig({ ...conToken, TEST_MODE: 'true' }))).toBe('real');
  });
});
