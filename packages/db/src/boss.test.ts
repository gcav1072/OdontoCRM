import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { consumerQueueName, EVENT_CONSUMERS } from './boss.js';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..');

/**
 * La lista de consumidores tiene que ser exacta: si falta un servicio, sus eventos
 * se pierden cuando la pila arranca desordenada (el fallo medido el 2026-10-04); si
 * sobra uno, se le crea una cola que nadie trabaja y se llena de trabajos muertos.
 *
 * Se comprueba contra el código: quién llama a `registerDomainEventHandler`.
 */
describe('consumidores de eventos', () => {
  const consumidoresDelCodigo = (): string[] => {
    const servicios = readdirSync(resolve(ROOT, 'services'), { withFileTypes: true })
      .filter((entrada) => entrada.isDirectory())
      .map((entrada) => entrada.name);

    return servicios
      .filter((servicio) => {
        const index = resolve(ROOT, 'services', servicio, 'src', 'index.ts');
        try {
          return readFileSync(index, 'utf8').includes('registerDomainEventHandler');
        } catch {
          return false;
        }
      })
      .sort();
  };

  it('son los cinco servicios que registran un manejador, ni uno más', () => {
    expect([...EVENT_CONSUMERS].sort()).toEqual(consumidoresDelCodigo());
  });

  it('el gateway no consume: no se le crea cola', () => {
    expect(EVENT_CONSUMERS).not.toContain('gateway');
  });

  it('cada consumidor tiene su cola con el prefijo del catálogo', () => {
    for (const servicio of EVENT_CONSUMERS) {
      expect(consumerQueueName(servicio)).toBe(`domain-events.${servicio}`);
    }
  });
});
