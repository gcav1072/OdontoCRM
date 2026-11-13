import type { AppointmentSummary } from '@odontocrm/contracts';
import { describe, expect, it } from 'vitest';

import {
  REMINDER_WINDOW_END_HOUR,
  addCalendarDays,
  diasDeAviso,
  hourInClinic,
  reminderDedupeKey,
} from './reminders.js';

const cita = (overrides: Partial<AppointmentSummary> = {}): AppointmentSummary =>
  ({
    id: '11111111-1111-4111-8111-111111111111',
    date: '2026-12-01',
    icsSequence: 0,
    ...overrides,
  }) as AppointmentSummary;

/**
 * Recordatorios automáticos `N` días antes (v1.2, §6.3): la parte pura es la que
 * decide la fecha objetivo y la clave de idempotencia. La ventana horaria se prueba
 * con horas reales de Caracas, porque es la zona del consultorio y no la del servidor.
 */
describe('cálculo del día del recordatorio', () => {
  it('suma días de calendario sin cruzar zonas horarias', () => {
    expect(addCalendarDays('2026-11-13', 1)).toBe('2026-11-14');
    expect(addCalendarDays('2026-11-30', 1)).toBe('2026-12-01');
    expect(addCalendarDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addCalendarDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addCalendarDays('2026-11-13', 0)).toBe('2026-11-13');
  });

  it('la hora local es la de Caracas: 02:00 UTC aún es el día y la hora de antes', () => {
    // 2026-11-14T02:00Z es 22:00 del 13 en Caracas (UTC−4).
    expect(hourInClinic(new Date('2026-11-14T02:00:00Z'))).toBe(22);
    expect(hourInClinic(new Date('2026-11-14T14:00:00Z'))).toBe(10);
    expect(hourInClinic(new Date('2026-11-14T03:00:00Z'))).toBe(23);
    expect(REMINDER_WINDOW_END_HOUR).toBe(21);
  });

  it('el marcador {dias} se lee como «mañana» o «en N días»', () => {
    expect(diasDeAviso(1)).toBe('mañana');
    expect(diasDeAviso(2)).toBe('en 2 días');
    expect(diasDeAviso(7)).toBe('en 7 días');
  });
});

describe('idempotencia del recordatorio', () => {
  it('la clave incluye cita, fecha, secuencia del .ics y días de antelación', () => {
    expect(reminderDedupeKey(cita(), 1)).toBe(
      'recordatorio:11111111-1111-4111-8111-111111111111:2026-12-01:0:d1',
    );
  });

  it('una reprogamación cambia la clave (nuevo recordatorio) y un reintento no', () => {
    const original = reminderDedupeKey(cita(), 1);
    const reprogramada = reminderDedupeKey(cita({ date: '2026-12-05', icsSequence: 1 }), 1);
    expect(reprogramada).not.toBe(original);
    // El mismo día del mismo barrido da exactamente la misma clave: enqueue no duplica.
    expect(reminderDedupeKey(cita(), 1)).toBe(original);
    // Cambiar los días configurados también es otro recordatorio distinto.
    expect(reminderDedupeKey(cita(), 2)).not.toBe(original);
  });
});
