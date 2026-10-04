import { AUDIT_EXPORT_COLUMNS, auditQuerySchema, buildCsv } from '@odontocrm/contracts';
import { parseQuery, requirePermission } from '@odontocrm/kernel';
import type { FastifyInstance } from 'fastify';

import {
  auditExportFileName,
  auditExportRows,
  collectAuditEventsForExport,
  queryAuditEvents,
} from '../audit/audit-service.js';
import type { IdentityServices } from '../services.js';

/** Consulta del módulo de auditoría (fecha, usuario, acción, entidad y campo). */
export const registerAuditRoutes = (app: FastifyInstance, services: IdentityServices): void => {
  const { db } = services;
  const guard = requirePermission('audit:read');

  /**
   * Exportación CSV del listado **con los mismos filtros** que la pantalla, sin
   * paginación: el servidor recorre las páginas que hagan falta hasta el tope y
   * arma el archivo con `buildCsv` (BOM UTF-8, `;` y CRLF, lo que abre bien en
   * Excel en español).
   *
   * Va **antes** de `/events` a propósito: aunque hoy ninguna ruta paramétrica
   * cuelga de `/audit`, el orden deja escrito que `export.csv` es un recurso
   * propio y no el `:id` de otra ruta que pudiera capturarlo.
   *
   * Si se alcanza el tope, `auditExportRows` añade la fila final que lo avisa.
   */
  app.get('/api/v1/audit/events/export.csv', { preHandler: guard }, async (request, reply) => {
    const query = parseQuery(auditQuerySchema, request.query);
    const { events, truncated } = await collectAuditEventsForExport(db, query);

    return reply
      .status(200)
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${auditExportFileName(query)}"`)
      .send(buildCsv(AUDIT_EXPORT_COLUMNS, auditExportRows(events, truncated)));
  });

  app.get('/api/v1/audit/events', { preHandler: guard }, async (request, reply) => {
    const query = parseQuery(auditQuerySchema, request.query);
    const page = await queryAuditEvents(db, query);

    return reply.status(200).send({
      items: page.items,
      total: page.total,
      page: query.page,
      pageSize: query.pageSize,
      totalPages: Math.max(1, Math.ceil(page.total / query.pageSize)),
    });
  });
};
