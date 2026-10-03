import { deviceTokenSchema, type DeviceTokenCreated } from '@odontocrm/contracts';
import {
  NotFoundError,
  generateOpaqueToken,
  hashOpaqueToken,
  parseOrThrow,
  requireIdentity,
  requirePermission,
} from '@odontocrm/kernel';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { writeAuditEvent } from '../audit/audit-service.js';
import { deviceTokens } from '../db/schema.js';
import type { IdentityServices } from '../services.js';
import { requestContext } from './context.js';

const idParamsSchema = z.object({ id: z.uuid() });

/**
 * Pantallas kiosko: el administrador crea un token por dispositivo. El token en
 * claro se muestra **una sola vez**; en la base queda solo su hash. Su uso por
 * las pantallas (validación en el gateway) llega en la Fase 5.
 */
export const registerDeviceRoutes = (app: FastifyInstance, services: IdentityServices): void => {
  const { db } = services;
  const manageGuard = requirePermission('screens:manage');

  app.get('/api/v1/devices', { preHandler: manageGuard }, async (_request, reply) => {
    const rows = await db
      .select({
        id: deviceTokens.id,
        label: deviceTokens.label,
        kind: deviceTokens.kind,
        createdAt: deviceTokens.createdAt,
        lastSeenAt: deviceTokens.lastSeenAt,
        isActive: deviceTokens.isActive,
        revokedAt: deviceTokens.revokedAt,
      })
      .from(deviceTokens)
      .orderBy(desc(deviceTokens.createdAt));

    return reply.status(200).send({
      items: rows.map((row) => ({
        ...row,
        createdAt: row.createdAt.toISOString(),
        lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
        revokedAt: row.revokedAt?.toISOString() ?? null,
      })),
      total: rows.length,
    });
  });

  app.post('/api/v1/devices', { preHandler: manageGuard }, async (request, reply) => {
    const identity = requireIdentity(request);
    const input = parseOrThrow(deviceTokenSchema, request.body);
    const context = requestContext(request);

    const token = generateOpaqueToken();
    const inserted = await db
      .insert(deviceTokens)
      .values({
        label: input.label,
        kind: input.kind,
        tokenHash: hashOpaqueToken(token),
        createdBy: identity.userId,
      })
      .returning({ id: deviceTokens.id });

    const id = inserted[0]?.id;
    if (id === undefined) throw new NotFoundError('No se pudo crear el token del dispositivo');

    await writeAuditEvent(db, {
      action: 'device_token_created',
      entityType: 'device_token',
      entityId: id,
      actorId: identity.userId,
      actorUsername: identity.username,
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
      after: { label: input.label, kind: input.kind },
      changedFields: ['label', 'kind'],
    });

    const created: DeviceTokenCreated = {
      id,
      label: input.label,
      kind: input.kind,
      token,
    };
    return reply.status(201).send(created);
  });

  app.delete('/api/v1/devices/:id', { preHandler: manageGuard }, async (request, reply) => {
    const identity = requireIdentity(request);
    const { id } = parseOrThrow(idParamsSchema, request.params);
    const context = requestContext(request);

    const updated = await db
      .update(deviceTokens)
      .set({ isActive: false, revokedAt: new Date() })
      .where(and(eq(deviceTokens.id, id), isNull(deviceTokens.revokedAt)))
      .returning({ id: deviceTokens.id, label: deviceTokens.label });

    const row = updated[0];
    if (row === undefined) throw new NotFoundError('El dispositivo no existe o ya está revocado');

    await writeAuditEvent(db, {
      action: 'device_token_revoked',
      entityType: 'device_token',
      entityId: row.id,
      actorId: identity.userId,
      actorUsername: identity.username,
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
      before: { isActive: true },
      after: { isActive: false },
      changedFields: ['isActive'],
    });

    return reply.status(204).send();
  });
};
