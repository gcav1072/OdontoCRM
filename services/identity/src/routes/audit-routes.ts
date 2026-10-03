import { auditQuerySchema } from '@odontocrm/contracts';
import { parseQuery, requirePermission } from '@odontocrm/kernel';
import type { FastifyInstance } from 'fastify';

import { queryAuditEvents } from '../audit/audit-service.js';
import type { IdentityServices } from '../services.js';

/** Consulta del módulo de auditoría (fecha, usuario, acción, entidad y campo). */
export const registerAuditRoutes = (app: FastifyInstance, services: IdentityServices): void => {
  const { db } = services;
  const guard = requirePermission('audit:read');

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
