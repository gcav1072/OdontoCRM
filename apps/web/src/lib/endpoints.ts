import {
  type AppointmentStatus,
  type AppointmentSummary,
  type AssignAppointmentInput,
  type AttendAppointmentInput,
  type AuditEventRecord,
  type CancelAppointmentInput,
  type CancelRequestInput,
  type ChangePasswordInput,
  type ChangePatientStatusInput,
  type Channel,
  type CreatePatientInput,
  type CreateRequestInput,
  type CreateUserInput,
  type DayCapacity,
  type DayView,
  type DeletePatientInput,
  type LoginInput,
  type LoginResponse,
  type NoShowAppointmentInput,
  type NotifyBatch,
  type NotifyBatchInput,
  type NotifyBatchResult,
  type NotifyPreviewInput,
  type Paginated,
  type PatientDetail,
  type PatientFile,
  type PatientFileKind,
  type PatientFilters,
  type PatientLookupResult,
  type PatientSummary,
  type Permission,
  type RequestSummary,
  type ResetPasswordInput,
  type RescheduleAppointmentInput,
  type Role,
  type SessionInfo,
  type SetCapacityInput,
  type SlotTemplate,
  type SlotTemplateInput,
  type StatusHistoryEntry,
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

/** Respuesta del borrado lógico: la ficha que había y cuándo se marcó. */
export interface PatientRemoveResult {
  patient: PatientDetail;
  deletedAt: string;
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

  /**
   * Borrado lógico (solo `admin`, permiso `patients:delete`). Es `POST …/delete`
   * y no `DELETE` porque lleva el motivo en el cuerpo.
   */
  remove: (id: string, input: DeletePatientInput): Promise<PatientRemoveResult> =>
    api.post<PatientRemoveResult>(`/patients/${id}/delete`, input),

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

/* ── Agenda (Fase 3) ───────────────────────────────────────────────────────── */

/** Filtros de la cola de solicitudes: `order` alterna ticket y antigüedad. */
export interface RequestsListParams {
  status?: AppointmentStatus;
  onlyWaiting?: boolean;
  channel?: Channel;
  search?: string;
  order?: 'ticket' | 'antiguedad';
  page?: number;
  pageSize?: number;
}

export interface AppointmentsListParams {
  date?: string;
  from?: string;
  to?: string;
  status?: AppointmentStatus;
  patientId?: string;
  search?: string;
  page?: number;
  pageSize?: number;
}

/** Lista de plantillas de franjas: el contrato devuelve `{ items }`, sin paginar. */
export interface SlotTemplateList {
  items: SlotTemplate[];
}

/** Lista de cupos por rango de fechas: `{ items }`, sin paginar. */
export interface DayCapacityList {
  items: DayCapacity[];
}

/** Historial de estados de una cita o solicitud. */
export interface StatusHistoryList {
  items: StatusHistoryEntry[];
  total: number;
}

/**
 * Solicitudes con ticket (Fase 3). El ticket (`#000123`, `A-000001`) llega ya
 * formateado desde la API: la interfaz nunca lo compone.
 */
export const requestsApi = {
  list: (params: RequestsListParams, signal?: AbortSignal): Promise<Paginated<RequestSummary>> =>
    api.get<Paginated<RequestSummary>>('/requests', {
      query: { ...params } as QueryParams,
      signal,
    }),

  create: (input: CreateRequestInput): Promise<RequestSummary> =>
    api.post<RequestSummary>('/requests', input),

  get: (id: string, signal?: AbortSignal): Promise<RequestSummary> =>
    api.get<RequestSummary>(`/requests/${id}`, { signal }),

  cancel: (id: string, input: CancelRequestInput): Promise<RequestSummary> =>
    api.post<RequestSummary>(`/requests/${id}/cancel`, input),
};

/**
 * Jornada: cupo del día, franjas, plantillas y aviso en lote. `PUT /capacity`
 * responde 200 con `warning` cuando el cupo queda por debajo de lo asignado (no
 * borra nada), así que la respuesta se muestra tal cual.
 */
export const agendaApi = {
  day: (date: string, signal?: AbortSignal): Promise<DayView> =>
    api.get<DayView>(`/agenda/days/${date}`, { signal }),

  capacities: (from: string, to: string, signal?: AbortSignal): Promise<DayCapacityList> =>
    api.get<DayCapacityList>('/agenda/capacity', { query: { from, to }, signal }),

  setCapacity: (input: SetCapacityInput): Promise<DayCapacity> =>
    api.request<DayCapacity>('PUT', '/agenda/capacity', { body: input }),

  templates: (signal?: AbortSignal): Promise<SlotTemplateList> =>
    api.get<SlotTemplateList>('/agenda/templates', { signal }),

  createTemplate: (input: SlotTemplateInput): Promise<SlotTemplate> =>
    api.post<SlotTemplate>('/agenda/templates', input),

  updateTemplate: (id: string, input: Partial<SlotTemplateInput>): Promise<SlotTemplate> =>
    api.patch<SlotTemplate>(`/agenda/templates/${id}`, input),

  deleteTemplate: (id: string): Promise<void> => api.delete<void>(`/agenda/templates/${id}`),

  /** Vista previa exacta del lote: los mensajes que se prepararán, uno por cita. */
  notifyPreview: (input: NotifyPreviewInput, signal?: AbortSignal): Promise<NotifyBatch> =>
    api.post<NotifyBatch>('/agenda/notify/preview', input, { signal }),

  notify: (input: NotifyBatchInput): Promise<NotifyBatchResult> =>
    api.post<NotifyBatchResult>('/agenda/notify', input),
};

/**
 * Citas del día. Cada transición de estado la decide la máquina de estados de
 * los contratos; aquí solo está el transporte, con los errores RFC 7807 que
 * traen datos útiles en `error.payload` (día completo, franja ocupada,
 * transición no permitida, tolerancia de inasistencia).
 */
export const appointmentsApi = {
  assign: (input: AssignAppointmentInput): Promise<AppointmentSummary> =>
    api.post<AppointmentSummary>('/appointments', input),

  list: (
    params: AppointmentsListParams,
    signal?: AbortSignal,
  ): Promise<Paginated<AppointmentSummary>> =>
    api.get<Paginated<AppointmentSummary>>('/appointments', {
      query: { ...params } as QueryParams,
      signal,
    }),

  get: (id: string, signal?: AbortSignal): Promise<AppointmentSummary> =>
    api.get<AppointmentSummary>(`/appointments/${id}`, { signal }),

  history: (id: string, signal?: AbortSignal): Promise<StatusHistoryList> =>
    api.get<StatusHistoryList>(`/appointments/${id}/history`, { signal }),

  checkIn: (id: string): Promise<AppointmentSummary> =>
    api.post<AppointmentSummary>(`/appointments/${id}/check-in`),

  call: (id: string): Promise<AppointmentSummary> =>
    api.post<AppointmentSummary>(`/appointments/${id}/call`),

  start: (id: string): Promise<AppointmentSummary> =>
    api.post<AppointmentSummary>(`/appointments/${id}/start`),

  attend: (id: string, input: AttendAppointmentInput): Promise<AppointmentSummary> =>
    api.post<AppointmentSummary>(`/appointments/${id}/attend`, input),

  noShow: (id: string, input: NoShowAppointmentInput): Promise<AppointmentSummary> =>
    api.post<AppointmentSummary>(`/appointments/${id}/no-show`, input),

  cancel: (id: string, input: CancelAppointmentInput): Promise<AppointmentSummary> =>
    api.post<AppointmentSummary>(`/appointments/${id}/cancel`, input),

  reschedule: (id: string, input: RescheduleAppointmentInput): Promise<AppointmentSummary> =>
    api.post<AppointmentSummary>(`/appointments/${id}/reschedule`, input),
};
