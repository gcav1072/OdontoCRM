import { z } from 'zod';

import { roleSchema } from './user.js';

export const loginSchema = z.object({
  username: z.string().trim().min(1, 'Escribe tu usuario'),
  password: z.string().min(1, 'Escribe tu contraseña'),
});

export type LoginInput = z.infer<typeof loginSchema>;

/** Contenido del JWT de acceso (15 minutos, EdDSA). */
export const accessTokenClaimsSchema = z.object({
  /** Identificador del usuario. */
  sub: z.uuid(),
  username: z.string(),
  fullName: z.string(),
  roles: z.array(roleSchema),
  permissions: z.array(z.string()),
  mustChangePassword: z.boolean(),
  /**
   * Un odontólogo que todavía no completó su perfil profesional. Mientras sea `true`
   * no tiene permisos (igual que con la contraseña temporal): solo puede completarlo.
   */
  needsProfile: z.boolean(),
  /** Identificador de la sesión (familia de tokens de refresco). */
  sid: z.uuid(),
  iss: z.literal('odontocrm'),
  aud: z.literal('odontocrm-api'),
  iat: z.number().int(),
  exp: z.number().int(),
});

export type AccessTokenClaims = z.infer<typeof accessTokenClaimsSchema>;

export interface LoginResponse {
  accessToken: string;
  /** Segundos de vida del token de acceso. */
  expiresIn: number;
  user: {
    id: string;
    username: string;
    fullName: string;
    roles: string[];
    permissions: string[];
    mustChangePassword: boolean;
    /** El odontólogo aún no completó su perfil: solo puede rellenarlo. */
    needsProfile: boolean;
  };
}

/** Datos que el panel inferior muestra sobre la sesión actual. */
export interface SessionInfo {
  user: {
    id: string;
    username: string;
    fullName: string;
    roles: string[];
    permissions: string[];
    mustChangePassword: boolean;
    needsProfile: boolean;
  };
  /** Inicio de la sesión (ISO 8601). */
  loginAt: string;
  /** Caducidad del token de acceso (ISO 8601). */
  expiresAt: string;
  /** Caducidad del refresco (ISO 8601). */
  refreshExpiresAt: string;
  ip: string | null;
  userAgent: string | null;
}

export const deviceTokenSchema = z.object({
  label: z.string().trim().min(3).max(60),
  kind: z.enum(['lobby', 'consultorio']),
});

export type DeviceTokenInput = z.infer<typeof deviceTokenSchema>;

export interface DeviceTokenCreated {
  id: string;
  label: string;
  kind: 'lobby' | 'consultorio';
  /** Se devuelve **una sola vez**; en la base solo queda su hash. */
  token: string;
}

/**
 * La pantalla kiosko canjea su token de dispositivo por un **JWT de acceso**
 * (rol `pantalla`, solo `screens:display`): así entra por el gateway como
 * cualquier cliente y el token de larga vida nunca viaja en cada petición.
 */
export const deviceLoginSchema = z.object({
  token: z.string().trim().min(10, 'El token del dispositivo no es válido'),
});

export type DeviceLoginInput = z.infer<typeof deviceLoginSchema>;

export interface DeviceLoginResponse {
  accessToken: string;
  /** Segundos de vida del token de acceso (se vuelve a canjear antes de caducar). */
  expiresIn: number;
  device: { id: string; label: string; kind: 'lobby' | 'consultorio' };
}

/** Cabeceras que el gateway añade tras validar el token. */
export const IDENTITY_HEADERS = {
  userId: 'x-user-id',
  username: 'x-user-username',
  roles: 'x-user-roles',
  permissions: 'x-user-permissions',
  mustChangePassword: 'x-user-must-change-password',
  /** Un odontólogo sin perfil completo: el gateway le corta todo salvo el onboarding. */
  needsProfile: 'x-user-needs-profile',
  /** Sesión (familia de tokens): permite consultar los datos del login actual. */
  sessionId: 'x-session-id',
  deviceId: 'x-device-id',
  requestId: 'x-request-id',
} as const;

/** Cabeceras que el gateway **borra** si vienen del cliente (defensa en profundidad). */
export const IDENTITY_HEADER_NAMES: readonly string[] = Object.values(IDENTITY_HEADERS);

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
/** Ventana de gracia para la carrera entre pestañas durante la rotación. */
export const REFRESH_GRACE_SECONDS = 30;
export const REFRESH_COOKIE_NAME = 'odontocrm_refresh';
export const MAX_FAILED_ATTEMPTS = 5;
export const LOCK_MINUTES = 15;
