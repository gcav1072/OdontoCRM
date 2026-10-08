import { describe, expect, it } from 'vitest';

import type { AppointmentSummary, DayView } from '@odontocrm/contracts';

import {
  accionDeTecla,
  ATAJOS_FLUJO,
  atajoDeAccion,
  ayudaDeAtajo,
  citaEnCurso,
  citasDeLaCola,
  citasDelDia,
  hayDialogoAbierto,
  resolverSeleccion,
} from './flujo';

/**
 * Pruebas de la parte pura de `/flujo` (Fase 8): qué cita abre la pantalla, cómo se
 * ordena y filtra la cola del día y qué hace cada tecla de función.
 *
 * El día de prueba es el **4 de octubre de 2026** en el consultorio (Caracas, UTC−4),
 * así que las 09:00 de la cita son las 13:00 UTC: el «ahora» de las pruebas se fija
 * en UTC para no depender de la zona del equipo que las corra.
 */

const DIA = '2026-10-04';
/** Instante UTC correspondiente a una hora del consultorio. */
const enCaracas = (hora: string): Date => new Date(`${DIA}T${hora}:00-04:00`);

const cita = (cambios: Partial<AppointmentSummary> = {}): AppointmentSummary => ({
  id: 'cita-1',
  requestId: null,
  ticket: '#000001',
  ticketNumber: 1,
  patientId: 'pac-1',
  patientName: 'Juana Pérez',
  patientDocument: 'V-12345678',
  patientPhone: '+584121234567',
  date: DIA,
  startTime: '09:00',
  endTime: '09:30',
  durationMinutes: 30,
  slotKind: 'franja',
  status: 'programada',
  callCount: 0,
  confirmedAt: null,
  confirmedChannel: null,
  dentistId: null,
  chairId: null,
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
  createdAt: `${DIA}T08:00:00.000Z`,
  updatedAt: `${DIA}T08:00:00.000Z`,
  ...cambios,
});

const jornada = (appointments: AppointmentSummary[]): DayView =>
  ({ date: DIA, appointments }) as unknown as DayView;

describe('citasDeLaCola', () => {
  it('ordena por hora y deja las citas sin hora al final', () => {
    const tarde = cita({ id: 'c', startTime: '15:00' });
    const manana = cita({ id: 'a', startTime: '08:00' });
    const mediodia = cita({ id: 'b', startTime: '11:30' });

    const cola = citasDeLaCola(jornada([tarde, manana, mediodia]), '');

    expect(cola.map((fila) => fila.id)).toEqual(['a', 'b', 'c']);
  });

  it('filtra por nombre, documento, teléfono y ticket, sin acentos ni separadores', () => {
    const filas = [
      cita({ id: 'juana', patientName: 'Juana Pérez', patientDocument: 'V-12345678' }),
      cita({
        id: 'otro',
        patientName: 'Carlos Rojas',
        patientDocument: 'V-87654321',
        ticket: '#000222',
        patientPhone: '+584140000000',
      }),
    ];
    const dia = jornada(filas);

    expect(citasDeLaCola(dia, 'perez').map((f) => f.id)).toEqual(['juana']);
    expect(citasDeLaCola(dia, '12345678').map((f) => f.id)).toEqual(['juana']);
    expect(citasDeLaCola(dia, '000222').map((f) => f.id)).toEqual(['otro']);
    expect(citasDeLaCola(dia, '4140000000').map((f) => f.id)).toEqual(['otro']);
    expect(citasDeLaCola(dia, 'nadie')).toEqual([]);
  });

  it('sin jornada cargada devuelve una cola vacía', () => {
    expect(citasDeLaCola(undefined, '')).toEqual([]);
  });
});

/**
 * El filtro es de la **lista**, no de la jornada: si buscar a otro paciente dejara
 * la pantalla sin cita en curso, desaparecerían con ella las acciones de la barra
 * («Registrar llegada», «Llamar», «Cerrar la sesión»). Lo destapó la aceptación de
 * la Fase 10 con una jornada sembrada de verdad.
 */
describe('la cita en curso sobrevive al buscador', () => {
  const enConsulta = cita({ id: 'en-consulta', startTime: '09:00', status: 'en_consulta' });
  const dePrueba = cita({
    id: 'de-prueba',
    startTime: '11:00',
    patientName: 'Paciente de prueba',
    patientDocument: 'V-90140571',
  });
  const dia = jornada([enConsulta, dePrueba]);
  const ahora = enCaracas('18:00');

  it('la jornada completa se ordena sin filtrar', () => {
    expect(citasDelDia(dia).map((fila) => fila.id)).toEqual(['en-consulta', 'de-prueba']);
  });

  it('filtrar por el documento de otra cita deja la cita en curso a la vista', () => {
    // Lo que hace `/flujo`: la lista se filtra, pero la selección se resuelve sobre
    // la jornada completa.
    const visibles = citasDeLaCola(dia, '90140571');
    expect(visibles.map((fila) => fila.id)).toEqual(['de-prueba']);
    expect(resolverSeleccion(citasDelDia(dia), null, ahora)?.id).toBe('en-consulta');
  });
});

describe('citaEnCurso', () => {
  it('prefiere la que está en consulta, después la llamada y después la de la sala', () => {
    const enSala = cita({ id: 'sala', status: 'en_sala_espera' });
    const llamada = cita({ id: 'llamada', status: 'llamado' });
    const consulta = cita({ id: 'consulta', status: 'en_consulta' });

    expect(citaEnCurso([enSala, llamada, consulta], enCaracas('09:05'))?.id).toBe('consulta');
    expect(citaEnCurso([enSala, llamada], enCaracas('09:05'))?.id).toBe('llamada');
    expect(citaEnCurso([enSala], enCaracas('09:05'))?.id).toBe('sala');
  });

  it('sin nadie en el consultorio toma la próxima cita que todavía no empieza', () => {
    const pasada = cita({ id: 'pasada', startTime: '08:00', endTime: '08:30' });
    const siguiente = cita({ id: 'siguiente', startTime: '09:30', endTime: '10:00' });

    expect(citaEnCurso([pasada, siguiente], enCaracas('09:00'))?.id).toBe('siguiente');
  });

  it('ignora las citas cerradas y las canceladas', () => {
    const atendida = cita({ id: 'atendida', status: 'atendido', startTime: '09:00' });
    const cancelada = cita({ id: 'cancelada', status: 'cancelada', startTime: '09:30' });
    const noAsistio = cita({ id: 'no-asistio', status: 'no_asistio', startTime: '10:00' });

    expect(citaEnCurso([atendida, cancelada, noAsistio], enCaracas('08:00'))).toBeNull();
  });

  it('con el día terminado no hay cita en curso', () => {
    const manana = cita({ id: 'manana', startTime: '09:00', endTime: '09:30' });
    expect(citaEnCurso([manana], enCaracas('18:00'))).toBeNull();
  });
});

describe('resolverSeleccion', () => {
  const filas = [
    cita({ id: 'a', startTime: '09:00', status: 'en_consulta' }),
    cita({ id: 'b', startTime: '10:00' }),
  ];

  it('respeta la cita elegida mientras siga en la jornada', () => {
    expect(resolverSeleccion(filas, 'b', enCaracas('09:05'))?.id).toBe('b');
  });

  it('si la cita elegida desapareció vuelve a la cita en curso', () => {
    // La reprogramaron a otro día: la pantalla no se queda en blanco.
    expect(resolverSeleccion(filas, 'inexistente', enCaracas('09:05'))?.id).toBe('a');
  });

  it('sin elección abre la cita en curso', () => {
    expect(resolverSeleccion(filas, null, enCaracas('09:05'))?.id).toBe('a');
  });
});

describe('atajos de teclado', () => {
  it('son F2 buscar, F4 llamar y F8 cerrar la sesión clínica', () => {
    expect(ATAJOS_FLUJO.map((atajo) => [atajo.tecla, atajo.accion])).toEqual([
      ['F2', 'buscar'],
      ['F4', 'llamar'],
      ['F8', 'cerrar-sesion'],
    ]);
  });

  it('traduce la tecla pulsada a la acción del flujo', () => {
    expect(accionDeTecla({ key: 'F2' })).toBe('buscar');
    expect(accionDeTecla({ key: 'F4' })).toBe('llamar');
    expect(accionDeTecla({ key: 'F8' })).toBe('cerrar-sesion');
    expect(accionDeTecla({ key: 'F5' })).toBeNull();
    expect(accionDeTecla({ key: 'f4' })).toBeNull();
  });

  it('con modificadores no son atajos del flujo (son del navegador y del sistema)', () => {
    expect(accionDeTecla({ key: 'F4', ctrlKey: true })).toBeNull();
    expect(accionDeTecla({ key: 'F4', altKey: true })).toBeNull();
    expect(accionDeTecla({ key: 'F4', metaKey: true })).toBeNull();
  });

  it('la etiqueta del atajo nombra la tecla y lo que hace', () => {
    expect(atajoDeAccion('cerrar-sesion').tecla).toBe('F8');
    expect(ayudaDeAtajo('llamar')).toContain('F4');
    expect(ayudaDeAtajo('llamar')).toContain('Llamar');
  });

  it('con un diálogo abierto los atajos quedan bloqueados', () => {
    expect(hayDialogoAbierto({ querySelector: () => ({}) })).toBe(true);
    expect(hayDialogoAbierto({ querySelector: () => null })).toBe(false);
    // Sin documento (pruebas y render en servidor) no hay nada que bloquear.
    expect(hayDialogoAbierto(undefined)).toBe(false);
  });
});
