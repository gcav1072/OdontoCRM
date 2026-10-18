import { describe, expect, it } from 'vitest';

import { stableUuid } from './stable-uuid.js';

/**
 * El identificador estable es lo que permite publicar eventos y auditoría de agregados
 * sin id propio (el cupo de un día, la configuración fiscal). Lo que importa: que sea
 * un UUID válido para el contrato, determinista y distinto por clave.
 */
describe('stableUuid', () => {
  it('devuelve un UUID con versión 5 y variante RFC 4122', () => {
    const id = stableUuid('day_capacity:2026-10-18:consultorio-1');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('es determinista: la misma clave da siempre el mismo id', () => {
    expect(stableUuid('billing_settings:1')).toBe(stableUuid('billing_settings:1'));
  });

  it('claves distintas dan ids distintos', () => {
    expect(stableUuid('billing_settings:1')).not.toBe(stableUuid('billing_settings:2'));
    expect(stableUuid('day_capacity:2026-10-18:uno')).not.toBe(
      stableUuid('day_capacity:2026-10-18:dos'),
    );
  });
});
