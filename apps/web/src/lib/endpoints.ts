import {
  type AcceptConsentInput,
  type AmendClinicalSessionInput,
  type AppointmentStatus,
  type AppointmentSummary,
  type AssignAppointmentInput,
  type AttendAppointmentInput,
  type AuditEventRecord,
  type BotStatus,
  type CancelAppointmentInput,
  type CancelRequestInput,
  type ChangePasswordInput,
  type ChangePatientStatusInput,
  type Channel,
  type ClinicalRecordDetail,
  type ClinicalRecordLookup,
  type ClinicalSectionKey,
  type ClinicalSessionContent,
  type ClinicalSessionDetail,
  type ClinicalSessionList,
  type CloseClinicalSessionInput,
  type ConsultationState,
  type CreateAmendmentInput,
  type CreateClinicalSessionInput,
  type CreatePatientInput,
  type CreateRequestInput,
  type CreateUserInput,
  type DayCapacity,
  type DayView,
  type DeletePatientInput,
  type DeviceLoginResponse,
  type DeviceTokenCreated,
  type DeviceTokenInput,
  type LinkCode,
  type LobbyState,
  type LoginInput,
  type LoginResponse,
  type MarkContactedInput,
  type MessageTemplate,
  type MessageTemplateInput,
  type NoShowAppointmentInput,
  type NotificationRecord,
  type NotificationStatus,
  type NotifyBatch,
  type NotifyBatchInput,
  type NotifyBatchResult,
  type NotifyPreviewInput,
  type Paginated,
  type PatientChannel,
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
  type RetryNotificationInput,
  type Role,
  type ScreenDevice,
  type ScreenDeviceInput,
  type ScreenDeviceList,
  type ScreenDeviceUpdate,
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

  /**
   * Canjea el token de una pantalla kiosko por un JWT de rol `pantalla`. Es
   * anónimo a propósito: la pantalla no tiene usuario ni cookie, solo el token
   * que el administrador generó una vez.
   */
  deviceLogin: (token: string): Promise<DeviceLoginResponse> =>
    api.post<DeviceLoginResponse>(
      '/auth/device',
      { token },
      { anonymous: true, skipRefresh: true },
    ),
};

/** Tokens de dispositivo de las pantallas (los gestiona identity). */
export const devicesApi = {
  list: (signal?: AbortSignal): Promise<{ items: DeviceTokenListEntry[]; total: number }> =>
    api.get<{ items: DeviceTokenListEntry[]; total: number }>('/devices', { signal }),

  create: (input: DeviceTokenInput): Promise<DeviceTokenCreated> =>
    api.post<DeviceTokenCreated>('/devices', input),

  revoke: (id: string): Promise<void> => api.delete<void>(`/devices/${id}`),
};

/** Entrada del catálogo de tokens de dispositivo (`GET /devices`). */
export interface DeviceTokenListEntry {
  id: string;
  label: string;
  kind: 'lobby' | 'consultorio';
  createdAt: string;
  lastSeenAt: string | null;
  isActive: boolean;
  revokedAt: string | null;
}

/* ── Pantallas de sala y consultorio (Fase 5) ──────────────────────────────── */

/**
 * Pantallas kiosko: administración (registrar, ajustar la voz, desactivar) y el
 * estado que pintan. El **flujo en vivo** no está aquí: se abre con `fetch` para
 * poder mandar el JWT del dispositivo en la cabecera (`lib/kiosko.ts`).
 */
export const screensApi = {
  devices: (signal?: AbortSignal): Promise<ScreenDeviceList> =>
    api.get<ScreenDeviceList>('/screens/devices', { signal }),

  createDevice: (input: ScreenDeviceInput): Promise<ScreenDevice> =>
    api.post<ScreenDevice>('/screens/devices', input),

  updateDevice: (id: string, input: ScreenDeviceUpdate): Promise<ScreenDevice> =>
    api.patch<ScreenDevice>(`/screens/devices/${id}`, input),

  deleteDevice: (id: string): Promise<void> => api.delete<void>(`/screens/devices/${id}`),

  conectadas: (signal?: AbortSignal): Promise<{ lobby: number; consultorio: number }> =>
    api.get<{ lobby: number; consultorio: number }>('/screens/conectadas', { signal }),

  /** Ficha de la pantalla que llama, con sus ajustes (voz, volumen, resalte). */
  actual: (signal?: AbortSignal): Promise<ScreenDevice> =>
    api.get<ScreenDevice>('/screens/device', { signal }),

  lobby: (signal?: AbortSignal): Promise<LobbyState> =>
    api.get<LobbyState>('/screens/lobby', { signal }),

  consultorio: (signal?: AbortSignal): Promise<ConsultationState> =>
    api.get<ConsultationState>('/screens/consultorio', { signal }),
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

/* ── Notificaciones y bot (Fase 4) ─────────────────────────────────────────── */

/** Filtros de la bandeja de envíos: los mismos del contrato, sin paginación. */
export interface NotificationsListParams {
  status?: NotificationStatus;
  channel?: Channel;
  search?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

/** Lista de plantillas de mensaje: `{ items, total }`, sin paginar. */
export interface MessageTemplateList {
  items: MessageTemplate[];
  total: number;
}

/** Lista de canales vinculados: `{ items, total }`, sin paginar. */
export interface PatientChannelList {
  items: PatientChannel[];
  total: number;
}

/**
 * Enlace de vinculación con la imagen del QR ya renderizada.
 *
 * El contrato comparte `LinkCode` sin `qrDataUrl` porque la generación del QR es
 * responsabilidad del servicio; la API lo añade en esta respuesta, así que se
 * declara aquí (y se lee de forma defensiva) en vez de castear la respuesta.
 */
export interface LinkCodeResponse extends LinkCode {
  qrDataUrl?: string | null;
}

/**
 * Bandeja del bot (Fase 4). Ver la bandeja exige `scheduling:read`; reintentar,
 * marcar el contacto, editar plantillas y desvincular exigen
 * `scheduling:notify` (la API lo comprueba igual).
 */
export const notificationsApi = {
  list: (
    params: NotificationsListParams,
    signal?: AbortSignal,
  ): Promise<Paginated<NotificationRecord>> =>
    api.get<Paginated<NotificationRecord>>('/notifications', {
      query: { ...params } as QueryParams,
      signal,
    }),

  status: (signal?: AbortSignal): Promise<BotStatus> =>
    api.get<BotStatus>('/notifications/status', { signal }),

  retry: (id: string, input: RetryNotificationInput): Promise<NotificationRecord> =>
    api.post<NotificationRecord>(`/notifications/${id}/retry`, input),

  markContacted: (id: string, input: MarkContactedInput): Promise<NotificationRecord> =>
    api.post<NotificationRecord>(`/notifications/${id}/contacted`, input),

  templates: (signal?: AbortSignal): Promise<MessageTemplateList> =>
    api.get<MessageTemplateList>('/notifications/templates', { signal }),

  updateTemplate: (key: string, input: MessageTemplateInput): Promise<MessageTemplate> =>
    api.patch<MessageTemplate>(`/notifications/templates/${key}`, input),

  resetTemplate: (key: string): Promise<MessageTemplate> =>
    api.post<MessageTemplate>(`/notifications/templates/${key}/reset`),

  channels: (patientId?: string, signal?: AbortSignal): Promise<PatientChannelList> =>
    api.get<PatientChannelList>('/notifications/channels', {
      query: patientId === undefined ? undefined : { patientId },
      signal,
    }),

  linkCode: (patientId: string): Promise<LinkCodeResponse> =>
    api.post<LinkCodeResponse>('/notifications/channels/link-code', { patientId }),

  unlinkChannel: (patientId: string): Promise<void> =>
    api.delete<void>(`/notifications/channels/${patientId}`),
};

/** Constancia de impresión de una historia clínica. */
export interface PrintRecordResult {
  id: string;
  printCount: number;
  lastPrintedAt: string;
}

/**
 * Historia clínica (Fase 6, sesión A). Leer exige `clinical:read` (la secretaría
 * imprime) y escribir `clinical:write` (odontólogo y admin); la comprobación la
 * hace el servidor en cada ruta.
 */
export const clinicalApi = {
  /** Historia del paciente, o `exists: false` cuando es la primera visita. */
  recordByPatient: (patientId: string, signal?: AbortSignal): Promise<ClinicalRecordLookup> =>
    api.get<ClinicalRecordLookup>(`/clinical/patients/${patientId}/record`, { signal }),

  /** Abre la historia (idempotente). Solo odontólogo y admin. */
  openRecord: (patientId: string): Promise<ClinicalRecordDetail> =>
    api.post<ClinicalRecordDetail>(`/clinical/patients/${patientId}/record`, {}),

  getRecord: (id: string, signal?: AbortSignal): Promise<ClinicalRecordDetail> =>
    api.get<ClinicalRecordDetail>(`/clinical/records/${id}`, { signal }),

  saveSection: (
    id: string,
    sectionKey: ClinicalSectionKey,
    content: Record<string, unknown>,
  ): Promise<ClinicalRecordDetail> =>
    api.request<ClinicalRecordDetail>('PUT', `/clinical/records/${id}/sections/${sectionKey}`, {
      body: { content },
    }),

  acceptConsent: (id: string, input: AcceptConsentInput): Promise<ClinicalRecordDetail> =>
    api.request<ClinicalRecordDetail>('PUT', `/clinical/records/${id}/consent`, { body: input }),

  sign: (id: string): Promise<ClinicalRecordDetail> =>
    api.post<ClinicalRecordDetail>(`/clinical/records/${id}/sign`, { confirm: true }),

  addAmendment: (id: string, input: CreateAmendmentInput): Promise<ClinicalRecordDetail> =>
    api.post<ClinicalRecordDetail>(`/clinical/records/${id}/amendments`, input),

  /** Deja constancia de la impresión (también la secretaría, que solo lee). */
  registerPrint: (id: string): Promise<PrintRecordResult> =>
    api.post<PrintRecordResult>(`/clinical/records/${id}/printed`, {}),

  /* ── Sesiones clínicas (Fase 7, sesión A) ────────────────────────────────── */

  /** Evolución del paciente, de la última sesión a la primera. */
  sessions: (patientId: string, signal?: AbortSignal): Promise<ClinicalSessionList> =>
    api.get<ClinicalSessionList>(`/clinical/patients/${patientId}/sessions`, { signal }),

  /**
   * Abre la sesión del día. Es idempotente: si ya había un borrador, devuelve ese
   * (el doctor no pierde lo que estaba escribiendo).
   */
  openSession: (
    patientId: string,
    input: CreateClinicalSessionInput,
  ): Promise<ClinicalSessionDetail> =>
    api.post<ClinicalSessionDetail>(`/clinical/patients/${patientId}/sessions`, input),

  /** Sesiones de una cita: la secretaría lo usa para el «atendido» sin motivo. */
  sessionsByAppointment: (
    appointmentId: string,
    signal?: AbortSignal,
  ): Promise<ClinicalSessionList> =>
    api.get<ClinicalSessionList>(`/clinical/appointments/${appointmentId}/sessions`, { signal }),

  getSession: (id: string, signal?: AbortSignal): Promise<ClinicalSessionDetail> =>
    api.get<ClinicalSessionDetail>(`/clinical/sessions/${id}`, { signal }),

  /** Autoguardado del borrador: se manda el documento completo de la sesión. */
  saveSession: (id: string, content: ClinicalSessionContent): Promise<ClinicalSessionDetail> =>
    api.request<ClinicalSessionDetail>('PUT', `/clinical/sessions/${id}`, { body: { content } }),

  closeSession: (id: string, input: CloseClinicalSessionInput): Promise<ClinicalSessionDetail> =>
    api.post<ClinicalSessionDetail>(`/clinical/sessions/${id}/close`, input),

  amendSession: (id: string, input: AmendClinicalSessionInput): Promise<ClinicalSessionDetail> =>
    api.post<ClinicalSessionDetail>(`/clinical/sessions/${id}/amend`, input),
};
