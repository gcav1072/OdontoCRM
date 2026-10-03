import {
  ACCESS_TOKEN_TTL_SECONDS,
  LOCK_MINUTES,
  MAX_FAILED_ATTEMPTS,
  REFRESH_GRACE_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
  permissionsForRoles,
  type Role,
} from '@odontocrm/contracts';
import type { IdentityDb } from '../db/client.js';
import { refreshTokens, userRoles, users, type RefreshTokenRow } from '../db/schema.js';
import { generateOpaqueToken, hashOpaqueToken, signAccessToken, type PrivateKey } from '@odontocrm/kernel';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';

export { ACCESS_TOKEN_TTL_SECONDS, LOCK_MINUTES, MAX_FAILED_ATTEMPTS, REFRESH_TOKEN_TTL_SECONDS };

export interface SessionContext {
  ip: string | null;
  userAgent: string | null;
}

export interface IssuedSession {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  refreshExpiresAt: Date;
  /** Familia de tokens: identifica la sesión completa. */
  sessionId: string;
  loginAt: Date;
}

export interface SessionUser {
  id: string;
  username: string;
  fullName: string;
  mustChangePassword: boolean;
  isActive: boolean;
}

export interface RotationResult {
  status: 'rotated' | 'reuse_detected' | 'invalid' | 'expired';
  session?: IssuedSession;
  userId?: string;
}

/** Roles vigentes del usuario (se leen en cada emisión de token). */
export const getRolesForUser = async (db: IdentityDb, userId: string): Promise<Role[]> => {
  const rows = await db
    .select({ role: userRoles.role })
    .from(userRoles)
    .where(eq(userRoles.userId, userId));
  return rows.map((row) => row.role as Role);
};

const signFor = async (
  privateKey: PrivateKey,
  user: SessionUser,
  roles: Role[],
  sessionId: string,
): Promise<string> =>
  signAccessToken(
    {
      sub: user.id,
      username: user.username,
      fullName: user.fullName,
      roles,
      permissions: permissionsForRoles(roles),
      mustChangePassword: user.mustChangePassword,
      sid: sessionId,
    },
    { privateKey, ttlSeconds: ACCESS_TOKEN_TTL_SECONDS },
  );

/**
 * Crea una sesión nueva: guarda el hash del token de refresco y firma el token
 * de acceso. El token de refresco en claro solo existe en la respuesta.
 */
export const issueSession = async (
  db: IdentityDb,
  options: {
    user: SessionUser;
    roles: Role[];
    context: SessionContext;
    privateKey: PrivateKey;
    /** Si se indica, la rotación continúa en la misma familia (misma sesión). */
    familyId?: string;
  },
): Promise<IssuedSession> => {
  const now = new Date();
  const sessionId = options.familyId ?? globalThis.crypto.randomUUID();
  const refreshToken = generateOpaqueToken();
  const refreshExpiresAt = new Date(now.getTime() + REFRESH_TOKEN_TTL_SECONDS * 1000);

  await db.insert(refreshTokens).values({
    userId: options.user.id,
    familyId: sessionId,
    tokenHash: hashOpaqueToken(refreshToken),
    expiresAt: refreshExpiresAt,
    ip: options.context.ip,
    userAgent: options.context.userAgent,
  });

  const accessToken = await signFor(options.privateKey, options.user, options.roles, sessionId);

  return {
    accessToken,
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    refreshToken,
    refreshExpiresAt,
    sessionId,
    loginAt: now,
  };
};

export const findSessionByRefreshToken = async (
  db: IdentityDb,
  refreshToken: string,
): Promise<RefreshTokenRow | null> => {
  const rows = await db
    .select()
    .from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, hashOpaqueToken(refreshToken)))
    .limit(1);
  return rows[0] ?? null;
};

/** Revoca toda la familia: cualquier token de esa sesión deja de servir. */
export const revokeFamily = async (
  db: IdentityDb,
  familyId: string,
  reason: string,
): Promise<void> => {
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date(), revokedReason: reason })
    .where(and(eq(refreshTokens.familyId, familyId), isNull(refreshTokens.revokedAt)));
};

/** Revoca todas las sesiones de un usuario (al cambiar o restablecer la contraseña). */
export const revokeAllSessions = async (
  db: IdentityDb,
  userId: string,
  reason: string,
  exceptFamilyId?: string,
): Promise<void> => {
  const conditions = [eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)];
  if (exceptFamilyId !== undefined) {
    conditions.push(sql`${refreshTokens.familyId} <> ${exceptFamilyId}`);
  }
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date(), revokedReason: reason })
    .where(and(...conditions));
};

/**
 * Rota el token de refresco (ADR 0005):
 *  - token válido → se marca como rotado y se emite uno nuevo en la misma familia;
 *  - token ya rotado hace menos de `REFRESH_GRACE_SECONDS` → se acepta (carrera
 *    entre pestañas) y se emite otro token;
 *  - token revocado o reusado fuera de la ventana → **se revoca toda la familia**
 *    y se informa `reuse_detected` para que quede en auditoría.
 */
export const rotateSession = async (
  db: IdentityDb,
  options: {
    refreshToken: string;
    context: SessionContext;
    privateKey: PrivateKey;
    loadUser: (userId: string) => Promise<SessionUser | null>;
  },
): Promise<RotationResult> => {
  const row = await findSessionByRefreshToken(db, options.refreshToken);
  if (row === null) return { status: 'invalid' };

  const now = new Date();

  if (row.revokedAt !== null) {
    await revokeFamily(db, row.familyId, 'reuse_detected');
    return { status: 'reuse_detected', userId: row.userId };
  }

  if (row.rotatedAt !== null) {
    const elapsed = now.getTime() - row.rotatedAt.getTime();
    if (elapsed > REFRESH_GRACE_SECONDS * 1000) {
      await revokeFamily(db, row.familyId, 'reuse_detected');
      return { status: 'reuse_detected', userId: row.userId };
    }
  } else if (row.expiresAt.getTime() <= now.getTime()) {
    await revokeFamily(db, row.familyId, 'expired');
    return { status: 'expired', userId: row.userId };
  }

  const user = await options.loadUser(row.userId);
  if (user === null || !user.isActive) {
    await revokeFamily(db, row.familyId, 'user_unavailable');
    return { status: 'invalid' };
  }

  const roles = await getRolesForUser(db, user.id);
  const session = await issueSession(db, {
    user,
    roles,
    context: options.context,
    privateKey: options.privateKey,
    familyId: row.familyId,
  });

  await db.update(refreshTokens).set({ rotatedAt: now }).where(eq(refreshTokens.id, row.id));

  return { status: 'rotated', session, userId: user.id };
};

export interface SessionDetails {
  loginAt: Date | null;
  refreshExpiresAt: Date | null;
  ip: string | null;
  userAgent: string | null;
}

/** Datos de la sesión actual para el panel inferior de la interfaz. */
export const getSessionDetails = async (
  db: IdentityDb,
  sessionId: string,
): Promise<SessionDetails> => {
  const rows = await db
    .select({
      issuedAt: refreshTokens.issuedAt,
      expiresAt: refreshTokens.expiresAt,
      ip: refreshTokens.ip,
      userAgent: refreshTokens.userAgent,
    })
    .from(refreshTokens)
    .where(eq(refreshTokens.familyId, sessionId))
    .orderBy(desc(refreshTokens.issuedAt))
    .limit(1);

  const row = rows[0];
  return {
    loginAt: row?.issuedAt ?? null,
    refreshExpiresAt: row?.expiresAt ?? null,
    ip: row?.ip ?? null,
    userAgent: row?.userAgent ?? null,
  };
};

/**
 * Suma un intento fallido y bloquea la cuenta al llegar al máximo
 * (`MAX_FAILED_ATTEMPTS` intentos durante `LOCK_MINUTES` minutos).
 */
export const registerFailedAttempt = async (
  db: IdentityDb,
  userId: string,
  now: Date,
): Promise<{ attempts: number; lockedUntil: Date | null }> => {
  const rows = await db
    .select({ failedAttempts: users.failedAttempts })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  const attempts = (rows[0]?.failedAttempts ?? 0) + 1;
  const shouldLock = attempts >= MAX_FAILED_ATTEMPTS;
  const lockedUntil = shouldLock ? new Date(now.getTime() + LOCK_MINUTES * 60_000) : null;

  await db
    .update(users)
    .set({
      // Al bloquear se reinicia el contador: al expirar el bloqueo el usuario
      // vuelve a tener sus intentos completos.
      failedAttempts: shouldLock ? 0 : attempts,
      lockedUntil,
      updatedAt: now,
    })
    .where(eq(users.id, userId));

  return { attempts: shouldLock ? MAX_FAILED_ATTEMPTS : attempts, lockedUntil };
};

/** Login correcto: limpia el bloqueo y deja la marca de último acceso. */
export const registerSuccessfulLogin = async (
  db: IdentityDb,
  userId: string,
  now: Date,
): Promise<void> => {
  await db
    .update(users)
    .set({ failedAttempts: 0, lockedUntil: null, lastLoginAt: now, updatedAt: now })
    .where(eq(users.id, userId));
};
