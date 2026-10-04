import { describe, expect, it } from 'vitest';

import { loadGatewayConfig } from './config.js';
import { buildSystemMeta } from './meta.js';

const baseEnv = { IDENTITY_URL: 'http://127.0.0.1:4001', LOG_LEVEL: 'silent' };

describe('buildSystemMeta', () => {
  it('publica versión, entorno y el modo test apagado por defecto', () => {
    const meta = buildSystemMeta(
      loadGatewayConfig({ ...baseEnv, SERVICE_VERSION: '0.1.0' }),
      new Date('2026-10-04T12:00:00.000Z'),
    );

    expect(meta.service).toBe('gateway');
    expect(meta.version).toBe('0.1.0');
    expect(meta.environment).toBe('development');
    expect(meta.timestamp).toBe('2026-10-04T12:00:00.000Z');
    expect(meta.testMode.enabled).toBe(false);
    expect(meta.testMode.state).toBe('disabled');
    expect(meta.fixtures.seed).toBe('odontocrm-2026');
    expect(meta.fixtures.documentMin).toBe(90_000_000);
  });

  it('publica el modo test activo en desarrollo con las dos banderas', () => {
    const meta = buildSystemMeta(
      loadGatewayConfig({ ...baseEnv, TEST_MODE: 'true', ALLOW_TEST_MODE: 'true' }),
    );

    expect(meta.testMode.enabled).toBe(true);
    expect(meta.testMode.message).toContain('banner');
  });

  it('jamás publica el modo test activo en producción', () => {
    const meta = buildSystemMeta(
      loadGatewayConfig({
        ...baseEnv,
        NODE_ENV: 'production',
        TEST_MODE: 'true',
        ALLOW_TEST_MODE: 'true',
      }),
    );

    expect(meta.testMode.enabled).toBe(false);
    expect(meta.testMode.state).toBe('blocked_in_production');
  });

  it('no filtra secretos ni cadenas de conexión', () => {
    const meta = buildSystemMeta(
      loadGatewayConfig({
        ...baseEnv,
        JWT_PUBLIC_KEY_PATH: '/tmp/llave.pem',
        TEST_MODE: 'true',
        ALLOW_TEST_MODE: 'true',
      }),
    );

    expect(JSON.stringify(meta)).not.toContain('llave.pem');
  });
});
