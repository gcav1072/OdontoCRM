import type {
  AppointmentSummary,
  Chair,
  ChairDayView,
  DayCounts,
  DaySlot,
  DayView,
} from '@odontocrm/contracts';
import { describe, expect, it } from 'vitest';

import { applyDayChanges } from './scheduling';

const FECHA = '2026-10-19';
const INSTANTE = '2026-10-18T10:00:00Z';

const consultorio: Chair = {
  id: globalThis.crypto.randomUUID(),
  label: 'Consultorio 1',
  shortLabel: null,
  isActive: true,
  sortOrder: 0,
  createdAt: INSTANTE,
  updatedAt: INSTANTE,
};

const contadores = (): DayCounts => ({
  programadas: 0,
  notificadas: 0,
  confirmadas: 0,
  enSala: 0,
  atendidas: 0,
  noAsistio: 0,
  canceladas: 0,
});

const unaCita = (overrides: Partial<AppointmentSummary> = {}): AppointmentSummary => ({
  id: globalThis.crypto.randomUUID(),
  requestId: null,
  ticket: null,
  ticketNumber: null,
  patientId: globalThis.crypto.randomUUID(),
  patientName: 'Paciente de prueba',
  patientDocument: null,
  patientPhone: null,
  date: FECHA,
  startTime: '08:00',
  endTime: '08:30',
  durationMinutes: 30,
  slotKind: 'franja',
  status: 'programada',
  callCount: 0,
  confirmedAt: null,
  confirmedChannel: null,
  cancelledAt: null,
  cancelledChannel: null,
  dentistId: null,
  dentistName: null,
  chairId: consultorio.id,
  chairLabel: consultorio.label,
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
  createdAt: INSTANTE,
  updatedAt: INSTANTE,
  ...overrides,
});

const franja = (startTime: string, endTime: string): DaySlot => ({
  startTime,
  endTime,
  kind: 'franja',
  state: 'libre',
  chairId: consultorio.id,
  chairLabel: consultorio.label,
  appointment: null,
});

/** Jornada de 8:00 a 10:00 en franjas de 30 minutos (cuatro franjas). */
const unaJornada = (citas: AppointmentSummary[] = []): DayView => {
  const slots = [
    franja('08:00', '08:30'),
    franja('08:30', '09:00'),
    franja('09:00', '09:30'),
    franja('09:30', '10:00'),
  ].map((slot) => {
    const cita = citas.find(
      (candidata) => candidata.startTime < slot.endTime && slot.startTime < candidata.endTime,
    );
    return cita === undefined ? slot : { ...slot, state: 'ocupada' as const, appointment: cita };
  });
  const vista: ChairDayView = {
    chair: consultorio,
    capacity: {
      date: FECHA,
      chairId: consultorio.id,
      chairLabel: consultorio.label,
      capacity: 4,
      source: 'plantilla',
      assigned: 0,
      available: 4,
      isFull: false,
      warning: null,
    },
    ownSchedule: false,
    slots,
    counts: contadores(),
  };

  return {
    date: FECHA,
    weekday: 1,
    weekdayName: 'lunes',
    isWorkingDay: true,
    chairs: [vista],
    capacity: {
      date: FECHA,
      chairId: null,
      chairLabel: null,
      capacity: 4,
      source: 'plantilla',
      assigned: 0,
      available: 4,
      isFull: false,
      warning: null,
    },
    appointments: citas,
    waiting: [],
    counts: contadores(),
  };
};

describe('parcheo de la jornada con cupo en franjas', () => {
  it('una cita de dos horas ocupa las cuatro franjas y gasta cuatro de cupo', () => {
    const larga = unaCita({
      startTime: '08:00',
      endTime: '10:00',
      durationMinutes: 120,
      slotKind: 'manual',
    });
    const dia = applyDayChanges(unaJornada(), [{ appointment: larga }]);

    const vista = dia.chairs[0];
    expect(vista?.slots.every((slot) => slot.state === 'ocupada')).toBe(true);
    expect(vista?.capacity.assigned).toBe(4);
    expect(vista?.capacity.available).toBe(0);
    expect(vista?.capacity.isFull).toBe(true);
    expect(dia.capacity.assigned).toBe(4);
    expect(dia.capacity.isFull).toBe(true);
  });

  it('cancelar la cita larga libera las cuatro franjas', () => {
    const larga = unaCita({
      startTime: '08:00',
      endTime: '10:00',
      durationMinutes: 120,
      slotKind: 'manual',
    });
    const ocupada = applyDayChanges(unaJornada(), [{ appointment: larga }]);
    const cancelada = applyDayChanges(ocupada, [
      { appointment: { ...larga, status: 'cancelada' }, previous: larga },
    ]);

    expect(cancelada.chairs[0]?.slots.every((slot) => slot.state === 'libre')).toBe(true);
    expect(cancelada.chairs[0]?.capacity.assigned).toBe(0);
    expect(cancelada.capacity.assigned).toBe(0);
  });

  it('una cita de media hora gasta una franja', () => {
    const corta = unaCita();
    const dia = applyDayChanges(unaJornada(), [{ appointment: corta }]);

    expect(dia.chairs[0]?.capacity.assigned).toBe(1);
    expect(dia.chairs[0]?.slots.filter((slot) => slot.state === 'ocupada')).toHaveLength(1);
  });

  it('una cita fuera de la rejilla se pinta como hora manual y gasta una', () => {
    const fuera = unaCita({
      startTime: '10:15',
      endTime: '10:45',
      durationMinutes: 30,
      slotKind: 'manual',
    });
    const dia = applyDayChanges(unaJornada(), [{ appointment: fuera }]);

    const manual = dia.chairs[0]?.slots.find((slot) => slot.kind === 'manual');
    expect(manual?.startTime).toBe('10:15');
    expect(manual?.state).toBe('ocupada');
    expect(dia.chairs[0]?.capacity.assigned).toBe(1);
    // Las cuatro franjas de plantilla siguen siendo el cupo.
    expect(dia.chairs[0]?.capacity.capacity).toBe(4);
  });

  it('sin turnos el día está cerrado y una cita manual gasta cupo sobre cero', () => {
    const dia = unaJornada();
    const cerrada: DayView = {
      ...dia,
      chairs: [
        {
          ...dia.chairs[0]!,
          slots: [],
          capacity: {
            ...dia.chairs[0]!.capacity,
            capacity: 0,
            available: 0,
            isFull: true,
            source: 'sin_turnos',
          },
        },
      ],
      capacity: { ...dia.capacity, capacity: 0, available: 0, isFull: true, source: 'sin_turnos' },
    };
    const fuera = unaCita({ startTime: '09:00', endTime: '09:30', slotKind: 'manual' });

    const conCita = applyDayChanges(cerrada, [{ appointment: fuera }]);
    expect(conCita.chairs[0]?.capacity.capacity).toBe(0);
    expect(conCita.chairs[0]?.capacity.assigned).toBe(1);
    expect(conCita.chairs[0]?.capacity.isFull).toBe(true);
    expect(conCita.capacity.assigned).toBe(1);
  });
});
