import { describe, expect, it } from 'vitest';

import type { AppointmentSummary } from '@odontocrm/contracts';

import { citasQueRespaldan, citaPorDefecto } from './session-appointments';

/**
 * Pruebas del desplegable «Cita que respalda la sesión».
 *
 * El síntoma que las abrió: el desplegable solo ofrecía «Sin cita» porque la lista se
 * pedía **solo del día de hoy** y el paciente tenía su cita programada para otro día.
 * Lo que se fija aquí es qué citas se ofrecen, en qué orden y cuál se marca sola.
 */

const HOY = '2026-10-18';

const cita = (cambios: Partial<AppointmentSummary> = {}): AppointmentSummary => ({
  id: 'cita-1',
  requestId: null,
  ticket: '#000001',
  ticketNumber: 1,
  patientId: 'pac-1',
  patientName: 'Juana Pérez',
  patientDocument: 'V-12345678',
  patientPhone: '+584121234567',
  date: HOY,
  startTime: '09:00',
  endTime: '09:30',
  durationMinutes: 30,
  slotKind: 'franja',
  status: 'programada',
  callCount: 0,
  confirmedAt: null,
  confirmedChannel: null,
  cancelledAt: null,
  cancelledChannel: null,
  dentistId: null,
  chairId: null,
  chairLabel: null,
  dentistName: null,
  checkedInAt: null,
  startedAt: null,
  finishedAt: null,
  noShowReason: null,
  forceAttendedReason: null,
  clinicalSessionId: null,
  rescheduledFromId: null,
  rescheduledToId: null,
  icsSequence: 0,
  notes: null,
  createdAt: `${HOY}T08:00:00.000Z`,
  updatedAt: `${HOY}T08:00:00.000Z`,
  ...cambios,
});

describe('citasQueRespaldan', () => {
  it('ofrece las pendientes de hoy y las próximas, no solo las de hoy', () => {
    const proxima = cita({ id: 'manana', date: '2026-10-19', startTime: '08:00' });
    const confirmada = cita({ id: 'confirmada', status: 'confirmada', startTime: '10:00' });

    const ofrecidas = citasQueRespaldan([proxima, confirmada], HOY);
    expect(ofrecidas.map((fila) => fila.id)).toEqual(['confirmada', 'manana']);
  });

  it('deja fuera las cerradas, las canceladas y las de días pasados', () => {
    const filas = [
      cita({ id: 'atendida', status: 'atendido' }),
      cita({ id: 'no-vino', status: 'no_asistio' }),
      cita({ id: 'cancelada', status: 'cancelada' }),
      cita({ id: 'reprogramada', status: 'reprogramada' }),
      cita({ id: 'ayer', date: '2026-10-17' }),
      cita({ id: 'valida' }),
    ];

    expect(citasQueRespaldan(filas, HOY).map((fila) => fila.id)).toEqual(['valida']);
  });

  it('pone primero al que está en el circuito del día', () => {
    const programada = cita({ id: 'programada', startTime: '08:00', status: 'programada' });
    const espera = cita({ id: 'espera', startTime: '09:00', status: 'en_sala_espera' });
    const llamado = cita({ id: 'llamado', startTime: '07:00', status: 'llamado' });
    const enConsulta = cita({ id: 'consulta', startTime: '11:00', status: 'en_consulta' });

    expect(
      citasQueRespaldan([programada, espera, llamado, enConsulta], HOY).map((fila) => fila.id),
    ).toEqual(['consulta', 'llamado', 'espera', 'programada']);
  });
});

describe('citaPorDefecto', () => {
  it('elige al paciente que está en el consultorio', () => {
    const citas = [
      cita({ id: 'manana', date: '2026-10-19', startTime: '08:00' }),
      cita({ id: 'consulta', status: 'en_consulta' }),
    ];
    expect(citaPorDefecto(citas, HOY)?.id).toBe('consulta');
  });

  it('con una sola cita pendiente de hoy la marca; con varias no adivina', () => {
    const unica = cita({ id: 'unica' });
    expect(citaPorDefecto([unica], HOY)?.id).toBe('unica');

    const dos = [cita({ id: 'a', startTime: '08:00' }), cita({ id: 'b', startTime: '15:00' })];
    expect(citaPorDefecto(dos, HOY)).toBeUndefined();

    // Una cita futura no se marca sola: enlazar la sesión a otro día prendería su «atendido».
    expect(citaPorDefecto([cita({ id: 'manana', date: '2026-10-19' })], HOY)).toBeUndefined();
  });

  it('sin citas no hay nada que marcar', () => {
    expect(citaPorDefecto([], HOY)).toBeUndefined();
    expect(citasQueRespaldan([], HOY)).toEqual([]);
  });
});
