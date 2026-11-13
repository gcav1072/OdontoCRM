import { describe, expect, it } from 'vitest';

import {
  reminderHourOptions,
  reminderHourText,
  reminderPolicyChanges,
  reminderPolicyFrom,
  reminderPolicyIsValid,
  reminderPolicySummary,
  type ReminderPolicyDraft,
} from './notifications';

const politica = (overrides: Partial<ReminderPolicyDraft> = {}): ReminderPolicyDraft => ({
  daysBefore: 1,
  sendHour: 9,
  includeConfirmed: false,
  autoSendDocuments: false,
  ...overrides,
});

describe('reminderPolicyFrom', () => {
  it('traduce los campos del contrato al borrador de la tarjeta', () => {
    expect(
      reminderPolicyFrom({
        reminderDaysBefore: 2,
        reminderSendHour: 14,
        reminderIncludeConfirmed: true,
        autoSendDocuments: true,
      }),
    ).toEqual({
      daysBefore: 2,
      sendHour: 14,
      includeConfirmed: true,
      autoSendDocuments: true,
    });
  });
});

describe('reminderPolicyChanges', () => {
  it('manda solo lo que cambió (PATCH parcial)', () => {
    const cambios = reminderPolicyChanges(politica(), politica({ daysBefore: 3, sendHour: 10 }));

    expect(cambios).toEqual({ reminderDaysBefore: 3, reminderSendHour: 10 });
  });

  it('manda los interruptores solo cuando cambian, y juntos si cambian a la vez', () => {
    expect(
      reminderPolicyChanges(
        politica(),
        politica({ includeConfirmed: true, autoSendDocuments: true }),
      ),
    ).toEqual({ reminderIncludeConfirmed: true, autoSendDocuments: true });
  });

  it('sin cambios devuelve un cuerpo vacío', () => {
    expect(reminderPolicyChanges(politica(), politica())).toEqual({});
  });
});

describe('reminderPolicyIsValid', () => {
  it('acepta los extremos del contrato: 0 y 30 días, 7 y 20 horas', () => {
    expect(reminderPolicyIsValid(politica({ daysBefore: 0, sendHour: 7 }))).toBe(true);
    expect(reminderPolicyIsValid(politica({ daysBefore: 30, sendHour: 20 }))).toBe(true);
  });

  it('rechaza números fuera de rango, decimales y horas de madrugada', () => {
    expect(reminderPolicyIsValid(politica({ daysBefore: -1 }))).toBe(false);
    expect(reminderPolicyIsValid(politica({ daysBefore: 31 }))).toBe(false);
    expect(reminderPolicyIsValid(politica({ daysBefore: 1.5 }))).toBe(false);
    expect(reminderPolicyIsValid(politica({ sendHour: 6 }))).toBe(false);
    expect(reminderPolicyIsValid(politica({ sendHour: 21 }))).toBe(false);
    expect(reminderPolicyIsValid(politica({ sendHour: 9.5 }))).toBe(false);
  });
});

describe('reminderPolicySummary', () => {
  it('con 0 días queda desactivado', () => {
    expect(reminderPolicySummary(politica({ daysBefore: 0 }))).toEqual({ active: false });
  });

  it('con días dice cuándo saldrá el recordatorio, en texto de hora local', () => {
    expect(reminderPolicySummary(politica({ daysBefore: 1, sendHour: 9 }))).toEqual({
      active: true,
      daysBefore: 1,
      sendHour: 9,
      hourText: '9:00',
    });
  });
});

describe('reminderHourText y reminderHourOptions', () => {
  it('escribe la hora como la ve el consultorio', () => {
    expect(reminderHourText(7)).toBe('7:00');
    expect(reminderHourText(20)).toBe('20:00');
  });

  it('ofrece la ventana diurna completa del contrato (7..20)', () => {
    const horas = reminderHourOptions();
    expect(horas).toHaveLength(14);
    expect(horas[0]).toBe(7);
    expect(horas[horas.length - 1]).toBe(20);
  });
});
