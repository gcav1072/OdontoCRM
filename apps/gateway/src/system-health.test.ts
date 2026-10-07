import { describe, expect, it, vi } from 'vitest';

import { loadGatewayConfig } from './config.js';
import { collectSystemHealth } from './system-health.js';

/**
 * El panel del administrador vive de esta agregación: la puerta pregunta a los nueve
 * servicios y junta lo que contestan. Lo que hay que fijar es que **un servicio caído no
 * tumbe el informe** (se quiere saber cuál falla) y que las cifras del encabezado cuadren
 * con lo que se vio.
 */

const conTodo = {
  IDENTITY_URL: 'http://127.0.0.1:4001',
  PATIENTS_URL: 'http://127.0.0.1:4002',
  LOG_LEVEL: 'silent',
};

const gateway = {
  service: 'gateway',
  version: '0.1.0',
  uptimeSeconds: 42,
  timestamp: '2026-10-07T12:00:00.000Z',
};

/** Respuesta de un `/ready` sano, con el `details` del pool y del outbox. */
const informeSano = {
  service: 'identity',
  version: '0.1.0',
  status: 'ok',
  uptimeSeconds: 100,
  timestamp: '2026-10-07T12:00:00.000Z',
  checks: [
    { name: 'database', status: 'ok', latencyMs: 2, details: { total: 3, idle: 2, waiting: 0 } },
    { name: 'outbox', status: 'ok', latencyMs: 1, details: { pendientes: 0 } },
  ],
};

const respuestaJson = (cuerpo: unknown, status = 200): Response =>
  new Response(JSON.stringify(cuerpo), {
    status,
    headers: { 'content-type': 'application/json' },
  });

describe('el estado consolidado del sistema', () => {
  it('junta el informe de cada servicio con su latencia', async () => {
    const fetchImpl = vi.fn(async () => respuestaJson(informeSano));

    const informe = await collectSystemHealth(loadGatewayConfig(conTodo), { fetchImpl, gateway });

    expect(informe.services.map((servicio) => servicio.name)).toEqual(['identity', 'patients']);
    expect(informe.services[0]).toMatchObject({
      reachable: true,
      status: 'ok',
      version: '0.1.0',
      uptimeSeconds: 100,
    });
    // Los detalles del pool y del outbox viajan tal cual: son las cifras del panel.
    expect(informe.services[0]?.checks[0]?.details).toEqual({ total: 3, idle: 2, waiting: 0 });
    expect(informe.totals).toMatchObject({ ok: 2, error: 0, unreachable: 0, conOutboxAtrasado: 0 });
  });

  it('un servicio caído no rompe el informe: se marca como inalcanzable y con su motivo', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const destino = String(url);
      if (destino.includes('4002')) throw new Error('connect ECONNREFUSED 127.0.0.1:4002');
      return respuestaJson(informeSano);
    });

    const informe = await collectSystemHealth(loadGatewayConfig(conTodo), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      gateway,
    });

    const patients = informe.services.find((servicio) => servicio.name === 'patients');
    expect(patients).toMatchObject({ reachable: false, status: 'error' });
    expect(patients?.error).toContain('ECONNREFUSED');
    expect(informe.totals).toMatchObject({ ok: 1, unreachable: 1 });
    // Con un servicio abajo y otro arriba, la puerta funciona a medias.
    expect(informe.gateway.status).toBe('degraded');
  });

  it('un servicio que contesta 503 con su informe se enseña con el chequeo que falla', async () => {
    const fetchImpl = vi.fn(async () =>
      respuestaJson(
        {
          ...informeSano,
          status: 'error',
          checks: [{ name: 'database', status: 'error', latencyMs: 30, message: 'sin conexión' }],
        },
        503,
      ),
    );

    const informe = await collectSystemHealth(loadGatewayConfig(conTodo), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      gateway,
    });

    expect(informe.services[0]?.reachable).toBe(true);
    expect(informe.services[0]?.status).toBe('error');
    expect(informe.totals.error).toBe(2);
    expect(informe.gateway.status).toBe('error');
  });

  it('cuenta los servicios con el outbox atrasado, no solo los caídos', async () => {
    const fetchImpl = vi.fn(async () =>
      respuestaJson({
        ...informeSano,
        checks: [
          { name: 'database', status: 'ok', latencyMs: 2 },
          { name: 'outbox', status: 'ok', latencyMs: 1, details: { pendientes: 12 } },
        ],
      }),
    );

    const informe = await collectSystemHealth(loadGatewayConfig(conTodo), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      gateway,
    });

    expect(informe.totals.conOutboxAtrasado).toBe(2);
    // El servicio responde: el outbox atrasado no lo convierte en «error».
    expect(informe.gateway.status).toBe('ok');
  });

  it('una respuesta que no es un informe se trata como error, sin lanzar', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('<html>puerto de otro</html>', { status: 200 }),
    );

    const informe = await collectSystemHealth(loadGatewayConfig(conTodo), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      gateway,
    });

    expect(informe.services[0]?.reachable).toBe(true);
    expect(informe.services[0]?.error).toContain('respuesta inesperada');
  });

  it('con los servicios opcionales sin desplegar solo queda la identidad', async () => {
    // `IDENTITY_URL` es obligatoria (no hay sistema sin autenticación); el resto son
    // opcionales y una URL vacía significa «ese servicio todavía no existe».
    const informe = await collectSystemHealth(
      loadGatewayConfig({
        IDENTITY_URL: 'http://127.0.0.1:4001',
        PATIENTS_URL: '',
        BILLING_URL: '',
        LOG_LEVEL: 'silent',
      }),
      { fetchImpl: vi.fn() as unknown as typeof fetch, gateway },
    );

    expect(informe.services.map((servicio) => servicio.name)).toEqual(['identity']);
    // El `fetch` de mentira devuelve `undefined`, así que la identidad queda inalcanzable:
    // sin un solo servicio sano, la puerta no sirve para nada.
    expect(informe.totals.unreachable).toBe(1);
    expect(informe.gateway.status).toBe('error');
  });
});
