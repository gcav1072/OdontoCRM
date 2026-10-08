import { describe, expect, it } from 'vitest';

import { domainAuditPayloadSchema } from './audit.js';
import {
  APPOINTMENT_CONFIRMATION_TEMPLATE,
  DEFAULT_SLOT_TEMPLATES,
  addMinutes,
  assignAppointmentSchema,
  attendAppointmentSchema,
  cancelAppointmentBotSchema,
  confirmAppointmentSchema,
  createRequestSchema,
  expandTemplateSlots,
  formatTime12h,
  minutesBetween,
  rangesOverlap,
  renderTemplate,
  rescheduleAppointmentSchema,
  setCapacitySchema,
  slotTemplateInputSchema,
  weekdayName,
  weekdayOf,
} from './scheduling.js';

describe('horas y fechas de la agenda', () => {
  it('suma minutos sin pasarse de la medianoche', () => {
    expect(addMinutes('08:30', 30)).toBe('09:00');
    expect(addMinutes('23:45', 30)).toBe('23:59');
    expect(addMinutes('08:00', -30)).toBe('07:30');
    expect(addMinutes('11:30', 120)).toBe('13:30');
  });

  it('calcula minutos entre dos horas', () => {
    expect(minutesBetween('08:00', '12:00')).toBe(240);
    expect(minutesBetween('13:00', '17:00')).toBe(240);
    expect(minutesBetween('12:00', '13:00')).toBe(60);
    expect(minutesBetween('17:00', '08:00')).toBeLessThan(0);
  });

  it('muestra las horas en 12 h con a. m. y p. m. (ADR 0025)', () => {
    expect(formatTime12h('08:30')).toBe('8:30 a. m.');
    expect(formatTime12h('00:15')).toBe('12:15 a. m.');
    expect(formatTime12h('12:00')).toBe('12:00 p. m.');
    expect(formatTime12h('13:05')).toBe('1:05 p. m.');
    expect(formatTime12h('23:59')).toBe('11:59 p. m.');
  });

  it('ubica el día de la semana de una fecha', () => {
    expect(weekdayOf('2026-10-05')).toBe(1);
    expect(weekdayName(weekdayOf('2026-10-05'))).toBe('lunes');
    expect(weekdayOf('2026-10-10')).toBe(6);
    expect(weekdayName(6)).toBe('sábado');
  });

  it('detecta rangos de hora solapados', () => {
    expect(
      rangesOverlap(
        { startTime: '08:00', endTime: '08:30' },
        { startTime: '08:15', endTime: '08:45' },
      ),
    ).toBe(true);
    expect(
      rangesOverlap(
        { startTime: '08:00', endTime: '08:30' },
        { startTime: '08:30', endTime: '09:00' },
      ),
    ).toBe(false);
    expect(
      rangesOverlap(
        { startTime: '12:00', endTime: '13:00' },
        { startTime: '13:00', endTime: '17:00' },
      ),
    ).toBe(false);
  });
});

describe('franjas de la jornada', () => {
  it('divide la jornada en franjas de 30 minutos', () => {
    const slots = expandTemplateSlots({
      startTime: '08:00',
      endTime: '12:00',
      slotMinutes: 30,
      breaks: [],
    });
    expect(slots).toHaveLength(8);
    expect(slots[0]).toEqual({ startTime: '08:00', endTime: '08:30' });
    expect(slots.at(-1)).toEqual({ startTime: '11:30', endTime: '12:00' });
  });

  it('deja fuera las franjas que caen en una pausa', () => {
    const slots = expandTemplateSlots({
      startTime: '08:00',
      endTime: '10:00',
      slotMinutes: 30,
      breaks: [{ startTime: '08:30', endTime: '09:30' }],
    });
    expect(slots.map((slot) => slot.startTime)).toEqual(['08:00', '09:30']);
  });

  it('la jornada por defecto da 16 franjas al día (8 por turno)', () => {
    const lunes = DEFAULT_SLOT_TEMPLATES.filter((template) => template.weekday === 1);
    expect(DEFAULT_SLOT_TEMPLATES).toHaveLength(10);
    const slots = lunes.flatMap((template) => expandTemplateSlots(template));
    expect(slots).toHaveLength(16);
    expect(slots[7]).toEqual({ startTime: '11:30', endTime: '12:00' });
    expect(slots[8]).toEqual({ startTime: '13:00', endTime: '13:30' });
  });

  it('valida que la jornada sea más larga que la franja y que las pausas tengan sentido', () => {
    expect(
      slotTemplateInputSchema.safeParse({
        weekday: 1,
        startTime: '08:00',
        endTime: '08:20',
        slotMinutes: 30,
      }).success,
    ).toBe(false);
    expect(
      slotTemplateInputSchema.safeParse({
        weekday: 1,
        startTime: '08:00',
        endTime: '12:00',
        breaks: [{ startTime: '12:00', endTime: '12:00' }],
      }).success,
    ).toBe(false);
    expect(
      slotTemplateInputSchema.safeParse({ weekday: 1, startTime: '08:00', endTime: '12:00' })
        .success,
    ).toBe(true);
  });
});

describe('solicitudes de cita', () => {
  it('aplica los valores por defecto del canal y la prioridad', () => {
    const parsed = createRequestSchema.parse({
      patientId: globalThis.crypto.randomUUID(),
      patientName: 'María Pérez',
      reason: 'Dolor en la muela del juicio',
    });
    expect(parsed.channel).toBe('registro');
    expect(parsed.priority).toBe(0);
  });

  it('exige paciente y motivo', () => {
    expect(createRequestSchema.safeParse({ patientName: 'María', reason: 'Dolor' }).success).toBe(
      false,
    );
    expect(
      createRequestSchema.safeParse({
        patientId: globalThis.crypto.randomUUID(),
        patientName: 'María',
        reason: 'ay',
      }).success,
    ).toBe(false);
  });

  it('rechaza un canal desconocido', () => {
    expect(
      createRequestSchema.safeParse({
        patientId: globalThis.crypto.randomUUID(),
        patientName: 'María Pérez',
        reason: 'Limpieza',
        channel: 'sms',
      }).success,
    ).toBe(false);
  });
});

describe('asignación de citas', () => {
  it('acepta una solicitud con fecha y hora de franja', () => {
    const parsed = assignAppointmentSchema.parse({
      requestId: globalThis.crypto.randomUUID(),
      date: '2026-10-05',
      startTime: '08:30',
    });
    expect(parsed.slotKind).toBe('franja');
    expect(parsed.authorizeOverbook).toBe(false);
  });

  it('exige solicitud o paciente para la cita directa', () => {
    expect(
      assignAppointmentSchema.safeParse({ date: '2026-10-05', startTime: '08:30' }).success,
    ).toBe(false);
    expect(
      assignAppointmentSchema.safeParse({
        patientId: globalThis.crypto.randomUUID(),
        patientName: 'Ana Gómez',
        date: '2026-10-05',
        startTime: '08:30',
        slotKind: 'manual',
      }).success,
    ).toBe(true);
  });

  it('el sobrecupo necesita motivo', () => {
    const base = {
      requestId: globalThis.crypto.randomUUID(),
      date: '2026-10-05',
      startTime: '08:30',
    };
    expect(assignAppointmentSchema.safeParse({ ...base, authorizeOverbook: true }).success).toBe(
      false,
    );
    expect(
      assignAppointmentSchema.safeParse({
        ...base,
        authorizeOverbook: true,
        overbookReason: 'paciente con dolor agudo',
      }).success,
    ).toBe(true);
  });

  it('valida fecha y hora', () => {
    const base = { requestId: globalThis.crypto.randomUUID() };
    expect(
      assignAppointmentSchema.safeParse({ ...base, date: '05/10/2026', startTime: '08:30' })
        .success,
    ).toBe(false);
    expect(
      assignAppointmentSchema.safeParse({ ...base, date: '2026-10-05', startTime: '25:00' })
        .success,
    ).toBe(false);
    expect(
      assignAppointmentSchema.safeParse({ ...base, date: '2026-10-05', startTime: '8:30' }).success,
    ).toBe(false);
  });

  it('la reprogramación lleva fecha, hora y motivo opcional', () => {
    const parsed = rescheduleAppointmentSchema.parse({
      date: '2026-10-06',
      startTime: '09:00',
      reason: 'el paciente pidió cambiarla',
    });
    expect(parsed.slotKind).toBe('franja');
    expect(parsed.reason).toBe('el paciente pidió cambiarla');
    expect(rescheduleAppointmentSchema.safeParse({ date: '2026-10-06' }).success).toBe(false);
  });
});

describe('cupo del día', () => {
  it('admite cualquier cupo entre 0 y 100', () => {
    expect(setCapacitySchema.parse({ date: '2026-10-05', capacity: 12 }).capacity).toBe(12);
    expect(setCapacitySchema.safeParse({ date: '2026-10-05', capacity: -1 }).success).toBe(false);
    expect(setCapacitySchema.safeParse({ date: '2026-10-05', capacity: 101 }).success).toBe(false);
  });
});

describe('marcar atendido', () => {
  it('el motivo es opcional en el contrato (el servicio lo exige si no hay sesión clínica)', () => {
    expect(attendAppointmentSchema.safeParse({}).success).toBe(true);
    expect(
      attendAppointmentSchema.parse({ forceReason: 'paciente llegó tarde y se atendió' })
        .forceReason,
    ).toContain('tarde');
  });
});

describe('confirmar y cancelar por el bot (ADR 0052/0053)', () => {
  it('acepta `null` en los campos opcionales: es como los manda el cliente del bot', () => {
    // El cliente interno del bot manda siempre `note`/`reason`, con `null` cuando el
    // paciente no escribe nada. Con `.optional()` Zod 4 rechazaba ese `null` con un 400
    // y el paciente se quedaba sin poder confirmar ni cancelar (regresión real).
    expect(
      confirmAppointmentSchema.safeParse({ channel: 'telegram', note: null }).success,
    ).toBe(true);
    expect(
      cancelAppointmentBotSchema.safeParse({ channel: 'telegram', reason: null }).success,
    ).toBe(true);
  });

  it('sigue admitiendo que el campo no venga y recorta los espacios', () => {
    const sinNota = confirmAppointmentSchema.parse({ channel: 'telefono' });
    expect(sinNota.note).toBeUndefined();

    const conNota = confirmAppointmentSchema.parse({
      channel: 'telefono',
      note: '  dijo que sí  ',
    });
    expect(conNota.note).toBe('dijo que sí');

    const conMotivo = cancelAppointmentBotSchema.parse({
      channel: 'telegram',
      reason: '  no puedo ir  ',
    });
    expect(conMotivo.reason).toBe('no puedo ir');
  });

  it('exige el canal en los dos', () => {
    expect(confirmAppointmentSchema.safeParse({ note: null }).success).toBe(false);
    expect(cancelAppointmentBotSchema.safeParse({}).success).toBe(false);
  });
});

describe('plantilla del aviso al paciente', () => {
  it('sustituye los marcadores y deja los desconocidos', () => {
    const texto = renderTemplate('Hola {paciente}, tu cita es el {fecha} a las {hora} {otro}', {
      paciente: 'María',
      fecha: '05/10/2026',
      hora: '8:30 a. m.',
    });
    expect(texto).toBe('Hola María, tu cita es el 05/10/2026 a las 8:30 a. m. {otro}');
  });

  it('la plantilla real queda con la puntuación correcta en 12 h', () => {
    const texto = renderTemplate(APPOINTMENT_CONFIRMATION_TEMPLATE.body, {
      paciente: 'María Pérez',
      fecha: '05/10/2026',
      hora: formatTime12h('08:30'),
      lugar: 'Av. Luis del Valle García, C.E. Nueva Esparta',
      ticket: '#000123',
    });

    expect(texto).toContain('Hola María Pérez: te esperamos el 05/10/2026 a las 8:30 a. m.');
    expect(texto).toContain('Lugar: Av. Luis del Valle García, C.E. Nueva Esparta');
    expect(texto).toContain('Tu ticket es #000123');
    // El aviso pide confirmar (ADR 0052): avisar y confirmar son dos hechos distintos.
    expect(texto).toContain('Responde «confirmar»');
    expect(texto).not.toContain('m..');
    expect(texto).not.toContain('{');
  });
});

describe('carga de auditoría genérica', () => {
  it('valida la carga que publican los servicios nuevos', () => {
    const payload = domainAuditPayloadSchema.parse({
      entityType: 'appointment',
      entityId: globalThis.crypto.randomUUID(),
      action: 'appointment_overbook_authorized',
      summary: 'Sobrecupo autorizado para el 06/10/2026',
      changedFields: ['capacity'],
      before: { assigned: 16, capacity: 16 },
      after: { assigned: 17, capacity: 16 },
      reason: 'paciente con dolor agudo',
      actorId: null,
      actorUsername: 'admin',
      ip: '127.0.0.1',
      userAgent: 'vitest',
      requestId: 'req-1',
    });

    expect(payload.action).toBe('appointment_overbook_authorized');
    expect(domainAuditPayloadSchema.safeParse({ entityType: 'appointment' }).success).toBe(false);
  });
});
