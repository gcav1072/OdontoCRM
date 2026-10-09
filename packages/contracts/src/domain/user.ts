import { z } from 'zod';

import { PERMISSIONS, ROLE_PERMISSIONS, ROLES, type Permission, type Role } from './enums.js';

/** Nombre de usuario: minúsculas, números, punto, guion y guion bajo. */
export const USERNAME_REGEX = /^[a-z0-9][a-z0-9._-]{2,31}$/;

export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    USERNAME_REGEX,
    'El usuario debe tener entre 3 y 32 caracteres: minúsculas, números, punto, guion o guion bajo',
  );

/**
 * Política de contraseñas (ADR 0023): mínimo 10 caracteres. No se exige mezcla de
 * símbolos porque en un consultorio eso termina en contraseñas apuntadas en un papel.
 */
export const passwordSchema = z
  .string()
  .min(10, 'La contraseña debe tener al menos 10 caracteres')
  .max(200, 'La contraseña es demasiado larga');

export const roleSchema = z.enum(ROLES as unknown as [Role, ...Role[]]);
export const permissionSchema = z.enum(PERMISSIONS as unknown as [Permission, ...Permission[]]);

export const userSummarySchema = z.object({
  id: z.uuid(),
  username: z.string(),
  fullName: z.string(),
  email: z.string().nullable(),
  roles: z.array(roleSchema),
  permissions: z.array(permissionSchema),
  isActive: z.boolean(),
  mustChangePassword: z.boolean(),
  /** Un odontólogo que todavía no completó su perfil profesional (MPPS, especialidad…). */
  needsProfile: z.boolean(),
  isLocked: z.boolean(),
  failedAttempts: z.number().int().min(0),
  lastLoginAt: z.string().nullable(),
  createdAt: z.string(),
});

export type UserSummary = z.infer<typeof userSummarySchema>;

export const createUserSchema = z.object({
  username: usernameSchema,
  fullName: z.string().trim().min(3, 'Escribe el nombre completo').max(120),
  email: z.union([z.email(), z.literal('')]).optional(),
  password: passwordSchema,
  roles: z.array(roleSchema).min(1, 'Asigna al menos un rol'),
  mustChangePassword: z.boolean().default(true),
});

export type CreateUserInput = z.infer<typeof createUserSchema>;

export const updateUserSchema = z.object({
  fullName: z.string().trim().min(3).max(120).optional(),
  email: z.union([z.email(), z.literal('')]).optional(),
  roles: z.array(roleSchema).min(1).optional(),
  isActive: z.boolean().optional(),
  /** Motivo obligatorio: alimenta la auditoría (misma regla que los pacientes). */
  reason: z.string().trim().min(3, 'Indica el motivo del cambio').max(300),
});

export type UpdateUserInput = z.infer<typeof updateUserSchema>;

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Escribe tu contraseña actual'),
    newPassword: passwordSchema,
    repeatPassword: z.string().min(1),
  })
  .refine((value) => value.newPassword === value.repeatPassword, {
    message: 'Las contraseñas no coinciden',
    path: ['repeatPassword'],
  })
  .refine((value) => value.newPassword !== value.currentPassword, {
    message: 'La nueva contraseña debe ser distinta de la actual',
    path: ['newPassword'],
  });

export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

export const resetPasswordSchema = z.object({
  /** Si se omite, el servidor genera una contraseña temporal y la devuelve una vez. */
  newPassword: passwordSchema.optional(),
  reason: z.string().trim().min(3).max(300),
});

export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

/** Permisos efectivos de un usuario: la unión de los permisos de sus roles. */
export const permissionsForRoles = (roles: readonly Role[]): Permission[] => {
  const result = new Set<Permission>();
  for (const role of roles) {
    for (const permission of ROLE_PERMISSIONS[role] ?? []) result.add(permission);
  }
  return [...result];
};

/** `admin` puede todo, sin importar los permisos declarados de su rol. */
export const hasPermission = (roles: readonly Role[], permission: Permission): boolean =>
  roles.includes('admin') || permissionsForRoles(roles).includes(permission);

export const hasAnyPermission = (
  roles: readonly Role[],
  permissions: readonly Permission[],
): boolean => permissions.some((permission) => hasPermission(roles, permission));

export const hasAllPermissions = (
  roles: readonly Role[],
  permissions: readonly Permission[],
): boolean => permissions.every((permission) => hasPermission(roles, permission));
