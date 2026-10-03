import type {
  CreateUserInput,
  Paginated,
  ResetPasswordInput,
  Role,
  UpdateUserInput,
  UserSummary,
} from '@odontocrm/contracts';
import {
  diffSensitiveFields,
  paginate,
  permissionsForRoles,
  type SensitiveDiff,
} from '@odontocrm/contracts';
import {
  ConflictError,
  NotFoundError,
  generateTemporaryPassword,
  hashPassword,
} from '@odontocrm/kernel';
import { and, count, eq, inArray, or, sql } from 'drizzle-orm';

import type { IdentityDb } from '../db/client.js';
import { userRoles, users, type UserRow } from '../db/schema.js';

/** Campos cuyo cambio queda registrado en la auditoría (decisión del usuario). */
export const SENSITIVE_USER_FIELDS = ['fullName', 'email', 'roles', 'isActive'] as const;

export const toUserSummary = (row: UserRow, roles: Role[], now = new Date()): UserSummary => ({
  id: row.id,
  username: row.username,
  fullName: row.fullName,
  email: row.email,
  roles,
  permissions: permissionsForRoles(roles),
  isActive: row.isActive,
  mustChangePassword: row.mustChangePassword,
  isLocked: row.lockedUntil !== null && row.lockedUntil.getTime() > now.getTime(),
  failedAttempts: row.failedAttempts,
  lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
});

export const findUserByUsername = async (
  db: IdentityDb,
  username: string,
): Promise<UserRow | null> => {
  const rows = await db
    .select()
    .from(users)
    .where(eq(users.username, username.trim().toLowerCase()))
    .limit(1);
  return rows[0] ?? null;
};

export const findUserById = async (db: IdentityDb, id: string): Promise<UserRow | null> => {
  const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return rows[0] ?? null;
};

export const loadRoles = async (db: IdentityDb, userId: string): Promise<Role[]> => {
  const rows = await db
    .select({ role: userRoles.role })
    .from(userRoles)
    .where(eq(userRoles.userId, userId));
  return rows.map((row) => row.role as Role);
};

const loadRolesForUsers = async (
  db: IdentityDb,
  userIds: readonly string[],
): Promise<Map<string, Role[]>> => {
  const result = new Map<string, Role[]>(userIds.map((id) => [id, []]));
  if (userIds.length === 0) return result;

  const rows = await db
    .select({ userId: userRoles.userId, role: userRoles.role })
    .from(userRoles)
    .where(inArray(userRoles.userId, [...userIds]));

  for (const row of rows) {
    result.get(row.userId)?.push(row.role as Role);
  }
  return result;
};

/** Escapa los comodines de `LIKE` para que la búsqueda sea literal. */
const likePattern = (search: string): string =>
  `%${search.trim().replace(/[\\%_]/g, (match) => `\\${match}`)}%`;

export interface ListUsersOptions {
  search?: string | undefined;
  page: number;
  pageSize: number;
}

export const listUsers = async (
  db: IdentityDb,
  options: ListUsersOptions,
): Promise<Paginated<UserSummary>> => {
  const search = options.search?.trim() ?? '';
  const where =
    search === ''
      ? undefined
      : or(
          sql`${users.fullName} ilike ${likePattern(search)} escape '\\'`,
          sql`${users.username} ilike ${likePattern(search)} escape '\\'`,
        );

  const offset = (options.page - 1) * options.pageSize;

  const [rows, totals] = await Promise.all([
    db
      .select()
      .from(users)
      .where(where)
      .orderBy(users.username)
      .limit(options.pageSize)
      .offset(offset),
    db.select({ value: count() }).from(users).where(where),
  ]);

  const rolesByUser = await loadRolesForUsers(
    db,
    rows.map((row) => row.id),
  );
  const now = new Date();

  return paginate(
    rows.map((row) => toUserSummary(row, rolesByUser.get(row.id) ?? [], now)),
    totals[0]?.value ?? 0,
    { page: options.page, pageSize: options.pageSize },
  );
};

export const getUserSummary = async (db: IdentityDb, id: string): Promise<UserSummary> => {
  const row = await findUserById(db, id);
  if (row === null) throw new NotFoundError('El usuario no existe');
  return toUserSummary(row, await loadRoles(db, id));
};

const replaceRoles = async (
  db: IdentityDb,
  userId: string,
  roles: readonly Role[],
  grantedBy: string | null,
): Promise<void> => {
  await db.delete(userRoles).where(eq(userRoles.userId, userId));
  if (roles.length === 0) return;
  await db.insert(userRoles).values(roles.map((role) => ({ userId, role, grantedBy })));
};

export const createUser = async (
  db: IdentityDb,
  input: CreateUserInput,
  actorId: string | null,
): Promise<UserSummary> => {
  const existing = await findUserByUsername(db, input.username);
  if (existing !== null) {
    throw new ConflictError(`Ya existe un usuario con el nombre "${input.username}"`);
  }

  const passwordHash = await hashPassword(input.password);
  const inserted = await db
    .insert(users)
    .values({
      username: input.username,
      fullName: input.fullName,
      email: input.email === undefined || input.email === '' ? null : input.email,
      passwordHash,
      mustChangePassword: input.mustChangePassword,
    })
    .returning();

  const row = inserted[0];
  if (row === undefined) throw new NotFoundError('No se pudo crear el usuario');

  await replaceRoles(db, row.id, input.roles, actorId);
  return toUserSummary(row, input.roles);
};

export interface UpdateUserResult {
  summary: UserSummary;
  diff: SensitiveDiff;
}

export const updateUser = async (
  db: IdentityDb,
  id: string,
  input: UpdateUserInput,
  actorId: string | null,
): Promise<UpdateUserResult> => {
  const current = await findUserById(db, id);
  if (current === null) throw new NotFoundError('El usuario no existe');

  const currentRoles = await loadRoles(db, id);
  const before = {
    fullName: current.fullName,
    email: current.email,
    roles: currentRoles.join(','),
    isActive: current.isActive,
  };
  const after = {
    fullName: input.fullName ?? current.fullName,
    email: input.email === undefined ? current.email : input.email === '' ? null : input.email,
    roles: (input.roles ?? currentRoles).join(','),
    isActive: input.isActive ?? current.isActive,
  };

  const diff = diffSensitiveFields(before, after, SENSITIVE_USER_FIELDS);

  if (diff.changedFields.length > 0) {
    await db
      .update(users)
      .set({
        fullName: after.fullName,
        email: after.email,
        isActive: after.isActive,
        updatedAt: new Date(),
      })
      .where(eq(users.id, id));

    if (diff.changedFields.includes('roles') && input.roles !== undefined) {
      await replaceRoles(db, id, input.roles, actorId);
    }
  }

  return { summary: await getUserSummary(db, id), diff };
};

export interface ResetPasswordResult {
  temporaryPassword: string | null;
  /** `true` si la contraseña la eligió el administrador (no se devuelve). */
  providedByAdmin: boolean;
}

export const resetUserPassword = async (
  db: IdentityDb,
  id: string,
  input: ResetPasswordInput,
): Promise<ResetPasswordResult> => {
  const user = await findUserById(db, id);
  if (user === null) throw new NotFoundError('El usuario no existe');

  const provided = input.newPassword !== undefined;
  const password = input.newPassword ?? generateTemporaryPassword();

  await db
    .update(users)
    .set({
      passwordHash: await hashPassword(password),
      mustChangePassword: true,
      failedAttempts: 0,
      lockedUntil: null,
      updatedAt: new Date(),
    })
    .where(eq(users.id, id));

  return { temporaryPassword: provided ? null : password, providedByAdmin: provided };
};

/** Cambia la contraseña del propio usuario y quita la marca de cambio obligatorio. */
export const setOwnPassword = async (
  db: IdentityDb,
  id: string,
  newPassword: string,
): Promise<void> => {
  await db
    .update(users)
    .set({
      passwordHash: await hashPassword(newPassword),
      mustChangePassword: false,
      updatedAt: new Date(),
    })
    .where(eq(users.id, id));
};

export const markMustChangePassword = async (db: IdentityDb, id: string): Promise<void> => {
  await db.update(users).set({ mustChangePassword: true }).where(eq(users.id, id));
};

/** Comprueba que el nombre de usuario está libre antes de intentar crearlo. */
export const assertUsernameAvailable = async (db: IdentityDb, username: string): Promise<void> => {
  const existing = await findUserByUsername(db, username);
  if (existing !== null) {
    throw new ConflictError(`Ya existe un usuario con el nombre "${username}"`);
  }
};

export const countActiveAdmins = async (db: IdentityDb): Promise<number> => {
  const rows = await db
    .select({ value: count() })
    .from(users)
    .innerJoin(userRoles, eq(userRoles.userId, users.id))
    .where(and(eq(userRoles.role, 'admin'), eq(users.isActive, true)));
  return rows[0]?.value ?? 0;
};
