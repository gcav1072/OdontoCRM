import { describe, expect, it } from 'vitest';

import { loadGatewayConfig } from './config.js';
import { buildUpstreamChecks, upstreamsOf } from './upstreams.js';

const conTodo = {
  IDENTITY_URL: 'http://127.0.0.1:4001',
  PATIENTS_URL: 'http://127.0.0.1:4002',
  SCHEDULING_URL: 'http://127.0.0.1:4003',
  NOTIFICATIONS_URL: 'http://127.0.0.1:4004',
  CLINICAL_URL: 'http://127.0.0.1:4005',
  ODONTOGRAM_URL: 'http://127.0.0.1:4006',
  SCREENS_URL: 'http://127.0.0.1:4007',
  REPORTING_URL: 'http://127.0.0.1:4008',
  LOG_LEVEL: 'silent',
};

/**
 * El `/ready` de la puerta tiene que notar que un servicio no está: antes era un
 * 200 fijo y el tablero de estado se creía todo bien con la mitad de la pila caída.
 */
describe('servicios detrás de la puerta', () => {
  it('los lista a partir de la configuración', () => {
    expect(upstreamsOf(loadGatewayConfig(conTodo)).map((upstream) => upstream.name)).toEqual([
      'identity',
      'patients',
      'scheduling',
      'notifications',
      'clinical',
      'odontogram',
      'screens',
      'reporting',
    ]);
  });

  it('deja fuera los servicios sin URL (no desplegados)', () => {
    const soloIdentity = upstreamsOf(
      loadGatewayConfig({
        IDENTITY_URL: 'http://127.0.0.1:4001',
        PATIENTS_URL: '',
        LOG_LEVEL: 'silent',
      }),
    );

    expect(soloIdentity.map((upstream) => upstream.name)).toEqual(['identity']);
  });

  it('un servicio que responde 200 pasa el chequeo', async () => {
    const checks = buildUpstreamChecks(
      loadGatewayConfig(conTodo),
      (async () => ({ ok: true, status: 200 }) as Response) as unknown as typeof fetch,
    );

    expect(checks).toHaveLength(8);
    await expect(checks[0]?.run()).resolves.toBeUndefined();
  });

  it('un servicio caído o que responde 5xx hace fallar el chequeo con su nombre', async () => {
    const checks = buildUpstreamChecks(
      loadGatewayConfig({ ...conTodo, REPORTING_URL: 'http://127.0.0.1:4999' }),
      (async () => ({ ok: false, status: 503 }) as Response) as unknown as typeof fetch,
    );
    const reporting = checks.find((check) => check.name === 'reporting');

    await expect(reporting?.run()).rejects.toThrow(/reporting respondió 503/);
  });

  it('un servicio que no contesta también falla (no se cuelga: hay tope)', async () => {
    const checks = buildUpstreamChecks(
      loadGatewayConfig({ ...conTodo, CLINICAL_URL: 'http://127.0.0.1:4998' }),
      (async () => {
        throw new Error('fetch failed');
      }) as unknown as typeof fetch,
    );
    const clinical = checks.find((check) => check.name === 'clinical');

    await expect(clinical?.run()).rejects.toThrow(/fetch failed/);
    expect(clinical?.timeoutMs).toBeLessThanOrEqual(2_000);
  });
});
