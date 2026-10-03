import type { AuditAction, AuditEventRecord, AuditQuery } from '@odontocrm/contracts';
import { and, count, desc, eq, gte, lte, sql, type SQL } from 'drizzle-orm';

import type { IdentityDb } from '../db/client.js';
import { auditEvents } from '../db/schema.js';

export interface WriteAuditInput {
  /** Debe existir en `AUDIT_ACTIONS` (contratos): la lista crece por fase. */
  action: AuditAction;
  entityType: string;
  entityId?: string | null;
  actorId?: string | null;
  actorUsername?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  changedFields?: string[];
  reason?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

/**
 * Escribe una fila de auditoría. Nunca lanza hacia arriba: un fallo al auditar
 * no puede tumbar la operación que el usuario acaba de hacer, pero queda en el
 * log de errores para que no pase desapercibido.
 */
export const writeAuditEvent = async (
  db: IdentityDb,
  input: WriteAuditInput,
  onError?: (error: unknown) => void,
): Promise<void> => {
  try {
    await db.insert(auditEvents).values({
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      actorId: input.actorId ?? null,
      actorUsername: input.actorUsername ?? null,
      before: input.before ?? null,
      after: input.after ?? null,
      changedFields: input.changedFields ?? [],
      reason: input.reason ?? null,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      requestId: input.requestId ?? null,
    });
  } catch (error) {
    onError?.(error);
  }
};

export interface AuditPage {
  items: AuditEventRecord[];
  total: number;
}

/** Consulta paginada del módulo de auditoría (fecha, usuario, acción, entidad y campo). */
export const queryAuditEvents = async (
  db: IdentityDb,
  query: AuditQuery,
): Promise<AuditPage> => {
  const conditions: SQL[] = [];

  if (query.from !== undefined && query.from !== '') {
    conditions.push(gte(auditEvents.occurredAt, new Date(query.from)));
  }
  if (query.to !== undefined && query.to !== '') {
    conditions.push(lte(auditEvents.occurredAt, new Date(query.to)));
  }
  if (query.actorId !== undefined) conditions.push(eq(auditEvents.actorId, query.actorId));
  if (query.actorUsername !== undefined && query.actorUsername !== '') {
    conditions.push(sql`${auditEvents.actorUsername} ilike ${`%${query.actorUsername}%`}`);
  }
  if (query.action !== undefined && query.action !== '') {
    conditions.push(eq(auditEvents.action, query.action));
  }
  if (query.entityType !== undefined && query.entityType !== '') {
    conditions.push(eq(auditEvents.entityType, query.entityType));
  }
  if (query.entityId !== undefined && query.entityId !== '') {
    conditions.push(eq(auditEvents.entityId, query.entityId));
  }
  if (query.field !== undefined && query.field !== '') {
    conditions.push(sql`${query.field} = any(${auditEvents.changedFields})`);
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const offset = (query.page - 1) * query.pageSize;

  const [rows, totals] = await Promise.all([
    db
      .select()
      .from(auditEvents)
      .where(where)
      .orderBy(desc(auditEvents.occurredAt))
      .limit(query.pageSize)
      .offset(offset),
    db.select({ value: count() }).from(auditEvents).where(where),
  ]);

  return {
    items: rows.map((row) => ({
      id: row.id,
      occurredAt: row.occurredAt.toISOString(),
      actorId: row.actorId,
      actorUsername: row.actorUsername,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      before: row.before ?? null,
      after: row.after ?? null,
      changedFields: row.changedFields,
      reason: row.reason,
      ip: row.ip,
      userAgent: row.userAgent,
      requestId: row.requestId,
    })),
    total: totals[0]?.value ?? 0,
  };
};
