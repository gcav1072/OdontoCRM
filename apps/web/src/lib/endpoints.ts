import {
  type AuditEventRecord,
  type ChangePasswordInput,
  type ChangePatientStatusInput,
  type CreatePatientInput,
  type CreateUserInput,
  type LoginInput,
  type LoginResponse,
  type Paginated,
  type PatientDetail,
  type PatientFile,
  type PatientFileKind,
  type PatientFilters,
  type PatientLookupResult,
  type PatientSummary,
  type Permission,
  type ResetPasswordInput,
  type Role,
  type SessionInfo,
  type UpdatePatientInput,
  type UpdateUserInput,
  type UserSummary,
} from '@odontocrm/contracts';

import { API_BASE, api, apiBinary, refreshSession, type QueryParams } from './api';

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

/** Datos del formulario de carga de un adjunto. */
export interface PatientFileUpload {
  file: File;
  kind: PatientFileKind;
  caption?: string;
}

/** Lista de adjuntos: el contrato devuelve `{ items, total }`, sin paginación. */
export interface PatientFileList {
  items: PatientFile[];
  total: number;
}

/**
 * Pacientes (Fase 2). Todo pasa por el gateway y el transporte compartido: el
 * token sigue en memoria, un 401 dispara **un** refresco y los errores llegan
 * como `ApiError` (el 409 del documento duplicado trae `existingPatientId` en
 * `error.payload`).
 */
export const patientsApi = {
  list: (filters: PatientFilters, signal?: AbortSignal): Promise<Paginated<PatientSummary>> =>
    api.get<Paginated<PatientSummary>>('/patients', {
      query: { ...filters } as QueryParams,
      signal,
    }),

  /** Búsqueda por documento: devuelve el paciente o el aviso de que no existe. */
  lookup: (document: string, signal?: AbortSignal): Promise<PatientLookupResult> =>
    api.get<PatientLookupResult>('/patients/lookup', { query: { document }, signal }),

  get: (id: string, signal?: AbortSignal): Promise<PatientDetail> =>
    api.get<PatientDetail>(`/patients/${id}`, { signal }),

  create: (input: CreatePatientInput): Promise<PatientDetail> =>
    api.post<PatientDetail>('/patients', input),

  update: (id: string, input: UpdatePatientInput): Promise<PatientDetail> =>
    api.patch<PatientDetail>(`/patients/${id}`, input),

  changeStatus: (id: string, input: ChangePatientStatusInput): Promise<PatientDetail> =>
    api.post<PatientDetail>(`/patients/${id}/status`, input),

  listFiles: (id: string, signal?: AbortSignal): Promise<PatientFileList> =>
    api.get<PatientFileList>(`/patients/${id}/files`, { signal }),

  /**
   * Carga de un adjunto en `multipart/form-data`. No se pone `Content-Type`:
   * el navegador lo escribe con el `boundary` que genera él mismo.
   */
  uploadFile: (id: string, upload: PatientFileUpload): Promise<PatientFile> => {
    const cuerpo = new FormData();
    cuerpo.append('file', upload.file);
    cuerpo.append('kind', upload.kind);
    if (upload.caption !== undefined && upload.caption !== '') {
      cuerpo.append('caption', upload.caption);
    }
    return api.request<PatientFile>('POST', `/patients/${id}/files`, { rawBody: cuerpo });
  },

  /**
   * Ruta del adjunto para descargar. El archivo se sirve por endpoint
   * autorizado, así que se pide con las credenciales de la sesión (ver
   * `downloadFile`) y nunca con una URL pública.
   */
  downloadFileUrl: (id: string, fileId: string): string =>
    `${API_BASE}/patients/${id}/files/${fileId}`,

  /** Descarga autenticada: devuelve el binario para guardarlo con un enlace temporal. */
  downloadFile: (id: string, fileId: string, signal?: AbortSignal): Promise<Blob> =>
    apiBinary('GET', `/patients/${id}/files/${fileId}`, { signal }),

  deleteFile: (id: string, fileId: string): Promise<void> =>
    api.delete<void>(`/patients/${id}/files/${fileId}`),
};
