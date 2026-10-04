import { describe, expect, it } from 'vitest';

import { alertasDe, bytes, hace, LIMITES } from './alertas.mjs';

/**
 * Las reglas de las alertas son la parte del tablero que tiene que seguir siendo
 * correcta aunque cambie la presentación: si se rompen, el sistema se cae en
 * silencio y nadie se entera. Se prueban con fotos fabricadas, sin pila ni base.
 */
const AHORA = new Date('2026-10-04T18:00:00.000Z');
const haceMinutos = (minutos) => new Date(AHORA.getTime() - minutos * 60_000).toISOString();

const foto = (parcial = {}) => ({
  generadoEn: AHORA.toISOString(),
  modoTest: { enabled: false, state: 'disabled', message: '' },
  servicios: [],
  bases: { version: 'PostgreSQL 18.6', host: '127.0.0.1:5432', bases: [], conexiones: 0 },
  cola: { colas: [] },
  outbox: [],
  envios: { enCola: 0, fallidos: 0, sinCanal: 0, proximoIntento: null },
  reportes: { eventosProyectados: 0, ultimoEvento: null, ultimoRefresco: null },
  disco: { libre: 50 * 1024 ** 3, total: 100 * 1024 ** 3, porcentaje: 50 },
  ...parcial,
});

const servicio = (extra = {}) => ({
  name: 'scheduling',
  port: 4003,
  health: { ok: true, status: 200, ms: 5 },
  ready: { ok: true, status: 200, ms: 8 },
  arriba: true,
  listo: true,
  checks: [],
  fallos: [],
  ...extra,
});

describe('alertas del sistema', () => {
  it('con todo en orden no hay nada que reportar', () => {
    expect(alertasDe(foto({ servicios: [servicio()] }), AHORA)).toEqual([]);
  });

  it('el modo test por sí solo no es una alerta (se enseña aparte)', () => {
    const conModoTest = foto({
      modoTest: { enabled: true, state: 'enabled', message: '' },
      servicios: [servicio()],
    });

    expect(alertasDe(conModoTest, AHORA)).toEqual([]);
  });

  it('un servicio que no responde se denuncia con su puerto y su error', () => {
    const caido = servicio({
      arriba: false,
      listo: false,
      health: { ok: false, status: 0, ms: 2000, error: 'fetch failed' },
    });

    const problemas = alertasDe(foto({ servicios: [caido] }), AHORA);

    expect(problemas).toHaveLength(1);
    expect(problemas[0]).toContain('scheduling');
    expect(problemas[0]).toContain('4003');
    expect(problemas[0]).toContain('fetch failed');
  });

  it('un servicio que responde pero no está listo nombra el chequeo que falla', () => {
    const aMedias = servicio({
      listo: false,
      ready: { ok: false, status: 503, ms: 12 },
      fallos: [{ name: 'database', status: 'error', message: 'Dependencia no disponible' }],
    });

    const problemas = alertasDe(foto({ servicios: [aMedias] }), AHORA);

    expect(problemas).toHaveLength(1);
    expect(problemas[0]).toContain('/ready HTTP 503');
    expect(problemas[0]).toContain('database');
  });

  it('un outbox parado avisa pasado el umbral, y no antes', () => {
    const reciente = foto({
      outbox: [
        {
          name: 'clinical',
          pendientes: 3,
          reintentando: 0,
          masAntiguo: haceMinutos(1),
          ultimoError: null,
        },
      ],
    });
    expect(alertasDe(reciente, AHORA)).toEqual([]);

    const atascado = foto({
      outbox: [
        {
          name: 'clinical',
          pendientes: 3,
          reintentando: 1,
          masAntiguo: haceMinutos(LIMITES.outboxMinutos + 5),
          ultimoError: 'Ninguna cola aceptó el evento',
        },
      ],
    });
    const problemas = alertasDe(atascado, AHORA);

    expect(problemas).toHaveLength(1);
    expect(problemas[0]).toContain('clinical');
    expect(problemas[0]).toContain('sin publicar');
    expect(problemas[0]).toContain('Ninguna cola aceptó el evento');
  });

  it('los trabajos fallidos de la cola son alerta aunque no haya pendientes', () => {
    const conFallidos = foto({
      cola: {
        colas: [
          {
            name: 'domain-events.reporting',
            pendientes: 0,
            fallidos: 2,
            completados: 100,
            masAntiguo: null,
          },
        ],
      },
    });

    const problemas = alertasDe(conFallidos, AHORA);

    expect(problemas).toHaveLength(1);
    expect(problemas[0]).toContain('2 trabajo(s) fallido(s)');
  });

  it('la cola de envíos atascada se mide por el próximo intento vencido', () => {
    const atascada = foto({
      envios: {
        enCola: 4,
        fallidos: 0,
        sinCanal: 0,
        proximoIntento: haceMinutos(LIMITES.envioMinutos + 20),
      },
    });

    const problemas = alertasDe(atascada, AHORA);

    expect(problemas).toHaveLength(1);
    expect(problemas[0]).toContain('cola de envíos atascada');
    expect(problemas[0]).toContain('4 mensaje(s)');
  });

  it('un refresco fallido del read model y el disco bajo también son alertas', () => {
    const problemas = alertasDe(
      foto({
        reportes: {
          eventosProyectados: 10,
          ultimoEvento: haceMinutos(3),
          ultimoRefresco: {
            startedAt: haceMinutos(4),
            ok: false,
            error: 'timeout',
            trigger: 'evento',
          },
        },
        disco: { libre: 2 * 1024 ** 3, total: 100 * 1024 ** 3, porcentaje: 2 },
      }),
      AHORA,
    );

    expect(problemas).toHaveLength(2);
    expect(problemas.join(' ')).toContain('refresco del read model');
    expect(problemas.join(' ')).toContain('disco');
  });

  it('una base inalcanzable se reporta una vez, no por cada servicio', () => {
    const problemas = alertasDe(
      foto({
        bases: { error: 'password authentication failed' },
        outbox: [{ name: 'clinical', error: 'password authentication failed' }],
      }),
      AHORA,
    );

    expect(problemas).toHaveLength(2);
    expect(problemas[0]).toContain('base de datos');
    expect(problemas[1]).toContain('outbox de clinical');
  });
});

describe('formato del tablero', () => {
  it('describe el tiempo en unidades legibles', () => {
    expect(hace(haceMinutos(0.5), AHORA)).toBe('hace 30 s');
    expect(hace(haceMinutos(12), AHORA)).toBe('hace 12 min');
    expect(hace(haceMinutos(180), AHORA)).toBe('hace 3 h');
    expect(hace(haceMinutos(60 * 24 * 3), AHORA)).toBe('hace 3 d');
  });

  it('describe los tamaños en unidades legibles', () => {
    expect(bytes(512)).toBe('512 B');
    expect(bytes(1024)).toBe('1.0 KB');
    expect(bytes(15 * 1024 ** 2)).toBe('15 MB');
  });
});
