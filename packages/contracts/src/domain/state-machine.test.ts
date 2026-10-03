import { describe, expect, it } from 'vitest';

import type { AppointmentStatus } from './enums.js';
import { APPOINTMENT_STATUSES } from './enums.js';
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
});
