import {
  PERMISSIONS,
  ROLE_PERMISSIONS,
  ROLES,
  createUserSchema,
  paginationQuerySchema,
  resetPasswordSchema,
  updateUserSchema,
  type Role,
} from '@odontocrm/contracts';
import {
  AppError,
  ConflictError,
  parseOrThrow,
  parseQuery,
  requireIdentity,
  requirePermission,
} from '@odontocrm/kernel';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { writeAuditEvent } from '../audit/audit-service.js';
import type { IdentityServices } from '../services.js';
import {
  countActiveAdmins,
  createUser,
  getUserSummary,
  listUsers,
  resetUserPassword,
  updateUser,
} from '../users/user-service.js';
import { revokeAllSessions } from '../security/session.js';
import { requestContext } from './context.js';

const idParamsSchema = z.object({ id: z.uuid() });

const listQuerySchema = paginationQuerySchema.extend({
  search: z.string().trim().max(120).optional(),
});

const ROLE_DESCRIPTIONS: Readonly<Record<Role, string>> = {
  admin: 'Acceso total al sistema',
  secretario: 'Recepción, registro, programación de la jornada y secretaría',
  odontologo: 'Consultorio, historia clínica, odontograma y récipes',
  pantalla: 'Solo lectura de las pantallas de sala de espera y consultorio',
};

export const registerUserRoutes = (app: FastifyInstance, services: IdentityServices): void => {
  const { db } = services;
  const guard = requirePermission('users:manage');

  /** Catálogo de roles y sus permisos (lo usa el formulario de usuarios). */
  app.get('/api/v1/users/roles', { preHandler: guard }, async (_request, reply) =>
    reply.status(200).send({
      roles: ROLES.map((name) => ({
        name,
        description: ROLE_DESCRIPTIONS[name],
        permissions: ROLE_PERMISSIONS[name],
      })),
      allPermissions: PERMISSIONS,
    }),
  );

  app.get('/api/v1/users', { preHandler: guard }, async (request, reply) => {
    const query = parseQuery(listQuerySchema, request.query);
    const page = await listUsers(db, {
      search: query.search,
      page: query.page,
      pageSize: query.pageSize,
    });
    return reply.status(200).send(page);
  });

  app.post('/api/v1/users', { preHandler: guard }, async (request, reply) => {
    const identity = requireIdentity(request);
    const input = parseOrThrow(createUserSchema, request.body);
    const created = await createUser(db, input, identity.userId);
    const context = requestContext(request);

    await writeAuditEvent(db, {
      action: 'user_created',
      entityType: 'user',
      entityId: created.id,
      actorId: identity.userId,
      actorUsername: identity.username,
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
      after: {
        username: created.username,
        fullName: created.fullName,
        roles: created.roles,
      },
      changedFields: ['username', 'fullName', 'roles'],
    });

    return reply.status(201).send(created);
  });

  app.get('/api/v1/users/:id', { preHandler: guard }, async (request, reply) => {
    const { id } = parseOrThrow(idParamsSchema, request.params);
    return reply.status(200).send(await getUserSummary(db, id));
  });

  app.patch('/api/v1/users/:id', { preHandler: guard }, async (request, reply) => {
    const identity = requireIdentity(request);
    const { id } = parseOrThrow(idParamsSchema, request.params);
    const input = parseOrThrow(updateUserSchema, request.body);
    const context = requestContext(request);

    // Guardas para no dejar el sistema sin administrador ni auto-bloquearse.
    if (input.isActive === false && id === identity.userId) {
      throw new ConflictError('No puedes desactivar tu propio usuario');
    }
    if (input.roles !== undefined && !input.roles.includes('admin')) {
      const admins = await countActiveAdmins(db);
      if (admins <= 1) {
        throw new ConflictError('Debe quedar al menos un administrador activo');
      }
    }

    const { summary, diff } = await updateUser(db, id, input, identity.userId);

    if (diff.changedFields.length > 0) {
      const action = diff.changedFields.includes('isActive')
        ? summary.isActive
          ? 'user_activated'
          : 'user_deactivated'
        : 'user_updated';

      await writeAuditEvent(db, {
        action,
        entityType: 'user',
        entityId: id,
        actorId: identity.userId,
        actorUsername: identity.username,
        ip: context.ip,
        userAgent: context.userAgent,
        requestId: context.requestId,
        before: diff.before,
        after: diff.after,
        changedFields: diff.changedFields,
        reason: input.reason,
      });
    }

    return reply.status(200).send(summary);
  });

  /** Restablece la contraseña de otro usuario y devuelve la temporal una sola vez. */
  app.post('/api/v1/users/:id/reset-password', { preHandler: guard }, async (request, reply) => {
    const identity = requireIdentity(request);
    const { id } = parseOrThrow(idParamsSchema, request.params);
    const input = parseOrThrow(resetPasswordSchema, request.body);
    const context = requestContext(request);

    if (id === identity.userId) {
      throw new AppError({
        status: 409,
        code: 'use_own_password_change',
        message: 'Para tu propia contraseña usa la opción de cambio de contraseña',
      });
    }

    const result = await resetUserPassword(db, id, input);
    await revokeAllSessions(db, id, 'password_reset');

    await writeAuditEvent(db, {
      action: 'password_reset',
      entityType: 'user',
      entityId: id,
      actorId: identity.userId,
      actorUsername: identity.username,
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
      changedFields: ['passwordHash'],
      reason: input.reason,
    });

    return reply.status(200).send(result);
  });
};
