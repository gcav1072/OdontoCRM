import type { AppointmentStatus, Role } from './enums.js';

/**
 * Máquina de estados de la cita aprobada por el usuario el 2026-10-02
 * (docs/PLAN_MAESTRO_FASES.md §5.1). Se expone como dato para que la interfaz,
 * la API y las pruebas usen exactamente las mismas reglas.
 *
 * El odontólogo entra en las transiciones del **flujo del día** (llegada, llamado,
 * paso a consulta, atendido e inasistencia) porque en la Fase 8 es él quien lleva
 * la jornada desde `/flujo` cuando trabaja solo; notificar, cancelar, reprogramar
 * y el sobrecupo siguen siendo de la secretaría y del `admin`
 * ([ADR 0038](../../../docs/adr/0038-permisos-del-odontologo-en-el-flujo.md)).
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
  /**
   * Confirmar en dos pasos (ADR 0052): la secretaría puede dejarlo constancia tanto
   * si la cita venía de un aviso (`notificada`) como si la llamó ella por teléfono
   * sin aviso previo (`programada`), que es el caso «la llamé yo».
   */
  {
    from: 'programada',
    to: 'confirmada',
    roles: ['secretario'],
    label: 'Confirmar la cita',
  },
  {
    from: 'notificada',
    to: 'confirmada',
    roles: ['secretario'],
    label: 'Registrar la confirmación',
  },
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
  /**
   * Confirmar **no** es requisito para llegar: el paciente aparece sin haber
   * respondido y la recepción lo registra igual. Por eso `notificada` conserva su
   * salida y `confirmada` gana la suya.
   */
  {
    from: 'confirmada',
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
  {
    from: 'programada',
    to: 'no_asistio',
    roles: ['secretario', 'odontologo'],
    label: 'Marcar inasistencia',
  },
  {
    from: 'notificada',
    to: 'no_asistio',
    roles: ['secretario', 'odontologo'],
    label: 'Marcar inasistencia',
  },
  {
    from: 'confirmada',
    to: 'no_asistio',
    roles: ['secretario', 'odontologo'],
    label: 'Marcar inasistencia',
  },
  {
    from: 'en_sala_espera',
    to: 'no_asistio',
    roles: ['secretario', 'odontologo'],
    label: 'Marcar inasistencia',
  },
  {
    from: 'llamado',
    to: 'no_asistio',
    roles: ['secretario', 'odontologo'],
    label: 'Marcar inasistencia',
  },
  { from: 'en_espera_cita', to: 'cancelada', roles: ['secretario'], label: 'Cancelar solicitud' },
  { from: 'programada', to: 'cancelada', roles: ['secretario'], label: 'Cancelar cita' },
  { from: 'notificada', to: 'cancelada', roles: ['secretario'], label: 'Cancelar cita' },
  { from: 'confirmada', to: 'cancelada', roles: ['secretario'], label: 'Cancelar cita' },
  { from: 'programada', to: 'reprogramada', roles: ['secretario'], label: 'Reprogramar' },
  { from: 'notificada', to: 'reprogramada', roles: ['secretario'], label: 'Reprogramar' },
  { from: 'confirmada', to: 'reprogramada', roles: ['secretario'], label: 'Reprogramar' },
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
