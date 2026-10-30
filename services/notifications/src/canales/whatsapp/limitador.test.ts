import { describe, expect, it, vi } from 'vitest';

import type { WhatsAppSessionStore } from './estado-store.js';
import { CanalNoDisponibleError, CanalSaturadoError, createLimitador } from './limitador.js';

const store = (reservas: boolean[] = []): WhatsAppSessionStore => ({
  load: async () => null,
  save: async () => undefined,
  reservarEnvio: async () => reservas.shift() ?? true,
});

describe('limitador de Baileys', () => {
  it('serializa los envíos y espera un intervalo aleatorio entre ellos', async () => {
    let ahora = new Date('2026-10-29T10:00:00-04:00');
    const sleeps: number[] = [];
    const ejecutados: number[] = [];
    const limitador = createLimitador({
      minIntervalMs: 2000,
      maxIntervalMs: 4000,
      dailyCap: 150,
      typing: false,
      store: store(),
      conectado: () => true,
      now: () => ahora,
      random: () => 0,
      sleep: async (ms) => {
        sleeps.push(ms);
        ahora = new Date(ahora.getTime() + ms);
      },
    });

    await limitador.programar('uno', async () => {
      ejecutados.push(1);
      return 1;
    });
    await limitador.programar('dos', async () => {
      ejecutados.push(2);
      return 2;
    });

    expect(ejecutados).toEqual([1, 2]);
    expect(sleeps).toEqual([2000]);
  });

  it('si el tope diario está agotado, difiere con la próxima medianoche', async () => {
    const limitador = createLimitador({
      minIntervalMs: 2000,
      maxIntervalMs: 4000,
      dailyCap: 2,
      typing: false,
      store: store([false]),
      conectado: () => true,
      now: () => new Date('2026-10-29T23:00:00-04:00'),
    });

    await expect(limitador.programar('hola', async () => 'ok')).rejects.toMatchObject({
      name: 'CanalSaturadoError',
      reintentarEn: new Date('2026-10-30T00:00:00-04:00'),
    });
  });

  it('sin conexión no gasta cupo y devuelve cuándo reintentar', async () => {
    const reservar = vi.fn(async () => true);
    const limitador = createLimitador({
      minIntervalMs: 2000,
      maxIntervalMs: 4000,
      dailyCap: 150,
      typing: false,
      store: { ...store(), reservarEnvio: reservar },
      conectado: () => false,
      now: () => new Date('2026-10-29T10:00:00-04:00'),
    });

    await expect(limitador.programar('hola', async () => 'ok')).rejects.toBeInstanceOf(
      CanalNoDisponibleError,
    );
    expect(reservar).not.toHaveBeenCalled();
  });

  it('el «escribiendo…» se apaga al terminar y un fallo de presencia no tumba el envío', async () => {
    const presencia = vi.fn(async () => {
      throw new Error('la presencia no está disponible');
    });
    const limitador = createLimitador({
      minIntervalMs: 2000,
      maxIntervalMs: 4000,
      dailyCap: 150,
      typing: true,
      store: store(),
      conectado: () => true,
      presencia,
      sleep: async () => undefined,
    });

    await expect(limitador.programar('hola', async () => 'enviado')).resolves.toBe('enviado');
    expect(presencia).toHaveBeenCalledWith('composing');
    expect(presencia).toHaveBeenCalledWith('paused');
  });

  it('el error de un envío no bloquea la cola', async () => {
    const limitador = createLimitador({
      minIntervalMs: 2000,
      maxIntervalMs: 4000,
      dailyCap: 150,
      typing: false,
      store: store(),
      conectado: () => true,
      sleep: async () => undefined,
    });

    await expect(
      limitador.programar('falla', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await expect(limitador.programar('sigue', async () => 'ok')).resolves.toBe('ok');
  });

  it('el error de tope es reconocible por la cola de envíos', () => {
    expect(new CanalSaturadoError('tope', new Date()).name).toBe('CanalSaturadoError');
  });
});
