import type { AppointmentStatus, Role } from './enums.js';

/**
 * Máquina de estados de la cita aprobada por el usuario el 2026-10-02
 * (docs/PLAN_MAESTRO_FASES.md §5.1). Se expone como dato para que la interfaz,
 * la API y las pruebas usen exactamente las mismas reglas.
 */
export interface AppointmentTransition {
  from: AppointmentStatus;
  to: AppointmentStatus;
  /** Roles autorizados además de `admin`, que puede ejecutar todo. */
  roles: readonly Role[];
  /** Etiqueta que ve el usuario en el módulo de secretaría. */
  label: string;
  /** `true` si requiere un motivo escrito (queda en auditoría). */
  requiresReason?: boolean;
}

export const APPOINTMENT_TRANSITIONS: readonly AppointmentTransition[] = [
  {
    from: 'en_espera_cita',
    to: 'programada',
    roles: ['secretario'],
    label: 'Asignar fecha y hora',
  },
  { from: 'programada', to: 'notificada', roles: ['secretario'], label: 'Notificar al paciente' },
  {
    from: 'programada',
    to: 'en_sala_espera',
    roles: ['secretario', 'odontologo'],
    label: 'Registrar llegada',
  },
  {
    from: 'notificada',
    to: 'en_sala_espera',
    roles: ['secretario', 'odontologo'],
    label: 'Registrar llegada',
  },
  {
    from: 'en_sala_espera',
    to: 'llamado',
    roles: ['secretario', 'odontologo'],
    label: 'Llamar al paciente',
  },
  {
    from: 'llamado',
    to: 'llamado',
    roles: ['secretario', 'odontologo'],
    label: 'Segundo llamado',
  },
  {
    from: 'llamado',
    to: 'en_consulta',
    roles: ['secretario', 'odontologo'],
    label: 'Pasar a consulta',
  },
  {
    from: 'en_consulta',
    to: 'atendido',
    roles: ['secretario', 'odontologo'],
    label: 'Marcar atendido',
    requiresReason: true,
  },
  { from: 'programada', to: 'no_asistio', roles: ['secretario'], label: 'Marcar inasistencia' },
  { from: 'notificada', to: 'no_asistio', roles: ['secretario'], label: 'Marcar inasistencia' },
  { from: 'en_sala_espera', to: 'no_asistio', roles: ['secretario'], label: 'Marcar inasistencia' },
  { from: 'llamado', to: 'no_asistio', roles: ['secretario'], label: 'Marcar inasistencia' },
  { from: 'en_espera_cita', to: 'cancelada', roles: ['secretario'], label: 'Cancelar solicitud' },
  { from: 'programada', to: 'cancelada', roles: ['secretario'], label: 'Cancelar cita' },
  { from: 'notificada', to: 'cancelada', roles: ['secretario'], label: 'Cancelar cita' },
  { from: 'programada', to: 'reprogramada', roles: ['secretario'], label: 'Reprogramar' },
  { from: 'notificada', to: 'reprogramada', roles: ['secretario'], label: 'Reprogramar' },
] as const;

const TERMINAL_STATUSES: readonly AppointmentStatus[] = [
  'atendido',
  'no_asistio',
  'cancelada',
  'reprogramada',
];

export const isTerminalStatus = (status: AppointmentStatus): boolean =>
  TERMINAL_STATUSES.includes(status);

export const allowedTransitions = (
  from: AppointmentStatus,
  role: Role,
): readonly AppointmentTransition[] =>
  APPOINTMENT_TRANSITIONS.filter(
    (transition) =>
      transition.from === from && (role === 'admin' || transition.roles.includes(role)),
  );

export const canTransition = (
  from: AppointmentStatus,
  to: AppointmentStatus,
  role: Role,
): boolean => allowedTransitions(from, role).some((transition) => transition.to === to);

/**
 * Duración mínima que debe existir entre el cambio de estado y el momento
 * actual para poder marcar una inasistencia (minutos de tolerancia).
 */
export const NO_SHOW_GRACE_MINUTES = 15;
