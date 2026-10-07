import {
  clinicalSectionIsComplete,
  clinicalSessionContentSchema,
  clinicalSectionSchemaFor,
  CLINICAL_SIGNATURE_SECTIONS,
  dentitionOfTooth,
  domainAuditPayloadSchema,
  patientAuditPayloadSchema,
  TOOTH_SURFACES,
  type ClinicalSectionKey,
} from '@odontocrm/contracts';
import { domainEventSchema, EVENT_TOPIC_VALUES } from '@odontocrm/events';
import { describe, expect, it } from 'vitest';

import {
  buildTestWorldEvents,
  worldEventsFor,
  worldEventIds,
  worldFingerprints,
} from './events.js';
import { buildTestWorld, FICTITIOUS_SEQUENCE_MIN, type TestWorld } from './world.js';

/**
 * El mundo del modo test es la base de `seed:test`, `seed:reset` y `seed:verify`:
 * si deja de ser determinista o se cuela un dato imposible, las tres herramientas
 * mienten a la vez. Aquí se comprueban las dos cosas —determinismo e invariantes—
 * sin tocar ninguna base de datos.
 */
const ANCLA = '2026-10-02';
const AHORA = new Date('2026-10-02T14:00:00.000Z');

const mundo = (anchor = ANCLA, now = AHORA): TestWorld => buildTestWorld({ anchor, now });

describe('determinismo', () => {
  it('la misma semilla y el mismo ancla dan exactamente el mismo mundo', () => {
    expect(worldFingerprints(mundo())).toEqual(worldFingerprints(mundo()));
  });

  it('otro ancla da otro mundo (y otras fechas, no otros identificadores)', () => {
    const uno = mundo();
    const otro = mundo('2026-09-15');

    expect(worldFingerprints(otro).appointments).not.toBe(worldFingerprints(uno).appointments);
    // Los pacientes son los mismos: su identidad no depende del día.
    expect(otro.patients.map((patient) => patient.docNumber)).toEqual(
      uno.patients.map((patient) => patient.docNumber),
    );
  });

  it('el ancla por defecto es el día del consultorio del instante recibido', () => {
    // 02:00 UTC del 3 de octubre son las 22:00 del 2 en Venezuela: sigue siendo el día 2.
    expect(mundo(undefined, new Date('2026-10-03T02:00:00.000Z')).anchor).toBe('2026-10-02');
  });
});

describe('pacientes', () => {
  it('son 40, con cédulas del rango reservado y la marca de ficticio', () => {
    const world = mundo();

    expect(world.patients).toHaveLength(40);
    for (const patient of world.patients) {
      expect(Number(patient.docNumber)).toBeGreaterThanOrEqual(90_000_000);
      expect(patient.isFictitious).toBe(true);
      expect(patient.document).toBe(`${patient.docType}-${patient.docNumber}`);
    }
  });

  it('cubre los cinco tramos de edad y los dos sexos', () => {
    const world = mundo();
    const edades = world.patients.map((patient) => patient.age);

    expect(edades.some((edad) => edad <= 12)).toBe(true);
    expect(edades.some((edad) => edad >= 13 && edad <= 17)).toBe(true);
    expect(edades.some((edad) => edad >= 18 && edad <= 40)).toBe(true);
    expect(edades.some((edad) => edad >= 41 && edad <= 65)).toBe(true);
    expect(edades.some((edad) => edad >= 66)).toBe(true);
    expect(world.patients.some((patient) => patient.sex === 'M')).toBe(true);
    expect(world.patients.some((patient) => patient.sex === 'F')).toBe(true);
  });

  it('los menores tienen representante y los adultos no', () => {
    for (const patient of mundo().patients) {
      if (patient.age < 18) expect(patient.guardian).not.toBeNull();
      else expect(patient.guardian).toBeNull();
    }
  });

  it('los perfiles clínicos que piden los reportes están todos', () => {
    const perfiles = new Set(mundo().patients.map((patient) => patient.profile));

    for (const perfil of [
      'sano',
      'caries_multiple',
      'periodontal',
      'diabetes',
      'hipertension',
      'alergia_penicilina',
      'anticoagulado',
      'pediatrico',
      'edentulo_parcial',
    ]) {
      expect(perfiles.has(perfil as never)).toBe(true);
    }
  });

  it('el estado va con la agenda: con cita queda activo, en la cola espera', () => {
    const world = mundo();
    for (const patient of world.patients) {
      const tieneCita = world.appointments.some(
        (appointment) => appointment.patientId === patient.id,
      );
      expect(patient.status).toBe(tieneCita ? 'activo' : 'en_espera_cita');
    }
  });
});

describe('agenda', () => {
  it('el reparto de citas es el que pide el plan', () => {
    const world = mundo();

    expect(world.totals.attended).toBeGreaterThanOrEqual(25);
    expect(world.totals.attended).toBeLessThanOrEqual(30);
    expect(world.totals.noShows).toBeGreaterThanOrEqual(3);
    expect(world.totals.noShows).toBeLessThanOrEqual(5);
    expect(world.totals.today).toBeGreaterThanOrEqual(2);
    expect(world.appointments.some((appointment) => appointment.status === 'en_sala_espera')).toBe(
      true,
    );
    expect(world.appointments.some((appointment) => appointment.status === 'en_consulta')).toBe(
      true,
    );
    expect(world.appointments.some((appointment) => appointment.status === 'cancelada')).toBe(true);
    expect(world.appointments.some((appointment) => appointment.status === 'reprogramada')).toBe(
      true,
    );
  });

  it('ninguna hora está ocupada dos veces en el mismo día', () => {
    const ocupantes = new Set([
      'programada',
      'notificada',
      'en_sala_espera',
      'llamado',
      'en_consulta',
      'atendido',
      'no_asistio',
    ]);
    const claves = mundo()
      .appointments.filter((appointment) => ocupantes.has(appointment.status))
      .map((appointment) => `${appointment.date} ${appointment.startTime}`);

    expect(new Set(claves).size).toBe(claves.length);
  });

  it('la línea de tiempo de cada cita es coherente', () => {
    const world = mundo();
    const solicitud = new Map(world.requests.map((request) => [request.id, request]));

    for (const appointment of world.appointments) {
      const pedido = solicitud.get(appointment.requestId);
      expect(pedido).toBeDefined();
      expect(appointment.scheduledAt >= (pedido?.requestedAt ?? '')).toBe(true);
      if (appointment.notifiedAt !== null) {
        expect(appointment.notifiedAt >= appointment.scheduledAt).toBe(true);
        expect(
          appointment.notifiedAt < `${appointment.date}T${appointment.startTime}:00-04:00`,
        ).toBe(true);
      }
      if (appointment.status === 'atendido') {
        expect(appointment.checkedInAt).not.toBeNull();
        expect(appointment.startedAt).not.toBeNull();
        expect(appointment.finishedAt).not.toBeNull();
        expect(appointment.clinicalSessionId).not.toBeNull();
      }
      if (appointment.status === 'no_asistio') {
        expect(appointment.noShowAt).not.toBeNull();
        expect(appointment.noShowReason).not.toBeNull();
      }
    }
  });

  it('los tickets van en el rango reservado y no se repiten', () => {
    const tickets = mundo().requests.map((request) => request.ticketNumber);

    expect(new Set(tickets).size).toBe(tickets.length);
    for (const ticket of tickets) expect(ticket).toBeGreaterThan(FICTITIOUS_SEQUENCE_MIN);
  });

  it('los cupos son días laborables con la jornada del consultorio', () => {
    for (const capacity of mundo().capacities) {
      const dia = new Date(`${capacity.date}T12:00:00Z`).getUTCDay();
      expect(dia).toBeGreaterThanOrEqual(1);
      expect(dia).toBeLessThanOrEqual(5);
      expect(capacity.capacity).toBeGreaterThan(0);
    }
  });
});

describe('historia clínica y sesiones', () => {
  it('cada visita atendida tiene su historia firmada, con secciones válidas y consentimiento', () => {
    const world = mundo();

    expect(world.records).toHaveLength(
      new Set(world.sessions.map((session) => session.patientId)).size,
    );

    for (const record of world.records) {
      expect(record.status).toBe('firmada');
      expect(record.signedAt).not.toBe('');
      expect(record.consentRegisteredAt).not.toBe('');

      for (const [key, content] of Object.entries(record.sections)) {
        const schema = clinicalSectionSchemaFor(key as ClinicalSectionKey);
        expect(() => schema.parse(content)).not.toThrow();
      }
      for (const key of CLINICAL_SIGNATURE_SECTIONS) {
        expect(clinicalSectionIsComplete(key, record.sections[key])).toBe(true);
      }
    }
  });

  it('las alertas clínicas salen del perfil y son las esperadas', () => {
    const world = mundo();
    const alertas = new Map(world.records.map((record) => [record.patientId, record.alertCodes]));

    // Solo los pacientes con historia (los atendidos): el resto no tiene secciones.
    for (const patient of world.patients) {
      if (!alertas.has(patient.id)) continue;
      const codigos = alertas.get(patient.id) ?? [];
      switch (patient.profile) {
        case 'diabetes':
          expect(codigos).toContain('diabetes');
          break;
        case 'hipertension':
          expect(codigos).toContain('hipertension');
          break;
        case 'alergia_penicilina':
          expect(codigos).toContain('alergia_penicilina');
          break;
        case 'anticoagulado':
          expect(codigos).toContain('anticoagulante');
          break;
        case 'edentulo_parcial':
          expect(codigos.length).toBeGreaterThan(0);
          break;
        case 'sano':
        case 'pediatrico':
          expect(codigos).toHaveLength(0);
          break;
        default:
          break;
      }
    }
  });

  it('las sesiones son cerradas, válidas y numeradas por paciente en orden', () => {
    const world = mundo();
    const numeros = new Map<string, number[]>();

    for (const session of world.sessions) {
      expect(session.status).toBe('cerrada');
      expect(() => clinicalSessionContentSchema.parse(session.content)).not.toThrow();
      expect(session.procedureCodes.length).toBeGreaterThan(0);
      expect(session.closedAt >= session.openedAt).toBe(true);

      const previos = numeros.get(session.patientId) ?? [];
      previos.push(session.sessionNumber);
      numeros.set(session.patientId, previos);
    }

    for (const [, lista] of numeros) {
      expect(lista).toEqual([...lista].sort((left, right) => left - right));
      expect(lista[0]).toBe(1);
    }
  });

  it('cada sesión cuelga de la cita que la respalda y del mismo paciente', () => {
    const world = mundo();
    for (const session of world.sessions) {
      const appointment = world.appointments.find((item) => item.id === session.appointmentId);
      expect(appointment?.patientId).toBe(session.patientId);
      expect(appointment?.clinicalSessionId).toBe(session.id);
      const record = world.records.find((item) => item.id === session.recordId);
      expect(record?.patientId).toBe(session.patientId);
    }
  });
});

describe('récipes y odontogramas', () => {
  it('los récipes son emitidos, con número reservado, código único y al menos un medicamento', () => {
    const world = mundo();
    const codigos = world.prescriptions.map((prescription) => prescription.verifyCode);

    expect(world.prescriptions.length).toBeGreaterThan(0);
    expect(new Set(codigos).size).toBe(codigos.length);

    for (const prescription of world.prescriptions) {
      expect(prescription.number).toBeGreaterThan(FICTITIOUS_SEQUENCE_MIN);
      expect(prescription.items.length).toBeGreaterThan(0);
      const session = world.sessions.find((item) => item.id === prescription.sessionId);
      expect(session?.patientId).toBe(prescription.patientId);
      for (const item of prescription.items) {
        expect(item.medicationName.length).toBeGreaterThan(2);
        expect(item.dose.length).toBeGreaterThan(0);
        expect(item.frequency.length).toBeGreaterThan(0);
      }
    }
  });

  it('los hallazgos respetan el FDI, la clave natural y las reglas de la pieza completa', () => {
    const world = mundo();
    const claves = new Set<string>();

    for (const finding of world.findings) {
      const temporal = finding.toothNumber >= 51;
      expect(dentitionOfTooth(finding.toothNumber)).toBe(temporal ? 'temporal' : 'permanente');

      if (finding.surface !== null) {
        expect(TOOTH_SURFACES).toContain(finding.surface);
        expect(['caries', 'restauracion']).toContain(finding.condition);
      } else {
        expect(['ausente', 'extraccion_indicada', 'corona', 'implante', 'endodoncia']).toContain(
          finding.condition,
        );
      }

      const clave = `${finding.patientId}|${String(finding.toothNumber)}|${finding.surface ?? 'completa'}|${finding.condition}`;
      expect(claves.has(clave)).toBe(false);
      claves.add(clave);
    }
  });

  it('no se registra una cara sobre una pieza ausente', () => {
    const world = mundo();
    const ausentes = new Set(
      world.findings
        .filter((finding) => finding.condition === 'ausente')
        .map((finding) => `${finding.patientId}|${String(finding.toothNumber)}`),
    );

    for (const finding of world.findings) {
      if (finding.surface === null) continue;
      expect(ausentes.has(`${finding.patientId}|${String(finding.toothNumber)}`)).toBe(false);
    }
  });
});

describe('eventos', () => {
  const events = buildTestWorldEvents(mundo());

  it('todos los sobres son válidos y los tópicos existen', () => {
    for (const event of events) {
      expect(EVENT_TOPIC_VALUES).toContain(event.topic);
      expect(() =>
        domainEventSchema.parse({
          eventId: event.id,
          eventType: event.topic,
          version: 1,
          occurredAt: event.occurredAt,
          aggregateId: event.aggregateId,
          producer: event.producer,
          actorId: null,
          correlationId: null,
          payload: event.payload,
        }),
      ).not.toThrow();
    }
  });

  it('los identificadores de evento no se repiten y el reparto por servicio es completo', () => {
    const ids = worldEventIds(mundo());
    expect(new Set(ids).size).toBe(ids.length);

    const porProductor = ['patients', 'scheduling', 'clinical', 'odontogram', 'billing'].flatMap(
      (producer) => worldEventsFor(mundo(), producer as never),
    );
    expect(porProductor).toHaveLength(events.length);
  });

  it('las cargas de auditoría se pueden auditar y las de paciente validan su esquema', () => {
    for (const event of events) {
      if (event.topic.startsWith('patients.')) {
        expect(() => patientAuditPayloadSchema.parse(event.payload)).not.toThrow();
        continue;
      }
      expect(() => domainAuditPayloadSchema.parse(event.payload)).not.toThrow();
    }
  });

  it('el alta del paciente viaja antes que su solicitud, y la cita antes de sus transiciones', () => {
    const indice = new Map(
      events.map((event, position) => [`${event.topic}:${event.aggregateId}`, position]),
    );
    const primero = (prefijo: string, id: string): number =>
      [...indice.entries()].find(
        ([clave]) => clave.startsWith(prefijo) && clave.endsWith(id),
      )?.[1] ?? -1;

    const world = mundo();
    const paciente = world.patients[0];
    const solicitud = world.requests.find((request) => request.patientId === paciente?.id);
    expect(primero('patients.patient.created', paciente?.id ?? '')).toBeLessThan(
      primero('scheduling.request.created', solicitud?.id ?? ''),
    );

    const cita = world.appointments.find((appointment) => appointment.status === 'atendido');
    expect(primero('scheduling.appointment.scheduled', cita?.id ?? '')).toBeLessThan(
      primero('scheduling.appointment.attended', cita?.id ?? ''),
    );
  });

  it('el número del récipe viaja formateado, como lo publica el servicio', () => {
    const receta = events.find((event) => event.topic === 'clinical.prescription.issued');
    const bloque = receta?.payload['prescription'] as { number?: unknown } | undefined;

    // El consumidor de reportes espera `RX-000123` (texto), no el entero: con el
    // número crudo el evento se descarta como carga inválida y el reporte de
    // recetas queda en cero. Pasó en la primera corrida real del seed.
    expect(typeof bloque?.number).toBe('string');
    expect(String(bloque?.number)).toMatch(/^RX-\d{6}$/);
  });

  it('el cierre de la sesión lleva las partidas con pieza y caras (B14 de la Fase 11)', () => {
    const world = mundo();
    const cierres = events.filter((event) => event.topic === 'clinical.session.closed');
    expect(cierres.length).toBe(world.sessions.length);

    for (const cierre of cierres) {
      const sesion = world.sessions.find((item) => item.id === cierre.aggregateId);
      const bloque = cierre.payload['session'] as
        { procedureCodes?: unknown; procedures?: unknown } | undefined;

      // Aditivo: lo que ya viajaba sigue igual…
      expect(bloque?.procedureCodes).toEqual(sesion?.procedureCodes);
      // …y ahora la partida completa, que es lo que el borrador de factura necesita.
      expect(bloque?.procedures).toEqual(
        sesion?.content.procedimientos.map((procedimiento) => ({
          code: procedimiento.code,
          detail: procedimiento.detalle,
          toothNumber: procedimiento.toothNumber,
          surfaces: procedimiento.surfaces,
        })),
      );
    }
  });

  it('cada hallazgo y cada visita tienen su evento', () => {
    const world = mundo();
    const eventos = buildTestWorldEvents(world);

    for (const finding of world.findings) {
      expect(eventos.some((event) => event.aggregateId === finding.odontogramId)).toBe(true);
    }
    for (const session of world.sessions) {
      expect(
        eventos.some(
          (event) => event.topic === 'clinical.session.closed' && event.aggregateId === session.id,
        ),
      ).toBe(true);
    }
  });
});
