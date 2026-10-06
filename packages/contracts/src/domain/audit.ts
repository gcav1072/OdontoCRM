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
  'device_login_failed',
  // Pacientes (llegan por el outbox desde el servicio de pacientes)
  'patient_created',
  'patient_updated',
  'patient_status_changed',
  'patient_deleted',
  // Agenda (llegan por el outbox desde el servicio de agenda)
  'request_created',
  'request_cancelled',
  'appointment_scheduled',
  'appointment_rescheduled',
  'appointment_cancelled',
  'appointment_notified',
  'appointment_checked_in',
  'appointment_called',
  'appointment_in_consultation',
  'appointment_attended',
  'appointment_no_show',
  'appointment_overbook_authorized',
  'day_capacity_changed',
  'slot_template_changed',
  // Historia clínica (llegan por el outbox desde el servicio clínico)
  'medical_record_created',
  'medical_record_updated',
  'medical_record_signed',
  'medical_record_amended',
  'medical_record_printed',
  'medical_record_consent_accepted',
  // Sesiones clínicas y récipes (evolución del paciente, Fase 7)
  'clinical_session_created',
  'clinical_session_closed',
  'clinical_session_amended',
  'clinical_session_file_uploaded',
  'clinical_session_file_removed',
  'prescription_issued',
  'prescription_reprinted',
  'prescription_annulled',
  // Odontograma (llegan por el outbox desde el servicio de odontograma)
  'tooth_finding_recorded',
  'tooth_finding_updated',
  'tooth_finding_removed',
  'tooth_finding_superseded',
  'odontogram_printed',
  // Facturación y pagos (Fase 11; llegan por el outbox desde el servicio de facturación)
  'invoice_issued',
  'invoice_voided',
  'credit_note_issued',
  'payment_received',
  'payment_voided',
  'exchange_rate_set',
  'catalog_item_changed',
  'billing_settings_changed',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const auditEventSchema = z.object({
  occurredAt: z.string(),
  actorId: z.uuid().nullable(),
  actorUsername: z.string().nullable(),
  action: z.string(),
  entityType: z.string(),
  entityId: z.string().nullable(),
  /** Línea legible del hecho («Cita para María Pérez el 06/10/2026 a las 8:30»). */
  summary: z.string().nullable(),
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

/**
 * Carga de auditoría genérica: la que publica cualquier servicio por el outbox
 * para que identity la registre. El servicio de pacientes usa una variante
 * propia (con `action: created|updated|deleted`) y los servicios nuevos —agenda,
 * clínica, odontograma— publican directamente esta forma, que trae ya la acción
 * de auditoría resuelta.
 */
export const domainAuditPayloadSchema = z.object({
  entityType: z.string().min(1).max(40),
  entityId: z.uuid(),
  action: z.enum(AUDIT_ACTIONS),
  /** Texto corto con el hecho, para la lista de auditoría. */
  summary: z.string().min(1).max(300),
  changedFields: z.array(z.string()).max(60),
  before: z.record(z.string(), z.unknown()).nullable(),
  after: z.record(z.string(), z.unknown()).nullable(),
  reason: z.string().max(300).nullable(),
  actorId: z.uuid().nullable(),
  actorUsername: z.string().nullable(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  requestId: z.string().nullable(),
});

export type DomainAuditPayload = z.infer<typeof domainAuditPayloadSchema>;

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

/* ── Lectura de la auditoría (Fase 9) ──────────────────────────────────────── */

/**
 * Rango de la consulta cuando llegan **fechas sueltas** (`aaaa-mm-dd`).
 *
 * `new Date('2026-10-01')` es medianoche **UTC**, que en Venezuela (UTC−4, sin
 * horario de verano) son las 20:00 del día anterior: una búsqueda «del 1 de
 * octubre» dejaría fuera la mañana del 1 y traería la noche del 30. Aquí el día
 * se interpreta en la zona de la clínica, que es lo que espera quien lo escribe.
 */
export const CARACAS_OFFSET = '-04:00';

export const auditInstantRange = (
  from: string | undefined,
  to: string | undefined,
): { fromIso: string | undefined; toIso: string | undefined } => {
  const dayOnly = /^\d{4}-\d{2}-\d{2}$/;
  const resolve = (value: string | undefined, endOfDay: boolean): string | undefined => {
    if (value === undefined || value === '') return undefined;
    if (!dayOnly.test(value)) return value;
    return endOfDay
      ? `${value}T23:59:59.999${CARACAS_OFFSET}`
      : `${value}T00:00:00.000${CARACAS_OFFSET}`;
  };
  return { fromIso: resolve(from, false), toIso: resolve(to, true) };
};

/** Una fila del diff: el campo y sus dos valores, ya legibles. */
export interface AuditDiffRow {
  field: string;
  before: string;
  after: string;
}

/** Texto legible de un valor del diff (los `null` se pintan como «—»). */
export const formatAuditValue = (value: unknown): string => {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'sí' : 'no';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
};

/**
 * Filas del **diff antes/después** de un evento de auditoría.
 *
 * Los campos se toman de `changedFields` y, si no viniera, de la unión de las
 * claves de `before` y `after` (los eventos antiguos no siempre lo traían). El
 * orden es el de `changedFields`, que es el orden en que el servicio detectó los
 * cambios: leer «teléfono: antes → después» es el requisito de la fase.
 */
export const auditDiffRows = (event: {
  changedFields: readonly string[];
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}): AuditDiffRow[] => {
  const before = event.before ?? {};
  const after = event.after ?? {};
  const fields =
    event.changedFields.length > 0
      ? [...event.changedFields]
      : [...new Set([...Object.keys(before), ...Object.keys(after)])];
  return fields.map((field) => ({
    field,
    before: formatAuditValue(before[field]),
    after: formatAuditValue(after[field]),
  }));
};

/** Columnas de la exportación CSV de la auditoría (mismas que la tabla). */
export const AUDIT_EXPORT_COLUMNS = [
  { key: 'occurredAt', label: 'Fecha y hora' },
  { key: 'actorUsername', label: 'Usuario' },
  { key: 'action', label: 'Acción' },
  { key: 'entityType', label: 'Entidad' },
  { key: 'entityId', label: 'Identificador' },
  { key: 'summary', label: 'Qué pasó' },
  { key: 'changedFields', label: 'Campos cambiados' },
  { key: 'before', label: 'Antes' },
  { key: 'after', label: 'Después' },
  { key: 'reason', label: 'Motivo' },
  { key: 'ip', label: 'IP' },
  { key: 'requestId', label: 'Petición' },
] as const;

/** Convierte un evento de auditoría en la fila del CSV, con el diff en texto. */
export const auditEventToRow = (event: AuditEventRecord): Record<string, string> => {
  const diff = auditDiffRows(event);
  const joinDiff = (side: 'before' | 'after'): string =>
    diff.map((row) => `${row.field}: ${row[side]}`).join(' | ');
  return {
    occurredAt: event.occurredAt,
    actorUsername: event.actorUsername ?? '—',
    action: event.action,
    entityType: event.entityType,
    entityId: event.entityId ?? '—',
    summary: event.summary ?? '—',
    changedFields: event.changedFields.join(', '),
    before: joinDiff('before'),
    after: joinDiff('after'),
    reason: event.reason ?? '—',
    ip: event.ip ?? '—',
    requestId: event.requestId ?? '—',
  };
};
