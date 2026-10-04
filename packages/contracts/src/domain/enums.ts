/**
 * Enumeraciones compartidas por todos los servicios. Son la única fuente de
 * verdad: la base de datos, la API y la interfaz usan estos mismos valores.
 * Convención: valores en `snake_case` y en español (son datos visibles para el
 * personal de la clínica); identificadores del código en inglés.
 */

export const ROLES = ['admin', 'secretario', 'odontologo', 'pantalla'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  'users:manage',
  'patients:read',
  'patients:write',
  'patients:edit_sensitive',
  /** Borrado lógico de un paciente: solo `admin`, siempre con motivo (ADR 0027). */
  'patients:delete',
  'scheduling:read',
  'scheduling:write',
  'scheduling:notify',
  /** Autorizar sobrecupo en un día completo: solo `admin` (plan §13, Fase 3). */
  'scheduling:overbook',
  'screens:manage',
  'screens:display',
  'clinical:read',
  'clinical:write',
  'odontogram:read',
  'odontogram:write',
  'reports:read',
  'audit:read',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** Roles efectivos: la pantalla kiosko es un rol técnico de solo lectura. */
export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  admin: PERMISSIONS,
  secretario: [
    'patients:read',
    'patients:write',
    'patients:edit_sensitive',
    'scheduling:read',
    'scheduling:write',
    'scheduling:notify',
    'screens:display',
    'reports:read',
    /**
     * La secretaría **imprime todo** (récipes, consentimientos, historia clínica
     * y odontograma), así que tiene lectura clínica; la escritura sigue siendo del
     * odontólogo y del admin (decisión 23, 2026-10-04).
     */
    'clinical:read',
    'odontogram:read',
  ],
  /**
   * El odontólogo registra y edita pacientes (decisión del 2026-10-03): en un
   * consultorio de una sola odontóloga es ella quien a veces da el alta, y toda
   * edición queda auditada con motivo igual que la de la secretaría. No puede
   * borrar: eso queda reservado al `admin`.
   *
   * **`scheduling:write` (decisión del 2026-10-04, Fase 8):** la odontóloga que
   * trabaja sola lleva el día desde `/flujo` —registra la llegada, llama, pasa a
   * consulta, marca atendida o inasistencia—, así que necesita escribir la agenda.
   * La máquina de estados sigue decidiendo **qué transición** puede hacer cada
   * rol (`state-machine.ts`): notificar, cancelar y reprogramar siguen siendo de
   * la secretaría, y el sobrecupo del `admin` ([ADR 0038](../../../docs/adr/0038-permisos-del-odontologo-en-el-flujo.md)).
   */
  odontologo: [
    'patients:read',
    'patients:write',
    'patients:edit_sensitive',
    'scheduling:read',
    'scheduling:write',
    'screens:display',
    'clinical:read',
    'clinical:write',
    'odontogram:read',
    'odontogram:write',
    'reports:read',
  ],
  pantalla: ['screens:display'],
};

/** Tipos de documento de identidad admitidos (acuerdo del 2026-10-02). */
export const DOC_TYPES = ['V', 'E', 'P', 'SC'] as const;
export type DocType = (typeof DOC_TYPES)[number];

export const SEXES = ['M', 'F', 'O'] as const;
export type Sex = (typeof SEXES)[number];

export const CHANNELS = ['telegram', 'whatsapp', 'registro', 'telefono', 'presencial'] as const;
export type Channel = (typeof CHANNELS)[number];

export const PATIENT_STATUSES = ['en_espera_cita', 'activo', 'inactivo'] as const;
export type PatientStatus = (typeof PATIENT_STATUSES)[number];

export const APPOINTMENT_STATUSES = [
  'en_espera_cita',
  'programada',
  'notificada',
  'en_sala_espera',
  'llamado',
  'en_consulta',
  'atendido',
  'no_asistio',
  'cancelada',
  'reprogramada',
] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

export const MEDICAL_RECORD_STATUSES = ['borrador', 'firmada'] as const;
export type MedicalRecordStatus = (typeof MEDICAL_RECORD_STATUSES)[number];

export const CLINICAL_SESSION_STATUSES = ['borrador', 'cerrada'] as const;
export type ClinicalSessionStatus = (typeof CLINICAL_SESSION_STATUSES)[number];

export const PRESCRIPTION_STATUSES = ['borrador', 'emitida', 'anulada'] as const;
export type PrescriptionStatus = (typeof PRESCRIPTION_STATUSES)[number];

export const NOTIFICATION_STATUSES = [
  'queued',
  'sending',
  'sent',
  'failed',
  'skipped_no_channel',
] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

export const SCREEN_KINDS = ['lobby', 'consultorio'] as const;
export type ScreenKind = (typeof SCREEN_KINDS)[number];
