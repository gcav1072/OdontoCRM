import { describe, expect, it } from 'vitest';

import type { AppointmentStatus } from './enums.js';
import { APPOINTMENT_STATUSES, REQUEST_STATUSES } from './enums.js';
import {
  allowedTransitions,
  APPOINTMENT_TRANSITIONS,
  canTransition,
  isTerminalStatus,
  NO_SHOW_GRACE_MINUTES,
} from './state-machine.js';

describe('máquina de estados de la cita', () => {
  it('solo usa estados declarados en los contratos', () => {
    for (const transition of APPOINTMENT_TRANSITIONS) {
      expect(APPOINTMENT_STATUSES).toContain(transition.from);
      expect(APPOINTMENT_STATUSES).toContain(transition.to);
    }
  });

  it('solo llega a atendido desde en_consulta', () => {
    const toAttended = APPOINTMENT_TRANSITIONS.filter((t) => t.to === 'atendido');
    expect(toAttended).toHaveLength(1);
    expect(toAttended[0]?.from).toBe('en_consulta');
    expect(toAttended[0]?.requiresReason).toBe(true);
  });

  it('exige pasar por la sala de espera antes de la consulta', () => {
    expect(canTransition('programada', 'en_consulta', 'secretario')).toBe(false);
    expect(canTransition('en_sala_espera', 'en_consulta', 'secretario')).toBe(false);
    expect(canTransition('en_sala_espera', 'llamado', 'secretario')).toBe(true);
    expect(canTransition('llamado', 'en_consulta', 'secretario')).toBe(true);
  });

  it('permite el segundo llamado sin cambiar de estado', () => {
    expect(canTransition('llamado', 'llamado', 'secretario')).toBe(true);
  });

  it('roles: el odontólogo puede llamar y cerrar, la pantalla kiosko no transiciona nada', () => {
    expect(canTransition('en_sala_espera', 'llamado', 'odontologo')).toBe(true);
    expect(canTransition('en_consulta', 'atendido', 'odontologo')).toBe(true);
    expect(allowedTransitions('en_consulta', 'pantalla')).toHaveLength(0);
    expect(canTransition('programada', 'notificada', 'odontologo')).toBe(false);
  });

  it('el odontólogo hace el flujo del día completo, no solo el consultorio (2026-10-04)', () => {
    // Fase 8: las cinco acciones de la barra de `/flujo`.
    expect(canTransition('programada', 'en_sala_espera', 'odontologo')).toBe(true);
    expect(canTransition('en_sala_espera', 'llamado', 'odontologo')).toBe(true);
    expect(canTransition('llamado', 'llamado', 'odontologo')).toBe(true);
    expect(canTransition('llamado', 'en_consulta', 'odontologo')).toBe(true);
    expect(canTransition('en_consulta', 'atendido', 'odontologo')).toBe(true);
    expect(canTransition('programada', 'no_asistio', 'odontologo')).toBe(true);
    expect(canTransition('en_sala_espera', 'no_asistio', 'odontologo')).toBe(true);
    // Lo que sigue siendo de la secretaría.
    expect(canTransition('programada', 'cancelada', 'odontologo')).toBe(false);
    expect(canTransition('programada', 'reprogramada', 'odontologo')).toBe(false);
    expect(canTransition('programada', 'notificada', 'odontologo')).toBe(false);
  });

  it('admin puede ejecutar cualquier transición declarada', () => {
    expect(canTransition('programada', 'notificada', 'admin')).toBe(true);
    expect(canTransition('en_consulta', 'atendido', 'admin')).toBe(true);
  });

  it('los estados finales no tienen salidas', () => {
    const terminals: AppointmentStatus[] = ['atendido', 'no_asistio', 'cancelada', 'reprogramada'];
    for (const status of terminals) {
      expect(isTerminalStatus(status)).toBe(true);
      expect(APPOINTMENT_TRANSITIONS.filter((t) => t.from === status)).toHaveLength(0);
    }
    expect(isTerminalStatus('en_consulta')).toBe(false);
  });

  it('la tolerancia de inasistencia es de 15 minutos', () => {
    expect(NO_SHOW_GRACE_MINUTES).toBe(15);
  });

  it('confirmar es un paso más, sin cerrar el paso a la sala (ADR 0052)', () => {
    // La secretaría confirma tras avisar o tras llamar por teléfono.
    expect(canTransition('notificada', 'confirmada', 'secretario')).toBe(true);
    expect(canTransition('programada', 'confirmada', 'secretario')).toBe(true);
    // Confirmar no es requisito para llegar: la recepción registra la llegada igual.
    expect(canTransition('confirmada', 'en_sala_espera', 'secretario')).toBe(true);
    expect(canTransition('confirmada', 'en_sala_espera', 'odontologo')).toBe(true);
    expect(canTransition('notificada', 'en_sala_espera', 'secretario')).toBe(true);
    // Y desde confirmada se puede cerrar el día como cualquier otra.
    expect(canTransition('confirmada', 'no_asistio', 'secretario')).toBe(true);
    expect(canTransition('confirmada', 'cancelada', 'secretario')).toBe(true);
    expect(canTransition('confirmada', 'reprogramada', 'secretario')).toBe(true);
    // El bot confirma con un actor sin rol, así que no puede inventarse transiciones.
    expect(canTransition('en_espera_cita', 'confirmada', 'secretario')).toBe(false);
    expect(canTransition('confirmada', 'confirmada', 'secretario')).toBe(false);
  });

  it('las solicitudes no usan el estado de una cita confirmada (ADR 0052)', () => {
    // Se declara aparte para que la cola no ofrezca un estado que no le pertenece:
    // una solicitud todavía no tiene fecha, así que no hay nada que confirmar.
    expect(REQUEST_STATUSES).toEqual(
      APPOINTMENT_STATUSES.filter((status) => status !== 'confirmada'),
    );
    expect(REQUEST_STATUSES as readonly string[]).not.toContain('confirmada');
  });
});
