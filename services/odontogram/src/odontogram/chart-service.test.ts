import { ConflictError } from '@odontocrm/kernel';
import { describe, expect, it } from 'vitest';

import type { ToothFindingHistoryRow, ToothFindingRow } from '../db/schema.js';
import {
  DEFAULT_HISTORY_LIMIT,
  MAX_HISTORY_LIMIT,
  assertNoScopeConflict,
  changedFieldsFor,
  describeFinding,
  describeTransition,
  groupFindings,
  toFindingRecord,
  toHistoryEntry,
} from './chart-service.js';

/**
 * Reglas **puras** del servicio del odontograma: el patrón por excepción
 * (la pieza sana no aparece), las etiquetas legibles de la auditoría y el choque
 * cara/pieza completa dentro de un lote. Nada de esto necesita base de datos, y
 * es justo lo que no debe depender de la interfaz.
 */

const fila = (overrides: Partial<ToothFindingRow> = {}): ToothFindingRow => ({
  id: 'fila-1',
  odontogramId: 'odontograma-1',
  patientId: 'paciente-1',
  toothNumber: 16,
  surface: 'occlusal',
  condition: 'caries',
  state: 'pendiente',
  notes: null,
  recordedBy: null,
  recordedByUsername: 'odontologo',
  recordedInSessionId: null,
  recordedAt: new Date('2026-10-05T13:00:00.000Z'),
  updatedAt: new Date('2026-10-05T13:00:00.000Z'),
  resolvedAt: null,
  ...overrides,
});

describe('patrón por excepción: la pieza sana es la ausencia de fila', () => {
  it('agrupa por pieza y no inventa entradas para las piezas sanas', () => {
    const { findings, affectedTeeth } = groupFindings([
      fila({ id: 'a', toothNumber: 16, surface: 'occlusal', condition: 'caries' }),
      fila({ id: 'b', toothNumber: 16, surface: 'vestibular', condition: 'restauracion' }),
      fila({ id: 'c', toothNumber: 26, surface: 'occlusal', condition: 'caries' }),
      fila({ id: 'd', toothNumber: 36, surface: null, condition: 'ausente' }),
    ]);

    expect(Object.keys(findings).sort()).toEqual(['16', '26', '36']);
    expect(findings['16']).toHaveLength(2);
    expect(findings['11']).toBeUndefined();
    expect(affectedTeeth).toEqual([16, 26, 36]);
  });

  it('una boca sin hallazgos se lee vacía (no hay filas, no hay enfermedad)', () => {
    const { findings, affectedTeeth } = groupFindings([]);
    expect(findings).toEqual({});
    expect(affectedTeeth).toEqual([]);
  });

  it('mapea la fila al DTO con la sesión y la fecha de resolución', () => {
    const record = toFindingRecord(
      fila({
        recordedInSessionId: 'sesion-9',
        resolvedAt: new Date('2026-10-06T09:30:00.000Z'),
        notes: 'caries en oclusal',
      }),
    );

    expect(record).toMatchObject({
      id: 'fila-1',
      toothNumber: 16,
      surface: 'occlusal',
      condition: 'caries',
      state: 'pendiente',
      notes: 'caries en oclusal',
      sessionId: 'sesion-9',
      recordedAt: '2026-10-05T13:00:00.000Z',
      resolvedAt: '2026-10-06T09:30:00.000Z',
    });
  });
});

describe('etiquetas legibles de la auditoría', () => {
  it('describe una cara y una pieza completa en español', () => {
    expect(
      describeFinding({
        toothNumber: 16,
        surface: 'occlusal',
        condition: 'caries',
        state: 'pendiente',
      }),
    ).toBe('Pieza 16 · oclusal · caries (pendiente)');

    expect(
      describeFinding({
        toothNumber: 36,
        surface: null,
        condition: 'ausente',
        state: 'completado',
      }),
    ).toBe('Pieza 36 · ausente (completado)');
  });

  it('los campos cambiados nombran la pieza y la cara (o la condición completa)', () => {
    expect(
      changedFieldsFor({
        toothNumber: 16,
        surface: 'occlusal',
        condition: 'caries',
        state: 'pendiente',
      }),
    ).toEqual(['pieza 16', 'oclusal']);

    expect(
      changedFieldsFor({
        toothNumber: 36,
        surface: null,
        condition: 'extraccion_indicada',
        state: 'pendiente',
      }),
    ).toEqual(['pieza 36', 'extracción indicada']);
  });

  it('la transición distingue el cambio de estado de la nota corregida', () => {
    const antes = {
      toothNumber: 16,
      surface: 'occlusal',
      condition: 'caries',
      state: 'pendiente',
    } as const;

    expect(describeTransition(antes, { ...antes, state: 'completado' })).toBe(
      'Pieza 16 · oclusal · caries (pendiente) → completado',
    );
    expect(describeTransition(antes, { ...antes, state: 'pendiente' })).toBe(
      'Pieza 16 · oclusal · caries (pendiente) · notas actualizadas',
    );
  });
});

describe('lote de carga rápida: las condiciones que no conviven se rechazan enteras', () => {
  const cara = {
    toothNumber: 16,
    surface: 'occlusal',
    condition: 'caries',
    state: 'pendiente',
    notes: null,
    sessionId: null,
  } as const;
  const ausente = {
    toothNumber: 16,
    surface: null,
    condition: 'ausente',
    state: 'pendiente',
    notes: null,
    sessionId: null,
  } as const;

  it('rechaza el lote que trae `ausente` con cualquier otra cosa de la misma pieza', () => {
    expect(() => assertNoScopeConflict([cara, ausente])).toThrow(ConflictError);
    expect(() => assertNoScopeConflict([ausente, cara])).toThrow(/pieza 16/);
    expect(() =>
      assertNoScopeConflict([ausente, { ...ausente, surface: null, condition: 'corona' }]),
    ).toThrow(/no conviven/);
  });

  it('rechaza la pareja imposible: un implante no tiene raíz que endodonciar', () => {
    expect(() =>
      assertNoScopeConflict([
        { ...ausente, toothNumber: 36, surface: null, condition: 'implante' },
        { ...ausente, toothNumber: 36, surface: null, condition: 'endodoncia' },
      ]),
    ).toThrow(/pieza 36/);
  });

  it('admite varias piezas, varias caras y un tratamiento con sus caras (ADR 0032)', () => {
    expect(() =>
      assertNoScopeConflict([
        cara,
        { ...cara, surface: 'vestibular', condition: 'restauracion' },
        { ...ausente, toothNumber: 36, condition: 'corona' },
      ]),
    ).not.toThrow();

    // Corona + caries en la misma pieza es la boca normal, no un lote ambiguo.
    expect(() =>
      assertNoScopeConflict([
        { ...ausente, toothNumber: 46, surface: null, condition: 'corona' },
        { ...cara, toothNumber: 46, surface: 'occlusal', condition: 'caries' },
      ]),
    ).not.toThrow();

    // Conducto con corona: la otra pareja real.
    expect(() =>
      assertNoScopeConflict([
        { ...ausente, toothNumber: 47, surface: null, condition: 'endodoncia' },
        { ...ausente, toothNumber: 47, surface: null, condition: 'corona' },
      ]),
    ).not.toThrow();
  });
});

describe('histórico append-only', () => {
  it('mapea la entrada con su actor y su fecha', () => {
    const row: ToothFindingHistoryRow = {
      id: 'hist-1',
      odontogramId: 'odontograma-1',
      findingId: null,
      patientId: 'paciente-1',
      toothNumber: 36,
      surface: null,
      condition: 'ausente',
      state: 'pendiente',
      event: 'eliminado',
      reason: 'corrección de captura',
      notes: null,
      actorId: null,
      actorUsername: 'odontologo',
      sessionId: null,
      occurredAt: new Date('2026-10-07T08:15:00.000Z'),
    };

    expect(toHistoryEntry(row)).toEqual({
      id: 'hist-1',
      toothNumber: 36,
      surface: null,
      condition: 'ausente',
      state: 'pendiente',
      event: 'eliminado',
      reason: 'corrección de captura',
      notes: null,
      actorUsername: 'odontologo',
      occurredAt: '2026-10-07T08:15:00.000Z',
    });
  });

  it('el límite por defecto cabe dentro del máximo', () => {
    expect(DEFAULT_HISTORY_LIMIT).toBeLessThanOrEqual(MAX_HISTORY_LIMIT);
    expect(MAX_HISTORY_LIMIT).toBe(500);
  });
});
