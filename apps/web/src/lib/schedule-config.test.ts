import type { SlotTemplate } from '@odontocrm/contracts';
import { describe, expect, it } from 'vitest';

import {
  countSlots,
  factoryShifts,
  fromTime12,
  minuteOptions,
  sameShifts,
  shiftsForDay,
  slotsOfShifts,
  toTime12,
  validateShifts,
} from './schedule-config';

const plantilla = (
  weekday: number,
  startTime: string,
  endTime: string,
  extra: Partial<SlotTemplate> = {},
): SlotTemplate => ({
  id: `t-${weekday}-${startTime}`,
  weekday,
  chairId: null,
  startTime,
  endTime,
  slotMinutes: 30,
  breaks: [],
  isActive: true,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
  ...extra,
});

describe('turnos del día', () => {
  it('toma solo los turnos comunes y activos, en orden de hora', () => {
    const templates = [
      plantilla(1, '14:00', '17:00'),
      plantilla(1, '08:00', '12:00'),
      plantilla(1, '18:00', '20:00', { isActive: false }),
      plantilla(1, '09:00', '10:00', { chairId: 'sillon-propio' }),
      plantilla(2, '08:00', '12:00'),
    ];
    expect(shiftsForDay(templates, 1)).toEqual([
      { startTime: '08:00', endTime: '12:00' },
      { startTime: '14:00', endTime: '17:00' },
    ]);
  });

  it('un día sin turnos devuelve la lista vacía (el atajo de fábrica es aparte)', () => {
    expect(shiftsForDay([], 0)).toEqual([]);
    expect(factoryShifts()).toEqual([
      { startTime: '08:00', endTime: '12:00' },
      { startTime: '14:00', endTime: '17:00' },
    ]);
  });
});

describe('franjas que producen los turnos', () => {
  it('el horario de fábrica da 14 franjas de 30 minutos', () => {
    expect(countSlots(factoryShifts(), 30)).toBe(14);
    expect(slotsOfShifts(factoryShifts(), 30).at(-1)).toEqual({
      startTime: '16:30',
      endTime: '17:00',
    });
  });

  it('con franjas de una hora el mismo horario da 7', () => {
    expect(countSlots(factoryShifts(), 60)).toBe(7);
  });

  it('un turno más corto que la franja no produce ninguna', () => {
    expect(countSlots([{ startTime: '09:00', endTime: '09:20' }], 30)).toBe(0);
  });
});

describe('validación de turnos', () => {
  it('acepta dos turnos separados', () => {
    expect(validateShifts(factoryShifts(), 30)).toEqual([]);
  });

  it('detecta turnos invertidos, solapados y más cortos que la franja', () => {
    expect(validateShifts([{ startTime: '12:00', endTime: '08:00' }], 30)).toEqual([
      { kind: 'invertido', index: 0 },
    ]);
    expect(
      validateShifts(
        [
          { startTime: '08:00', endTime: '12:00' },
          { startTime: '11:00', endTime: '13:00' },
        ],
        30,
      ),
    ).toEqual([
      { kind: 'solape', index: 0 },
      { kind: 'solape', index: 1 },
    ]);
    expect(validateShifts([{ startTime: '08:00', endTime: '08:20' }], 30)).toEqual([
      { kind: 'corta', index: 0, minutos: 20 },
    ]);
  });

  it('un turno a medio llenar es «vacío», no un error de longitud', () => {
    expect(validateShifts([{ startTime: '08:00', endTime: '' }], 30)).toEqual([
      { kind: 'vacio', index: 0 },
    ]);
  });
});

describe('hora en 12 h', () => {
  it('convierte ida y vuelta sin perder la medianoche ni el mediodía', () => {
    expect(toTime12('00:00')).toEqual({ hour: 12, minute: 0, meridiem: 'am' });
    expect(toTime12('12:00')).toEqual({ hour: 12, minute: 0, meridiem: 'pm' });
    expect(toTime12('14:30')).toEqual({ hour: 2, minute: 30, meridiem: 'pm' });
    expect(fromTime12({ hour: 12, minute: 0, meridiem: 'am' })).toBe('00:00');
    expect(fromTime12({ hour: 12, minute: 0, meridiem: 'pm' })).toBe('12:00');
    expect(fromTime12({ hour: 2, minute: 30, meridiem: 'pm' })).toBe('14:30');
    expect(fromTime12({ hour: 8, minute: 5, meridiem: 'am' })).toBe('08:05');
  });

  it('el selector de minutos conserva un minuto que no cae en la rejilla de 5', () => {
    expect(minuteOptions(0)).toHaveLength(12);
    expect(minuteOptions(7)).toContain(7);
    expect(minuteOptions(7)).toHaveLength(13);
  });
});

describe('comparación de turnos', () => {
  it('detecta si el horario cambió', () => {
    expect(sameShifts(factoryShifts(), factoryShifts())).toBe(true);
    expect(sameShifts(factoryShifts(), [{ startTime: '08:00', endTime: '12:00' }])).toBe(false);
  });
});
