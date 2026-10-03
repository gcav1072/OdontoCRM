import { describe, expect, it } from 'vitest';

import { cyclePrefix, formatTicket, parseTicket, TICKET_SEQUENCE_MAX } from './ticket.js';

describe('cyclePrefix', () => {
  it('no pone prefijo en el primer ciclo', () => {
    expect(cyclePrefix(0)).toBe('');
  });

  it('usa una letra por ciclo y luego dos', () => {
    expect(cyclePrefix(1)).toBe('A');
    expect(cyclePrefix(2)).toBe('B');
    expect(cyclePrefix(26)).toBe('Z');
    expect(cyclePrefix(27)).toBe('AA');
    expect(cyclePrefix(28)).toBe('AB');
    expect(cyclePrefix(52)).toBe('AZ');
    expect(cyclePrefix(53)).toBe('BA');
  });

  it('rechaza ciclos inválidos', () => {
    expect(() => cyclePrefix(-1)).toThrow(RangeError);
    expect(() => cyclePrefix(1.5)).toThrow(RangeError);
  });
});

describe('formatTicket', () => {
  it('formatea con seis dígitos y almohadilla en el primer ciclo', () => {
    expect(formatTicket(1).value).toBe('#000001');
    expect(formatTicket(123).value).toBe('#000123');
    expect(formatTicket(TICKET_SEQUENCE_MAX).value).toBe('#999999');
  });

  it('salta al prefijo alfabético al superar 999999', () => {
    expect(formatTicket(TICKET_SEQUENCE_MAX + 1).value).toBe('A-000001');
    expect(formatTicket(TICKET_SEQUENCE_MAX * 2).value).toBe('A-999999');
    expect(formatTicket(TICKET_SEQUENCE_MAX * 2 + 1).value).toBe('B-000001');
  });

  it('rechaza valores fuera de rango', () => {
    expect(() => formatTicket(0)).toThrow(RangeError);
    expect(() => formatTicket(-5)).toThrow(RangeError);
    expect(() => formatTicket(1.2)).toThrow(RangeError);
  });
});

describe('parseTicket', () => {
  it('acepta lo que el paciente escribe con o sin prefijo', () => {
    expect(parseTicket('#000123')?.value).toBe('#000123');
    expect(parseTicket('000123')?.value).toBe('#000123');
    expect(parseTicket(' 123 ')?.value).toBe('#000123');
    expect(parseTicket('a-000001')?.value).toBe('A-000001');
    expect(parseTicket('A000001')?.value).toBe('A-000001');
    expect(parseTicket('AA-000001')?.value).toBe('AA-000001');
  });

  it('rechaza entradas inválidas', () => {
    expect(parseTicket('')).toBeNull();
    expect(parseTicket('abc')).toBeNull();
    expect(parseTicket('#000000')).toBeNull();
    expect(parseTicket('#1234567')).toBeNull();
  });

  it('ida y vuelta: formatear y volver a parsear devuelve lo mismo', () => {
    for (const value of [1, 42, 999_999, 1_000_000, 1_999_999, 2_000_000]) {
      const formatted = formatTicket(value);
      expect(parseTicket(formatted.value)?.value).toBe(formatted.value);
    }
  });
});
