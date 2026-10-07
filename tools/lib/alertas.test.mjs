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

  /**
   * Los **eventos perdidos** (cola de descarte): un evento que agotó sus reintentos es lo
   * más grave del tablero, porque significa que algo que el sistema prometió hacer no se
   * hizo. El registro es histórico, así que lo que dispara la alerta es la **ventana** (las
   * últimas 24 h), no el total: si no, alertaría para siempre por algo ya arreglado.
   */
  describe('eventos perdidos', () => {
    it('uno reciente es un problema, con su antigüedad y dónde mirar', () => {
      const conPerdido = foto({
        servicios: [servicio()],
        cartasMuertas: {
          total: 12,
          ultimas24h: 1,
          masReciente: haceMinutos(3),
          pendientesDeRecoger: 0,
        },
      });

      const problemas = alertasDe(conPerdido, AHORA);
      expect(problemas).toHaveLength(1);
      expect(problemas[0]).toContain('eventos perdidos');
      expect(problemas[0]).toContain('hace 3 min');
      expect(problemas[0]).toContain('dead_letter_events');
    });

    it('los de hace días no alertan (el total histórico no dice nada)', () => {
      const viejo = foto({
        servicios: [servicio()],
        cartasMuertas: {
          total: 40,
          ultimas24h: 0,
          masReciente: haceMinutos(60 * 48),
          pendientesDeRecoger: 0,
        },
      });

      expect(alertasDe(viejo, AHORA)).toEqual([]);
    });

    it('sin tabla todavía (nunca se ha perdido nada) no es un problema', () => {
      const sinTabla = foto({
        servicios: [servicio()],
        cartasMuertas: { total: 0, ausente: true },
      });
      expect(alertasDe(sinTabla, AHORA)).toEqual([]);
    });

    it('trabajos copiados al buzón sin recoger avisan de que nadie los está apuntando', () => {
      const sinVigilante = foto({
        servicios: [servicio()],
        cartasMuertas: { total: 0, ultimas24h: 0, masReciente: null, pendientesDeRecoger: 4 },
      });

      const problemas = alertasDe(sinVigilante, AHORA);
      expect(problemas).toHaveLength(1);
      expect(problemas[0]).toContain('4 trabajo(s) sin recoger');
    });

    it('si no se pudo leer el registro, se dice en vez de callarse', () => {
      const sinLeer = foto({ servicios: [servicio()], cartasMuertas: { error: 'sin permisos' } });
      expect(alertasDe(sinLeer, AHORA)[0]).toContain('sin permisos');
    });
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

  /**
   * El fallo que motivó esta regla: en el banco de pruebas, una pila de desarrollo
   * ocupaba los puertos, los servicios de systemd quedaron en `failed` por
   * EADDRINUSE y `/health` respondía 200 —lo contestaba la otra pila—, así que el
   * tablero daba todo por bueno.
   */
  it('avisa cuando el puerto lo sirve un proceso que no es la unidad de systemd', () => {
    const conOtraPila = foto({
      systemd: {
        disponible: true,
        unidades: [
          {
            name: 'identity',
            unidad: 'odontocrm@identity',
            activa: 'failed',
            existe: true,
            pidUnidad: null,
            pidPuerto: '57833',
            sirveLaUnidad: false,
          },
        ],
      },
    });

    const problemas = alertasDe(conOtraPila, AHORA);

    expect(problemas).toHaveLength(1);
    expect(problemas[0]).toContain('lo sirve el PID 57833');
    expect(problemas[0]).toContain('odontocrm@identity');
    expect(problemas[0]).toContain('otra pila');
  });

  it('avisa si la unidad está activa pero el puerto lo sirve otro proceso', () => {
    const problemas = alertasDe(
      foto({
        systemd: {
          disponible: true,
          unidades: [
            {
              name: 'clinical',
              unidad: 'odontocrm@clinical',
              activa: 'active',
              existe: true,
              pidUnidad: '111',
              pidPuerto: '222',
              sirveLaUnidad: false,
            },
          ],
        },
      }),
      AHORA,
    );

    expect(problemas).toHaveLength(1);
    expect(problemas[0]).toContain('no odontocrm@clinical');
  });

  it('una unidad en failed sin puerto también es alerta (con el comando para mirar)', () => {
    const problemas = alertasDe(
      foto({
        systemd: {
          disponible: true,
          unidades: [
            {
              name: 'screens',
              unidad: 'odontocrm@screens',
              activa: 'failed',
              existe: true,
              pidUnidad: null,
              pidPuerto: null,
              sirveLaUnidad: false,
            },
          ],
        },
      }),
      AHORA,
    );

    expect(problemas).toHaveLength(1);
    expect(problemas[0]).toContain('journalctl -u odontocrm@screens');
  });

  it('en Windows (PM2) el comando para mirar es `pm2 logs`, no `journalctl`', () => {
    const problemas = alertasDe(
      foto({
        systemd: {
          disponible: true,
          gestor: 'pm2',
          unidades: [
            {
              name: 'clinical',
              unidad: 'odontocrm-clinical',
              activa: 'failed',
              existe: true,
              pidUnidad: null,
              pidPuerto: null,
              sirveLaUnidad: false,
            },
          ],
        },
      }),
      AHORA,
    );

    expect(problemas).toHaveLength(1);
    expect(problemas[0]).toContain('pm2 logs odontocrm-clinical');
  });

  it('con la unidad sirviendo su puerto no hay nada que reportar', () => {
    const problemas = alertasDe(
      foto({
        systemd: {
          disponible: true,
          unidades: [
            {
              name: 'identity',
              unidad: 'odontocrm@identity',
              activa: 'active',
              existe: true,
              pidUnidad: '111',
              pidPuerto: '111',
              sirveLaUnidad: true,
            },
          ],
        },
      }),
      AHORA,
    );

    expect(problemas).toEqual([]);
  });

  it('sin systemd (desarrollo) no se dice nada de unidades', () => {
    expect(alertasDe(foto({ systemd: { disponible: false, unidades: [] } }), AHORA)).toEqual([]);
  });

  /**
   * Tras el reinicio de la Fase 10, el tablero ejecutado sin `sudo` no podía leer
   * `/etc/odontocrm` (0600 root:root) y reportaba nueve alertas falsas: «sin
   * DATABASE_URL», «falta EVENTS_DATABASE_URL». No poder comprobar algo no es un
   * problema, y una alarma falsa cada mañana enseña a ignorar las de verdad.
   */
  it('sin permisos para leer los entornos no inventa problemas', () => {
    const sinPermisos = foto({
      permisos: { envLegible: false, raiz: '/etc/odontocrm', esRoot: false },
      cola: { error: 'no comprobable sin sudo (no puedo leer los entornos)' },
      outbox: [
        { name: 'identity', error: 'sin DATABASE_URL' },
        { name: 'patients', error: 'sin DATABASE_URL' },
      ],
      envios: { error: 'no comprobable sin sudo (no puedo leer los entornos)' },
      reportes: { error: 'no comprobable sin sudo (no puedo leer los entornos)' },
    });

    expect(alertasDe(sinPermisos, AHORA)).toEqual([]);
  });

  it('con permisos, los mismos datos sí son problemas', () => {
    const conPermisos = foto({
      permisos: { envLegible: true, raiz: '/etc/odontocrm', esRoot: true },
      cola: { error: 'falta EVENTS_DATABASE_URL' },
      outbox: [{ name: 'identity', error: 'sin DATABASE_URL' }],
    });

    const problemas = alertasDe(conPermisos, AHORA);
    expect(problemas.length).toBeGreaterThan(0);
    expect(problemas.join(' ')).toContain('EVENTS_DATABASE_URL');
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
