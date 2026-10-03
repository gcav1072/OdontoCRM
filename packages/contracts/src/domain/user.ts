import type { Role } from './enums.js';

export interface UserSummary {
  id: string;
  username: string;
  fullName: string;
  roles: Role[];
  isActive: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
}

/** Datos que el panel inferior muestra sobre la sesión actual (decisión del usuario). */
export interface SessionInfo {
  user: UserSummary;
  loginAt: string;
  expiresAt: string;
  ip: string | null;
}
