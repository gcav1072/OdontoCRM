import { ConfigError } from '@odontocrm/kernel';
import { describe, expect, it } from 'vitest';

import { loadReportingConfig } from './config.js';

/**
 * La configuración se valida al arrancar: si falta la base, el servicio **no debe
 * arrancar** a medias. Estas pruebas fijan los valores por defecto (puerto 4008, hora
 * del refresco nocturno y tope del PDF) y que las claves obligatorias se exigen.
 */
describe('configuración del servicio de reportes', () => {
  it('aplica los valores por defecto del servicio', () => {
    const config = loadReportingConfig({ DATABASE_URL: 'postgres://odonto_reporting/x' });

    expect(config.REPORTING_HOST).toBe('127.0.0.1');
    expect(config.REPORTING_PORT).toBe(4008);
    expect(config.DATABASE_POOL_MAX).toBe(10);
    expect(config.REPORTING_REFRESH_HOUR).toBe(3);
    expect(config.PDF_TIMEOUT_MS).toBe(30_000);
    expect(config.PDF_CHROMIUM_PATH).toBeUndefined();
    expect(config.INTERNAL_SERVICE_SECRET).toBeUndefined();
  });

  it('exige la base de datos del read model', () => {
    expect(() => loadReportingConfig({})).toThrow(ConfigError);
  });

  it('deja cambiar el puerto, la hora del refresco y el navegador del PDF', () => {
    const config = loadReportingConfig({
      DATABASE_URL: 'postgres://odonto_reporting/x',
      REPORTING_PORT: '4108',
      REPORTING_REFRESH_HOUR: '5',
      PDF_CHROMIUM_PATH: '/usr/bin/chromium',
      PDF_TIMEOUT_MS: '45000',
      INTERNAL_SERVICE_SECRET: 'secreto-compartido-de-prueba',
    });

    expect(config.REPORTING_PORT).toBe(4108);
    expect(config.REPORTING_REFRESH_HOUR).toBe(5);
    expect(config.PDF_CHROMIUM_PATH).toBe('/usr/bin/chromium');
    expect(config.PDF_TIMEOUT_MS).toBe(45_000);
    expect(config.INTERNAL_SERVICE_SECRET).toBe('secreto-compartido-de-prueba');
  });

  it('una hora de refresco fuera del día no pasa la validación', () => {
    expect(() =>
      loadReportingConfig({
        DATABASE_URL: 'postgres://odonto_reporting/x',
        REPORTING_REFRESH_HOUR: '24',
      }),
    ).toThrow(ConfigError);
  });

  it('el secreto interno tiene que ser largo, como en los demás servicios', () => {
    expect(() =>
      loadReportingConfig({
        DATABASE_URL: 'postgres://odonto_reporting/x',
        INTERNAL_SERVICE_SECRET: 'corto',
      }),
    ).toThrow(ConfigError);
  });
});
