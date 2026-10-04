import {
  auditEventToRow,
  auditInstantRange,
  type AuditAction,
  type AuditEventRecord,
  type AuditQuery,
} from '@odontocrm/contracts';
import { and, count, desc, eq, gte, lte, sql, type SQL } from 'drizzle-orm';

import type { IdentityDb } from '../db/client.js';
import { auditEvents } from '../db/schema.js';

export interface WriteAuditInput {
  /** Debe existir en `AUDIT_ACTIONS` (contratos): la lista crece por fase. */
  action: AuditAction;
  entityType: string;
  entityId?: string | null;
  /** Línea legible del hecho, para la lista de auditoría. */
  summary?: string | null;
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
      summary: input.summary ?? null,
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

/**
 * Rango efectivo de la consulta, ya convertido a `Date` (lo que compara Drizzle
 * contra `occurred_at`).
 *
 * La conversión la hace `auditInstantRange` (contratos): una fecha suelta
 * (`2026-10-01`, lo que manda un `<input type="date">`) se lee como el **día
 * completo en Venezuela**, no como medianoche UTC — que en Caracas son las 20:00
 * del día anterior y dejaría fuera toda la mañana del 1. Un instante completo
 * (`2026-10-01T10:00:00Z`) pasa tal cual.
 *
 * Una fecha ilegible se descarta en vez de llegar a PostgreSQL: `Invalid Date`
 * revienta en el driver con un error opaco (500) y sin el filtro la pantalla al
 * menos sigue funcionando. Por la interfaz no llega basura (los campos son
 * `type="date"`); esto cubre una URL escrita a mano.
 */
export const auditQueryRange = (
  query: Pick<AuditQuery, 'from' | 'to'>,
): { from: Date | undefined; to: Date | undefined } => {
  const { fromIso, toIso } = auditInstantRange(query.from, query.to);
  const aFecha = (iso: string | undefined): Date | undefined => {
    if (iso === undefined) return undefined;
    const fecha = new Date(iso);
    return Number.isNaN(fecha.getTime()) ? undefined : fecha;
  };
  return { from: aFecha(fromIso), to: aFecha(toIso) };
};

/** Consulta paginada del módulo de auditoría (fecha, usuario, acción, entidad y campo). */
export const queryAuditEvents = async (db: IdentityDb, query: AuditQuery): Promise<AuditPage> => {
  const conditions: SQL[] = [];
  const { from, to } = auditQueryRange(query);

  if (from !== undefined) conditions.push(gte(auditEvents.occurredAt, from));
  if (to !== undefined) conditions.push(lte(auditEvents.occurredAt, to));
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
      summary: row.summary,
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

/* ── Exportación CSV (Fase 9) ──────────────────────────────────────────────── */

/** Filas por página al exportar: el máximo que acepta `auditQuerySchema`. */
export const AUDIT_EXPORT_PAGE_SIZE = 200;

/**
 * Tope de la exportación. Una consulta sin filtros sobre un año de actividad son
 * decenas de miles de filas: 5.000 entran de sobra en Excel y acotan la memoria y
 * el tiempo de respuesta. Si se alcanza, el CSV lo dice en su última fila (ver
 * `audit-routes.ts`), para que nadie dé por completo un archivo recortado.
 */
export const AUDIT_EXPORT_MAX_EVENTS = 5_000;

export interface AuditExportPlan {
  /** Páginas que hay que recorrer contando la primera (la que ya trae el total). */
  pages: number;
  /** Eventos que se van a leer como mucho. */
  events: number;
  /** Verdadero si la consulta tiene más eventos que el tope. */
  truncated: boolean;
}

/**
 * Plan de la exportación a partir del total de la consulta. Es puro a propósito:
 * el tope es la regla que más fácil se rompe al tocar la ruta, y así se prueba
 * sin base de datos.
 */
export const auditExportPlan = (
  total: number,
  pageSize: number = AUDIT_EXPORT_PAGE_SIZE,
  maxEvents: number = AUDIT_EXPORT_MAX_EVENTS,
): AuditExportPlan => {
  const events = Math.min(Math.max(total, 0), maxEvents);
  return { pages: Math.ceil(events / pageSize), events, truncated: total > maxEvents };
};

export interface AuditExport {
  events: AuditEventRecord[];
  /** Eventos que cumplían los filtros, aunque no quepan en el tope. */
  total: number;
  truncated: boolean;
}

/**
 * Reúne los eventos que van al CSV recorriendo las páginas necesarias hasta el
 * tope. La primera página se pide con el mismo `pageSize` de la exportación y de
 * ella sale el `total`: la consulta paginada ya lo devuelve, así que no hace
 * falta un `count` aparte.
 *
 * Las páginas van en serie a propósito: la exportación no compite consigo misma
 * por el pool de conexiones mientras el resto de la pantalla sigue consultando.
 */
export const collectAuditEventsForExport = async (
  db: IdentityDb,
  query: AuditQuery,
): Promise<AuditExport> => {
  const pagina = (numero: number): AuditQuery => ({
    ...query,
    page: numero,
    pageSize: AUDIT_EXPORT_PAGE_SIZE,
  });

  const primera = await queryAuditEvents(db, pagina(1));
  const plan = auditExportPlan(primera.total);
  const events = [...primera.items];

  for (let numero = 2; numero <= plan.pages; numero += 1) {
    const siguiente = await queryAuditEvents(db, pagina(numero));
    // Si la consulta se queda corta (alguien borró filas entre página y página)
    // no hay nada más que leer y no se sigue pidiendo en balde.
    if (siguiente.items.length === 0) break;
    events.push(...siguiente.items);
  }

  return {
    events: events.slice(0, AUDIT_EXPORT_MAX_EVENTS),
    total: primera.total,
    truncated: plan.truncated,
  };
};

/**
 * Filas del CSV: los eventos y, si se alcanzó el tope, una **última fila** con el
 * aviso. Se elige fila final y no línea de cabecera porque una línea antes del
 * encabezado desplazaría los títulos y Excel la tomaría por datos; el texto va en
 * «Qué pasó», que es la columna que lee una persona.
 */
export const auditExportRows = (
  events: readonly AuditEventRecord[],
  truncated: boolean,
): Record<string, string>[] => {
  const rows = events.map((event) => auditEventToRow(event));
  if (!truncated) return rows;

  rows.push({
    summary:
      `Aviso: se alcanzó el tope de ${AUDIT_EXPORT_MAX_EVENTS.toLocaleString('es-VE')} eventos. ` +
      'Acota el rango de fechas o los filtros y exporta el resto.',
  });
  return rows;
};

/**
 * Nombre del archivo: `auditoria-<desde>_<hasta>.csv`. Se limpia todo lo que no
 * sea `[0-9A-Za-z._-]` porque el valor viaja a una cabecera HTTP
 * (`content-disposition`): comillas o saltos de línea ahí son una inyección de
 * cabeceras, y las fechas que llegan son `aaaa-mm-dd` o instantes ISO.
 */
export const auditExportFileName = (query: Pick<AuditQuery, 'from' | 'to'>): string => {
  const parte = (valor: string | undefined, porDefecto: string): string => {
    if (valor === undefined || valor === '') return porDefecto;
    const limpio = valor.replace(/[^0-9A-Za-z._-]/g, '-');
    return limpio.length > 0 ? limpio : porDefecto;
  };
  return `auditoria-${parte(query.from, 'inicio')}_${parte(query.to, 'fin')}.csv`;
};
