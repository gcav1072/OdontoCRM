import { describe, expect, it } from 'vitest';

import { loadNotificationsConfig, telegramMode } from './config.js';

/**
 * Los datos del consultorio **no** salen del código (`CLINIC` es neutro, sin datos
 * personales): los sirve el registro del titular vía identity
 * (`aplicarDatosDelConsultorio`), que **pisa** lo que traiga el entorno. Sin configurar
 * quedan sin valor y los avisos que los necesitan se **difieren**.
 */
describe('datos del consultorio en las notificaciones', () => {
  it('sin el registro, quedan sin valor (no hay respaldo con datos)', () => {
    const config = loadNotificationsConfig({ DATABASE_URL: 'postgres://odonto/x' });
    expect(config.CLINIC_NAME).toBeUndefined();
    expect(config.CLINIC_ADDRESS).toBeUndefined();
    expect(config.CLINIC_EMAIL).toBeUndefined();
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
