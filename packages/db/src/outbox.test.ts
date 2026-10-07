import { createDomainEvent, EVENT_TOPICS } from '@odontocrm/events';
import { describe, expect, it } from 'vitest';

import {
  consumerQueueName,
  DEAD_LETTER_QUEUE,
  DOMAIN_EVENTS_QUEUE,
  enqueueDomainEvent,
  ensureConsumerQueues,
  EVENT_CONSUMERS,
  type DomainEventQueueClient,
} from './boss.js';
import { backoffSeconds, OUTBOX_MAX_ATTEMPTS } from './outbox.js';

describe('reintentos del outbox', () => {
  it('crece con los intentos y se estanca en el máximo', () => {
    expect(backoffSeconds(1)).toBe(60);
    expect(backoffSeconds(2)).toBe(300);
    expect(backoffSeconds(3)).toBe(900);
    expect(backoffSeconds(4)).toBe(3_600);
    expect(backoffSeconds(5)).toBe(21_600);
    expect(backoffSeconds(50)).toBe(21_600);
  });

  it('tolera intentos en cero o negativos sin devolver valores absurdos', () => {
    expect(backoffSeconds(0)).toBe(60);
    expect(backoffSeconds(-3)).toBe(60);
  });

  it('declara un tope de intentos razonable', () => {
    expect(OUTBOX_MAX_ATTEMPTS).toBeGreaterThanOrEqual(5);
    expect(OUTBOX_MAX_ATTEMPTS).toBeLessThanOrEqual(20);
  });
});

describe('sobre de evento del outbox', () => {
  it('acepta los eventos que produce el catálogo', () => {
    const event = createDomainEvent({
      topic: EVENT_TOPICS.patientCreated,
      aggregateId: globalThis.crypto.randomUUID(),
      producer: 'patients',
    });

    expect(JSON.parse(JSON.stringify(event))).toMatchObject({
      eventType: 'patients.patient.created',
      producer: 'patients',
    });
  });
});

/**
 * Un publicador de prueba: `getQueues` devuelve lo que le digan y `send` puede
 * fallar la primera vez que toca una cola concreta, como hace pg-boss cuando la
 * cola se ha borrado entre la consulta y el `insert` (violación de clave foránea
 * contra `queue`).
 */
const publicadorFalso = (options: {
  fotos: string[][];
  fallaEn?: { cola: string; veces: number };
}) => {
  let indice = 0;
  const enviados: string[] = [];
  const fallos = new Map<string, number>();

  const boss: DomainEventQueueClient = {
    getQueues: async () => {
      const foto = options.fotos[Math.min(indice, options.fotos.length - 1)] ?? [];
      indice += 1;
      return foto.map((name) => ({ name }));
    },
    send: async (name) => {
      const pendientes = fallos.get(name) ?? 0;
      if (options.fallaEn?.cola === name && pendientes < options.fallaEn.veces) {
        fallos.set(name, pendientes + 1);
        throw new Error(
          'inserción o actualización en la tabla «job_common» viola la llave foránea «q_fkey»',
        );
      }
      enviados.push(name);
      return `job-${name}`;
    },
  };

  return { boss, enviados };
};

describe('publicación en las colas de consumidores', () => {
  const evento = () =>
    createDomainEvent({
      topic: EVENT_TOPICS.toothFindingRecorded,
      aggregateId: globalThis.crypto.randomUUID(),
      producer: 'odontogram',
    });

  it('publica una copia por cola de consumidor', async () => {
    const { boss, enviados } = publicadorFalso({
      fotos: [[`${DOMAIN_EVENTS_QUEUE}.identity`, `${DOMAIN_EVENTS_QUEUE}.odontogram`]],
    });

    await enqueueDomainEvent(boss, evento());

    expect(enviados.sort()).toEqual([
      `${DOMAIN_EVENTS_QUEUE}.identity`,
      `${DOMAIN_EVENTS_QUEUE}.odontogram`,
    ]);
  });

  it('si una cola desaparece entre la foto y el envío, reintenta con la lista nueva', async () => {
    // Primera foto: la suite de otro servicio aún no ha borrado su cola. El envío
    // a esa cola falla; la segunda foto ya no la trae y el evento sale igual.
    const { boss, enviados } = publicadorFalso({
      fotos: [
        [`${DOMAIN_EVENTS_QUEUE}.identity`, `${DOMAIN_EVENTS_QUEUE}.prueba`],
        [`${DOMAIN_EVENTS_QUEUE}.identity`],
      ],
      fallaEn: { cola: `${DOMAIN_EVENTS_QUEUE}.prueba`, veces: 1 },
    });

    await enqueueDomainEvent(boss, evento());

    expect(enviados).toContain(`${DOMAIN_EVENTS_QUEUE}.identity`);
    expect(enviados).not.toContain(`${DOMAIN_EVENTS_QUEUE}.prueba`);
  });

  it('si el fallo no es una cola que desapareció, se propaga para que el outbox reintente', async () => {
    const { boss } = publicadorFalso({
      // La cola sigue en la segunda foto: no es una foto caducada, es un fallo real.
      fotos: [[`${DOMAIN_EVENTS_QUEUE}.identity`], [`${DOMAIN_EVENTS_QUEUE}.identity`]],
      fallaEn: { cola: `${DOMAIN_EVENTS_QUEUE}.identity`, veces: 5 },
    });

    await expect(enqueueDomainEvent(boss, evento())).rejects.toThrow(/job_common/);
  });

  it('sin ninguna cola de consumidor usa la padre como último recurso', async () => {
    const { boss, enviados } = publicadorFalso({ fotos: [[]] });

    await enqueueDomainEvent(boss, evento());

    expect(enviados).toEqual([DOMAIN_EVENTS_QUEUE]);
  });

  it('con una cola concreta publica solo ahí (las pruebas no ensucian las de los servicios)', async () => {
    const { boss, enviados } = publicadorFalso({
      fotos: [[`${DOMAIN_EVENTS_QUEUE}.identity`, `${DOMAIN_EVENTS_QUEUE}.odontogram`]],
    });

    await enqueueDomainEvent(boss, evento(), `${DOMAIN_EVENTS_QUEUE}.prueba`);

    expect(enviados).toEqual([`${DOMAIN_EVENTS_QUEUE}.prueba`]);
  });
});

/**
 * La foto de colas se toma **antes** de publicar: si un evento sale mientras otro
 * servicio todavía arranca, ese servicio no lo ve nunca. Medido en la puesta en
 * marcha del 2026-10-04 (10 altas de paciente y 30 hallazgos se quedaron sin
 * proyectar), el publicador ahora declara las colas conocidas antes del primer envío.
 */
describe('colas de los consumidores', () => {
  const jefeFalso = () => {
    const creadas: string[] = [];
    const opciones = new Map<string, Record<string, unknown> | undefined>();
    return {
      creadas,
      opciones,
      boss: {
        createQueue: async (name: string, opcionesDeLaCola?: Record<string, unknown>) => {
          creadas.push(name);
          opciones.set(name, opcionesDeLaCola);
        },
      },
    };
  };

  it('declara todas las colas conocidas antes de publicar', async () => {
    const { boss, creadas, opciones } = jefeFalso();

    await ensureConsumerQueues(boss as never);

    // Cada consumidor **y** la cola de descarte: la de descarte tiene que existir antes de
    // que algo falle, o `pg-boss` no podría copiar allí el trabajo.
    expect(creadas).toHaveLength(EVENT_CONSUMERS.length + 1);
    expect(creadas).toContain(consumerQueueName('reporting'));
    expect(creadas).toContain(consumerQueueName('identity'));
    expect(creadas).toContain(DEAD_LETTER_QUEUE);

    // Las colas de consumidores apuntan a la de descarte…
    expect(opciones.get(consumerQueueName('reporting'))?.deadLetter).toBe(DEAD_LETTER_QUEUE);
    // …y la de descarte no apunta a ninguna (sería una cadena sin fin).
    expect(opciones.get(DEAD_LETTER_QUEUE)?.deadLetter).toBeUndefined();
  });

  it('el gateway no consume eventos: no se le crea cola', () => {
    expect(EVENT_CONSUMERS).not.toContain('gateway');
    expect(EVENT_CONSUMERS).toContain('screens');
  });

  it('la cola de descarte no se confunde con una de consumidores', () => {
    // Si empezara por `domain-events.`, el publicador le mandaría una copia de CADA evento
    // publicado y se llenaría de trabajos que nadie ha fallado.
    expect(DEAD_LETTER_QUEUE.startsWith(`${DOMAIN_EVENTS_QUEUE}.`)).toBe(false);
  });

  it('con una cola concreta (pruebas) solo declara esa y la de descarte', async () => {
    const { boss, creadas } = jefeFalso();

    await ensureConsumerQueues(boss as never, ['domain-events.prueba']);

    // **La de descarte va primero** y el orden importa: `pg-boss` exige que la cola destino
    // exista antes de declarar una que apunte a ella (si no, `createQueue` revienta con
    // «Queue … does not exist»). Esta aserción es la que vigila ese orden.
    expect(creadas).toEqual([DEAD_LETTER_QUEUE, consumerQueueName('prueba')]);
  });
});
