import {
  changePasswordSchema,
  loginSchema,
  permissionsForRoles,
  type LoginResponse,
  type Role,
  type SessionInfo,
} from '@odontocrm/contracts';
import {
  AppError,
  UnauthorizedError,
  parseOrThrow,
  requireIdentity,
  verifyPassword,
} from '@odontocrm/kernel';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { writeAuditEvent } from '../audit/audit-service.js';
import type { IdentityServices } from '../services.js';
import {
  clearRefreshCookie,
  readRefreshCookie,
  requestContext,
  setRefreshCookie,
} from './context.js';
import {
  findUserById,
  findUserByUsername,
  loadRoles,
  setOwnPassword,
} from '../users/user-service.js';
import {
  findSessionByRefreshToken,
  getSessionDetails,
  issueSession,
  registerFailedAttempt,
  registerSuccessfulLogin,
  revokeAllSessions,
  revokeFamily,
  rotateSession,
  MAX_FAILED_ATTEMPTS,
  LOCK_MINUTES,
} from '../security/session.js';

const toLoginResponse = (
  session: { accessToken: string; expiresIn: number },
  user: {
    id: string;
    username: string;
    fullName: string;
    mustChangePassword: boolean;
  },
  roles: Role[],
): LoginResponse => ({
  accessToken: session.accessToken,
  expiresIn: session.expiresIn,
  user: {
    id: user.id,
    username: user.username,
    fullName: user.fullName,
    roles,
    permissions: permissionsForRoles(roles),
    mustChangePassword: user.mustChangePassword,
  },
});

const lockedUntilMessage = (lockedUntil: Date): string => {
  const minutes = Math.max(1, Math.ceil((lockedUntil.getTime() - Date.now()) / 60_000));
  return `La cuenta está bloqueada por intentos fallidos. Vuelve a intentarlo en ${String(minutes)} minuto(s).`;
};

export const registerAuthRoutes = (app: FastifyInstance, services: IdentityServices): void => {
  const { db, config, privateKey } = services;

  /** Inicia sesión: valida credenciales, aplica el bloqueo por intentos y emite tokens. */
  app.post('/api/v1/auth/login', async (request: FastifyRequest, reply: FastifyReply) => {
    const { username, password } = parseOrThrow(loginSchema, request.body);
    const context = requestContext(request);
    const now = new Date();

    const user = await findUserByUsername(db, username);
    const auditBase = {
      entityType: 'user',
      actorUsername: username,
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
    };

    if (user === null) {
      await writeAuditEvent(
        db,
        { ...auditBase, action: 'login_failed', reason: 'usuario inexistente' },
        (error) => request.log.error({ err: error }, 'No se pudo registrar la auditoría'),
      );
      throw new UnauthorizedError('Usuario o contraseña incorrectos');
    }

    if (!user.isActive) {
      await writeAuditEvent(db, {
        ...auditBase,
        actorId: user.id,
        action: 'login_failed',
        entityId: user.id,
        reason: 'usuario desactivado',
      });
      throw new AppError({
        status: 403,
        code: 'user_disabled',
        message: 'El usuario está desactivado. Contacta al administrador.',
      });
    }

    if (user.lockedUntil !== null && user.lockedUntil.getTime() > now.getTime()) {
      await writeAuditEvent(db, {
        ...auditBase,
        actorId: user.id,
        action: 'login_blocked',
        entityId: user.id,
        reason: 'cuenta bloqueada',
      });
      throw new AppError({
        status: 423,
        code: 'account_locked',
        message: lockedUntilMessage(user.lockedUntil),
      });
    }

    const passwordOk = await verifyPassword(password, user.passwordHash);

    if (!passwordOk) {
      const result = await registerFailedAttempt(db, user.id, now);
      await writeAuditEvent(db, {
        ...auditBase,
        actorId: user.id,
        action: 'login_failed',
        entityId: user.id,
        reason: `intento ${String(result.attempts)} de ${String(MAX_FAILED_ATTEMPTS)}`,
        after: { failedAttempts: result.attempts },
      });

      if (result.lockedUntil !== null) {
        throw new AppError({
          status: 423,
          code: 'account_locked',
          message: `Contraseña incorrecta. La cuenta queda bloqueada ${String(LOCK_MINUTES)} minutos por seguridad.`,
        });
      }

      throw new UnauthorizedError('Usuario o contraseña incorrectos');
    }

    await registerSuccessfulLogin(db, user.id, now);
    const roles = await loadRoles(db, user.id);
    const session = await issueSession(db, { user, roles, context, privateKey });

    setRefreshCookie(reply, config, session.refreshToken, session.refreshExpiresAt);
    await writeAuditEvent(db, {
      ...auditBase,
      actorId: user.id,
      action: 'login',
      entityId: user.id,
      after: { roles },
    });

    return reply.status(200).send(toLoginResponse(session, user, roles));
  });

  /**
   * Rota el token de refresco. Si detecta reuso (un token viejo reutilizado
   * fuera de la ventana de gracia) revoca toda la sesión y lo deja en auditoría.
   */
  app.post('/api/v1/auth/refresh', async (request: FastifyRequest, reply: FastifyReply) => {
    const refreshToken = readRefreshCookie(request);
    const context = requestContext(request);

    if (refreshToken === null) {
      throw new UnauthorizedError('Tu sesión expiró. Inicia sesión de nuevo.');
    }

    const result = await rotateSession(db, {
      refreshToken,
      context,
      privateKey,
      loadUser: async (userId) => {
        const row = await findUserById(db, userId);
        return row === null
          ? null
          : {
              id: row.id,
              username: row.username,
              fullName: row.fullName,
              mustChangePassword: row.mustChangePassword,
              isActive: row.isActive,
            };
      },
    });

    if (result.status === 'reuse_detected') {
      clearRefreshCookie(reply, config);
      await writeAuditEvent(db, {
        action: 'refresh_reuse_detected',
        entityType: 'session',
        entityId: result.userId ?? null,
        actorId: result.userId ?? null,
        ip: context.ip,
        userAgent: context.userAgent,
        requestId: context.requestId,
        reason: 'token de refresco reutilizado: se revocó la sesión completa',
      });
      throw new AppError({
        status: 401,
        code: 'session_reuse',
        message: 'Detectamos un problema de seguridad en tu sesión. Inicia sesión de nuevo.',
      });
    }

    if (result.status !== 'rotated' || result.session === undefined) {
      clearRefreshCookie(reply, config);
      throw new UnauthorizedError('Tu sesión expiró. Inicia sesión de nuevo.');
    }

    const user = await findUserById(db, result.userId ?? '');
    if (user === null) {
      clearRefreshCookie(reply, config);
      throw new UnauthorizedError('Tu sesión expiró. Inicia sesión de nuevo.');
    }

    const roles = await loadRoles(db, user.id);
    setRefreshCookie(reply, config, result.session.refreshToken, result.session.refreshExpiresAt);
    await writeAuditEvent(db, {
      action: 'refresh',
      entityType: 'session',
      entityId: result.session.sessionId,
      actorId: user.id,
      actorUsername: user.username,
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
    });

    return reply.status(200).send(toLoginResponse(result.session, user, roles));
  });

  /** Cierra la sesión actual (idempotente: siempre responde 204). */
  app.post('/api/v1/auth/logout', async (request: FastifyRequest, reply: FastifyReply) => {
    const refreshToken = readRefreshCookie(request);
    const context = requestContext(request);

    if (refreshToken !== null) {
      const row = await findSessionByRefreshToken(db, refreshToken);
      if (row !== null) {
        await revokeFamily(db, row.familyId, 'logout');
        await writeAuditEvent(db, {
          action: 'logout',
          entityType: 'session',
          entityId: row.familyId,
          actorId: row.userId,
          ip: context.ip,
          userAgent: context.userAgent,
          requestId: context.requestId,
        });
      }
    }

    clearRefreshCookie(reply, config);
    return reply.status(204).send();
  });

  /** Datos de la sesión actual para el panel inferior de la interfaz. */
  app.get('/api/v1/auth/me', async (request: FastifyRequest, reply: FastifyReply) => {
    const identity = requireIdentity(request);
    const user = await findUserById(db, identity.userId);
    if (user === null) throw new UnauthorizedError('Tu sesión ya no es válida');

    const roles = await loadRoles(db, user.id);
    const details =
      identity.sessionId === undefined
        ? { loginAt: null, refreshExpiresAt: null, ip: null, userAgent: null }
        : await getSessionDetails(db, identity.sessionId);

    const info: SessionInfo = {
      user: {
        id: user.id,
        username: user.username,
        fullName: user.fullName,
        roles,
        permissions: permissionsForRoles(roles),
        mustChangePassword: user.mustChangePassword,
      },
      loginAt: (details.loginAt ?? user.lastLoginAt ?? new Date()).toISOString(),
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      refreshExpiresAt: (details.refreshExpiresAt ?? new Date()).toISOString(),
      ip: details.ip ?? requestContext(request).ip,
      userAgent: details.userAgent ?? requestContext(request).userAgent,
    };

    return reply.status(200).send(info);
  });

  /**
   * Cambio de la propia contraseña. Es la única ruta que funciona con
   * `mustChangePassword`: el resto queda bloqueado hasta hacerlo.
   */
  app.post('/api/v1/auth/password/change', async (request: FastifyRequest, reply: FastifyReply) => {
    const identity = requireIdentity(request);
    const input = parseOrThrow(changePasswordSchema, request.body ?? {});
    const context = requestContext(request);

    const user = await findUserById(db, identity.userId);
    if (user === null) throw new UnauthorizedError('Tu sesión ya no es válida');

    const currentOk = await verifyPassword(input.currentPassword, user.passwordHash);
    if (!currentOk) {
      await writeAuditEvent(db, {
        action: 'password_changed',
        entityType: 'user',
        entityId: user.id,
        actorId: user.id,
        actorUsername: user.username,
        ip: context.ip,
        userAgent: context.userAgent,
        requestId: context.requestId,
        reason: 'falló la verificación de la contraseña actual',
      });
      throw new AppError({
        status: 400,
        code: 'invalid_current_password',
        message: 'La contraseña actual no es correcta',
      });
    }

    await setOwnPassword(db, user.id, input.newPassword);
    // Cambiar la contraseña cierra las demás sesiones (incluida la actual, que se
    // sustituye abajo por una nueva).
    await revokeAllSessions(db, user.id, 'password_changed');

    const roles = await loadRoles(db, user.id);
    const updated = await findUserById(db, user.id);
    if (updated === null) throw new UnauthorizedError('Tu sesión ya no es válida');

    const session = await issueSession(db, { user: updated, roles, context, privateKey });
    setRefreshCookie(reply, config, session.refreshToken, session.refreshExpiresAt);

    await writeAuditEvent(db, {
      action: 'password_changed',
      entityType: 'user',
      entityId: user.id,
      actorId: user.id,
      actorUsername: user.username,
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
      changedFields: ['passwordHash'],
    });

    return reply.status(200).send(toLoginResponse(session, updated, roles));
  });

  /** Alias de salud bajo el prefijo público para poder comprobarlo por el gateway. */
  app.get('/api/v1/auth/health', async () => ({
    service: 'identity',
    status: 'ok' as const,
    timestamp: new Date().toISOString(),
  }));
};
