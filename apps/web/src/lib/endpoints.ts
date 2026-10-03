import {
  type AuditEventRecord,
  type ChangePasswordInput,
  type CreateUserInput,
  type LoginInput,
  type LoginResponse,
  type Paginated,
  type Permission,
  type ResetPasswordInput,
  type Role,
  type SessionInfo,
  type UpdateUserInput,
  type UserSummary,
} from '@odontocrm/contracts';

import { api, refreshSession, type QueryParams } from './api';

/**
 * Mapa tipado del contrato de la API (Fase 1). Es el único lugar donde se
 * escriben rutas: si el contrato cambia, se cambia aquí y TypeScript señala a
 * quien lo use.
 */

/** Respuesta de `POST /users/:id/reset-password`: la temporal se ve una sola vez. */
export interface ResetPasswordResponse {
  temporaryPassword?: string;
}

/** Entrada del catálogo `GET /users/roles`. */
export interface RoleCatalogEntry {
  name: Role;
  description: string;
  permissions: Permission[];
}

export interface RoleCatalogResponse {
  roles: RoleCatalogEntry[];
}

export interface UsersListParams {
  search?: string;
  page?: number;
  pageSize?: number;
}

export interface AuditEventsParams {
  from?: string;
  to?: string;
  actorId?: string;
  actorUsername?: string;
  action?: string;
  entityType?: string;
  field?: string;
  page?: number;
  pageSize?: number;
}

export const authApi = {
  login: (input: LoginInput): Promise<LoginResponse> =>
    api.post<LoginResponse>('/auth/login', input, { anonymous: true, skipRefresh: true }),

  refresh: (): Promise<LoginResponse> => refreshSession(),

  /**
   * El cierre de sesión viaja con el token (para que el servidor revoque la
   * familia de refrescos) y admite el reintento con renovación: si el token
   * acababa de caducar, el cliente lo renueva y vuelve a intentarlo, así la
   * cookie `httpOnly` sí se borra.
   */
  logout: (): Promise<void> => api.post<void>('/auth/logout'),

  me: (signal?: AbortSignal): Promise<SessionInfo> => api.get<SessionInfo>('/auth/me', { signal }),

  changePassword: (input: ChangePasswordInput): Promise<LoginResponse> =>
    api.post<LoginResponse>('/auth/password/change', input, { skipRefresh: true }),
};

export const usersApi = {
  list: (params: UsersListParams, signal?: AbortSignal): Promise<Paginated<UserSummary>> =>
    api.get<Paginated<UserSummary>>('/users', {
      query: { ...params } as QueryParams,
      signal,
    }),

  create: (input: CreateUserInput): Promise<UserSummary> => api.post<UserSummary>('/users', input),

  get: (id: string, signal?: AbortSignal): Promise<UserSummary> =>
    api.get<UserSummary>(`/users/${id}`, { signal }),

  update: (id: string, input: UpdateUserInput): Promise<UserSummary> =>
    api.patch<UserSummary>(`/users/${id}`, input),

  resetPassword: (id: string, input: ResetPasswordInput): Promise<ResetPasswordResponse> =>
    api.post<ResetPasswordResponse>(`/users/${id}/reset-password`, input),

  roles: (signal?: AbortSignal): Promise<RoleCatalogResponse> =>
    api.get<RoleCatalogResponse>('/users/roles', { signal }),
};

/**
 * Consulta de auditoría. La Fase 9 construye la pantalla; el contrato ya queda
 * cubierto aquí para no duplicarlo entonces.
 */
export const auditApi = {
  events: (params: AuditEventsParams, signal?: AbortSignal): Promise<Paginated<AuditEventRecord>> =>
    api.get<Paginated<AuditEventRecord>>('/audit/events', {
      query: { ...params } as QueryParams,
      signal,
    }),
};
