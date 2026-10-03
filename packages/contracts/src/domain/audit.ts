import { z } from 'zod';

/**
 * Acciones que quedan registradas en la auditoría. La lista crece por fase; el
 * valor se guarda como texto para no romper registros antiguos si algún día se
 * renombra una constante.
 */
export const AUDIT_ACTIONS = [
  // Acceso y sesión
  'login',
  'login_failed',
  'login_blocked',
  'logout',
  'refresh',
  'refresh_reuse_detected',
  'session_revoked',
  // Usuarios y contraseñas
  'user_created',
  'user_updated',
  'user_activated',
  'user_deactivated',
  'password_changed',
  'password_reset',
  // Pantallas kiosko
  'device_token_created',
  'device_token_revoked',
  // Pacientes (llegan por el outbox desde el servicio de pacientes)
  'patient_created',
  'patient_updated',
  'patient_status_changed',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const auditEventSchema = z.object({
  occurredAt: z.string(),
  actorId: z.uuid().nullable(),
  actorUsername: z.string().nullable(),
  action: z.string(),
  entityType: z.string(),
  entityId: z.string().nullable(),
  /** Estado anterior de los campos sensibles que cambiaron. */
  before: z.record(z.string(), z.unknown()).nullable(),
  after: z.record(z.string(), z.unknown()).nullable(),
  changedFields: z.array(z.string()),
  reason: z.string().nullable(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  requestId: z.string().nullable(),
});

export type AuditEvent = z.infer<typeof auditEventSchema>;

export const auditEventRecordSchema = auditEventSchema.extend({ id: z.uuid() });
export type AuditEventRecord = z.infer<typeof auditEventRecordSchema>;

/** Consulta del módulo de auditoría: por fecha, usuario, entidad, acción y campo. */
export const auditQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  actorId: z.uuid().optional(),
  actorUsername: z.string().optional(),
  action: z.string().optional(),
  entityType: z.string().optional(),
  entityId: z.string().optional(),
  field: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

export type AuditQuery = z.infer<typeof auditQuerySchema>;

export interface SensitiveDiff {
  changedFields: string[];
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

/**
 * Calcula qué campos sensibles cambiaron entre dos estados. Se usa en cada
 * servicio antes de escribir en la auditoría: si no hay cambios, no hay registro.
 */
export const diffSensitiveFields = <T extends Record<string, unknown>>(
  before: T,
  after: T,
  fields: readonly (keyof T & string)[],
): SensitiveDiff => {
  const changedFields: string[] = [];
  const beforeSubset: Record<string, unknown> = {};
  const afterSubset: Record<string, unknown> = {};

  for (const field of fields) {
    const previous = before[field];
    const next = after[field];
    if (previous === next) continue;
    changedFields.push(field);
    beforeSubset[field] = previous ?? null;
    afterSubset[field] = next ?? null;
  }

  return {
    changedFields,
    before: changedFields.length > 0 ? beforeSubset : null,
    after: changedFields.length > 0 ? afterSubset : null,
  };
};
