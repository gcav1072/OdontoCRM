import { ICS_FORMAT_VERSION, buildIcsEvent, type AppointmentSummary } from '@odontocrm/contracts';
import { describe, expect, it } from 'vitest';

import type { NotificationsDb } from './db/client.js';
import { ClinicNotConfiguredError, ensureIcsArtifact } from './messaging.js';

/**
 * El artefacto del `.ics` se guarda por cita y secuencia y se **reutiliza** al reenviar.
 * Eso está bien —es reproducible y auditable—, pero deja un problema real: un arreglo del
 * **formato** no llegaría a las citas que ya tienen su archivo y el calendario seguiría
 * «sin abrir» en cada reenvío. De ahí la marca de versión en el `PRODID`.
 */
const unaCita = (overrides: Partial<AppointmentSummary> = {}): AppointmentSummary => ({
  id: '11111111-1111-4111-8111-111111111111',
  requestId: null,
  ticket: '#000123',
  ticketNumber: 123,
  patientId: '22222222-2222-4222-8222-222222222222',
  patientName: 'María Pérez',
  patientDocument: 'V-12345678',
  patientPhone: '+584121234567',
  date: '2026-12-01',
  startTime: '09:00',
  endTime: '09:30',
  durationMinutes: 30,
  slotKind: 'franja',
  status: 'notificada',
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
  createdAt: '2026-11-01T10:00:00.000Z',
  updatedAt: '2026-11-01T10:00:00.000Z',
  ...overrides,
});

const CONSULTORIO = {
  CLINIC_NAME: 'Clínica Odontológica Sonrisa, C.A.',
  CLINIC_ADDRESS: 'Av. Bolívar, C.C. Plaza, Local 3',
  CLINIC_EMAIL: 'citas@sonrisa.local',
} as never;

interface FilaGuardada {
  filename: string;
  content: string;
  sha256: string;
  sequence: number;
}

/** Base de mentira que solo responde a lo que usa `ensureIcsArtifact`. */
const fakeDb = (existente: FilaGuardada | null) => {
  const escrituras: { tipo: 'insert' | 'update'; valores: Record<string, unknown> }[] = [];
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => (existente === null ? [] : [existente]) }),
      }),
    }),
    insert: () => ({
      values: (valores: Record<string, unknown>) => ({
        onConflictDoNothing: async () => {
          escrituras.push({ tipo: 'insert', valores });
        },
      }),
    }),
    update: () => ({
      set: (valores: Record<string, unknown>) => ({
        where: async () => {
          escrituras.push({ tipo: 'update', valores });
        },
      }),
    }),
  };
  return { db: db as unknown as NotificationsDb, escrituras };
};

const cita = unaCita();

describe('.ics guardado: cuándo se reutiliza y cuándo se rehace', () => {
  it('sin artefacto, lo compone y lo inserta con el formato actual', async () => {
    const { db, escrituras } = fakeDb(null);
    const generado = await ensureIcsArtifact(db, CONSULTORIO, cita);

    expect(generado.content).toContain(
      `PRODID:-//OdontoCRM//Agenda ${String(ICS_FORMAT_VERSION)}//ES`,
    );
    expect(generado.filename).toBe('cita-000123.ics');
    expect(escrituras).toHaveLength(1);
    expect(escrituras[0]?.tipo).toBe('insert');
    expect(escrituras[0]?.valores['content']).toBe(generado.content);
  });

  it('con el formato al día, reutiliza el artefacto y no toca la base', async () => {
    const contenido = buildIcsEvent({
      uid: cita.id,
      sequence: 0,
      start: new Date('2026-12-01T09:00:00-04:00'),
      end: new Date('2026-12-01T09:30:00-04:00'),
      summary: 'Cita',
      description: 'd',
      location: 'l',
      organizerName: 'Clínica',
      organizerEmail: 'citas@sonrisa.local',
      attendeeName: 'María Pérez',
    });
    const { db, escrituras } = fakeDb({
      filename: 'cita-000123.ics',
      content: contenido,
      sha256: 'huella',
      sequence: 0,
    });

    const resultado = await ensureIcsArtifact(db, CONSULTORIO, cita);
    expect(resultado.content).toBe(contenido);
    expect(resultado.sha256).toBe('huella');
    expect(escrituras).toHaveLength(0);
  });

  it('con un formato viejo, rehace el artefacto y actualiza la misma fila', async () => {
    // Un `.ics` anterior a la marca de versión: es lo que queda guardado en las
    // instalaciones que ya venían enviando avisos.
    const viejo = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//OdontoCRM//Agenda//ES',
      'BEGIN:VEVENT',
      'UID:x@odontocrm.local',
      `ORGANIZER;CN=Clínica Sonrisa\\, C.A.:mailto:citas@sonrisa.local`,
      'END:VEVENT',
      'END:VCALENDAR',
      '',
    ].join('\r\n');
    const { db, escrituras } = fakeDb({
      filename: 'cita-000123.ics',
      content: viejo,
      sha256: 'huella vieja',
      sequence: 0,
    });

    const resultado = await ensureIcsArtifact(db, CONSULTORIO, cita);

    expect(resultado.content).not.toBe(viejo);
    expect(resultado.content).toContain('PRODID:-//OdontoCRM//Agenda 2//ES');
    expect(resultado.content).toContain('ORGANIZER;CN="Clínica Odontológica Sonrisa, C.A."');
    // Se actualiza la **misma** fila: el evento no cambió de secuencia.
    expect(escrituras).toHaveLength(1);
    expect(escrituras[0]?.tipo).toBe('update');
    expect(escrituras[0]?.valores['content']).toBe(resultado.content);
    expect(escrituras[0]?.valores['sha256']).not.toBe('huella vieja');
  });

  it('sin consultorio configurado no compone nada (y no escribe)', async () => {
    const { db, escrituras } = fakeDb(null);
    await expect(ensureIcsArtifact(db, {} as never, cita)).rejects.toBeInstanceOf(
      ClinicNotConfiguredError,
    );
    expect(escrituras).toHaveLength(0);
  });
});
