import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import { baseEnvSchema, ConfigError, isProduction, loadConfig } from './config.js';

const serviceSchema = baseEnvSchema.extend({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().min(1).max(65_535),
});

describe('loadConfig', () => {
  it('aplica los valores por defecto del proyecto', () => {
    const config = loadConfig({
      service: 'prueba',
      schema: serviceSchema,
      env: { DATABASE_URL: 'postgres://ejemplo', PORT: '4001' },
    });

    expect(config.NODE_ENV).toBe('development');
    expect(config.TZ).toBe('America/Caracas');
    expect(config.PORT).toBe(4001);
    expect(config.LOG_PRETTY).toBe(false);
  });

  it('lanza un error claro cuando falta una variable obligatoria', () => {
    expect(() =>
      loadConfig({ service: 'prueba', schema: serviceSchema, env: { PORT: '4001' } }),
    ).toThrowError(ConfigError);

    try {
      loadConfig({ service: 'prueba', schema: serviceSchema, env: { PORT: '4001' } });
      expect.unreachable('debía lanzar ConfigError');
    } catch (error) {
      const configError = error as ConfigError;
      expect(configError.message).toContain('DATABASE_URL');
      expect(configError.missing).toContain('DATABASE_URL');
    }
  });

  it('nunca repite el valor recibido en el mensaje de error (evita filtrar secretos)', () => {
    const valorQuePareceUnSecreto = '123456789:AA-secreto-que-no-debe-aparecer';

    try {
      loadConfig({
        service: 'prueba',
        schema: serviceSchema,
        env: {
          DATABASE_URL: 'postgres://ejemplo',
          PORT: '4001',
          LOG_LEVEL: valorQuePareceUnSecreto,
        },
      });
      expect.unreachable('debía lanzar ConfigError');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain(valorQuePareceUnSecreto);
      expect(message).toContain('LOG_LEVEL');
      expect(message).toContain('valor no permitido');
    }
  });

  it('rechaza puertos fuera de rango', () => {
    expect(() =>
      loadConfig({
        service: 'prueba',
        schema: serviceSchema,
        env: { DATABASE_URL: 'postgres://ejemplo', PORT: '70000' },
      }),
    ).toThrowError(ConfigError);
  });

  it('detecta el entorno de producción', () => {
    const config = loadConfig({
      service: 'prueba',
      schema: serviceSchema,
      env: { DATABASE_URL: 'postgres://ejemplo', PORT: '4001', NODE_ENV: 'production' },
    });

    expect(isProduction(config)).toBe(true);
  });
});
