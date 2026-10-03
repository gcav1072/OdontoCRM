import type { LoginResponse, ProblemFieldError } from '@odontocrm/contracts';

import { t } from './i18n';

/**
 * Cliente HTTP de la SPA.
 *
 * Decisiones que conviene tener presentes:
 * - El token de acceso vive **solo en memoria** (esta variable de módulo). Al
 *   recargar la página se recupera con `POST /auth/refresh`, que usa la cookie
 *   `httpOnly`; nunca se guarda en `localStorage`.
 * - Toda respuesta de error es RFC 7807 y se convierte en `ApiError` con el
 *   `detail` del servidor (ya viene en español) y los errores por campo.
 * - Ante un 401 se intenta **un solo** refresco y se reintenta la petición; si
 *   el refresco falla, se avisa a `AuthProvider` para cerrar la sesión y volver
 *   a `/login`. El refresco está deduplicado: varias peticiones simultáneas
 *   comparten la misma renovación (importante porque el token es rotativo y
 *   reusarlo dispara la detección de reuso del servidor).
 */

export const API_BASE = '/api/v1';

export type QueryParams = Record<string, string | number | boolean | undefined | null>;

export interface RequestOptions {
  body?: unknown;
  query?: QueryParams;
  signal?: AbortSignal;
  /** No adjunta el token (login, refresh, logout). */
  anonymous?: boolean;
  /** No intenta renovar la sesión ante un 401 (evita bucles en las rutas de auth). */
  skipRefresh?: boolean;
  /**
   * Cuerpo ya construido (`FormData` para los adjuntos). Cuando viene, se envía
   * tal cual y **no** se pone `Content-Type`: lo escribe el navegador con el
   * `boundary` del multipart, que es imposible de adivinar a mano.
   */
  rawBody?: BodyInit;
}

export interface ApiErrorInit {
  status: number;
  title: string;
  detail: string;
  fieldErrorList?: readonly ProblemFieldError[];
  fieldErrors?: Readonly<Record<string, string>>;
  requestId?: string | null;
  /** Cuerpo RFC 7807 completo, para extensiones propias (por ejemplo `existingPatientId` del 409). */
  payload?: Record<string, unknown> | null;
  cause?: unknown;
}

/** Error uniforme de la API: nunca se propaga un `Response` ni un error crudo. */
export class ApiError extends Error {
  /** 0 = no hubo respuesta (servidor apagado, red caída, petición cancelada). */
  readonly status: number;
  readonly title: string;
  readonly detail: string;
  /** Errores por campo del RFC 7807, indexados por `path`. */
  readonly fieldErrors: Readonly<Record<string, string>>;
  readonly fieldErrorList: readonly ProblemFieldError[];
  readonly requestId: string | null;
  readonly payload: Record<string, unknown> | null;

  constructor(init: ApiErrorInit) {
    super(init.detail, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'ApiError';
    this.status = init.status;
    this.title = init.title;
    this.detail = init.detail;
    this.fieldErrors = init.fieldErrors ?? {};
    this.fieldErrorList = init.fieldErrorList ?? [];
    this.requestId = init.requestId ?? null;
    this.payload = init.payload ?? null;
  }

  get sinConexion(): boolean {
    return this.status === 0;
  }

  get noAutorizado(): boolean {
    return this.status === 401;
  }

  get sinPermiso(): boolean {
    return this.status === 403;
  }
}

export const isApiError = (error: unknown): error is ApiError => error instanceof ApiError;

/** Mensaje listo para mostrar al usuario. */
export const apiErrorMessage = (error: unknown): string =>
  isApiError(error) ? error.detail : t('api.error.generico');

// --- Estado de sesión en memoria ------------------------------------------

let accessToken: string | null = null;
let sesionPerdidaNotificada = false;
let manejadorSesionPerdida: (() => void) | null = null;

export const getAccessToken = (): string | null => accessToken;

export const setAccessToken = (token: string | null): void => {
  accessToken = token;
  if (token !== null) sesionPerdidaNotificada = false;
};

/** `AuthProvider` registra aquí qué hacer cuando la sesión ya no se puede renovar. */
export const setSessionLostHandler = (handler: (() => void) | null): void => {
  manejadorSesionPerdida = handler;
};

const notificarSesionPerdida = (): void => {
  if (sesionPerdidaNotificada) return;
  sesionPerdidaNotificada = true;
  manejadorSesionPerdida?.();
};

// --- Lectura de la respuesta ----------------------------------------------

const esRegistro = (valor: unknown): valor is Record<string, unknown> =>
  typeof valor === 'object' && valor !== null;

const leerTexto = (fuente: Record<string, unknown>, clave: string): string | undefined => {
  const valor = fuente[clave];
  return typeof valor === 'string' && valor.length > 0 ? valor : undefined;
};

const leerErroresDeCampo = (fuente: Record<string, unknown>): ProblemFieldError[] => {
  const bruto = fuente['errors'];
  if (!Array.isArray(bruto)) return [];

  const errores: ProblemFieldError[] = [];
  for (const item of bruto) {
    if (!esRegistro(item)) continue;
    const path = leerTexto(item, 'path');
    const message = leerTexto(item, 'message');
    if (path === undefined || message === undefined) continue;
    const code = leerTexto(item, 'code');
    errores.push(code === undefined ? { path, message } : { path, message, code });
  }
  return errores;
};

/** Mensaje por defecto cuando el servidor no manda `detail` (nunca se muestra un código a secas). */
const mensajePorEstado = (status: number): string => {
  switch (status) {
    case 400:
      return t('api.error.400');
    case 401:
      return t('api.error.401');
    case 403:
      return t('api.error.403');
    case 404:
      return t('api.error.404');
    case 409:
      return t('api.error.409');
    case 422:
      return t('api.error.422');
    case 423:
      return t('api.error.423');
    case 429:
      return t('api.error.429');
    default:
      return status >= 500 ? t('api.error.500') : t('api.error.generico');
  }
};

const aApiError = (status: number, cuerpo: unknown): ApiError => {
  const problema = esRegistro(cuerpo) ? cuerpo : null;
  const fieldErrorList = problema ? leerErroresDeCampo(problema) : [];

  const fieldErrors: Record<string, string> = {};
  for (const error of fieldErrorList) {
    if (fieldErrors[error.path] === undefined) fieldErrors[error.path] = error.message;
  }

  return new ApiError({
    status,
    title: (problema && leerTexto(problema, 'title')) ?? t('api.titulo.error'),
    detail:
      (problema && leerTexto(problema, 'detail')) ??
      (problema && leerTexto(problema, 'title')) ??
      mensajePorEstado(status),
    fieldErrorList,
    fieldErrors,
    requestId: problema ? (leerTexto(problema, 'requestId') ?? null) : null,
    payload: problema,
  });
};

const leerCuerpo = async (response: Response): Promise<unknown> => {
  if (response.status === 204) return undefined;
  const texto = await response.text();
  if (texto.length === 0) return undefined;
  try {
    return JSON.parse(texto) as unknown;
  } catch {
    return undefined;
  }
};

const interpretar = async <T>(response: Response): Promise<T> => {
  if (!response.ok) throw aApiError(response.status, await leerCuerpo(response));

  const cuerpo = await leerCuerpo(response);

  // Un 200 sin JSON válido casi siempre significa que el proxy devolvió el
  // `index.html` en lugar de la respuesta de la API (típico en un despliegue
  // mal configurado). Mejor un error claro que un `undefined` que rompa la
  // pantalla al leer la primera propiedad.
  if (cuerpo === undefined && response.status !== 204 && response.status !== 205) {
    throw new ApiError({
      status: response.status,
      title: t('api.titulo.respuestaInvalida'),
      detail: t('api.error.respuestaInvalida'),
    });
  }

  return cuerpo as T;
};

// --- Transporte ------------------------------------------------------------

const construirUrl = (path: string, query?: QueryParams): string => {
  const url = `${API_BASE}${path}`;
  if (!query) return url;

  const params = new URLSearchParams();
  for (const [clave, valor] of Object.entries(query)) {
    if (valor === undefined || valor === null || valor === '') continue;
    params.set(clave, String(valor));
  }
  const cadena = params.toString();
  return cadena.length > 0 ? `${url}?${cadena}` : url;
};

const enviar = async (method: string, path: string, options: RequestOptions): Promise<Response> => {
  const headers = new Headers({ Accept: 'application/json' });
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');

  const token = getAccessToken();
  if (token !== null && options.anonymous !== true) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  try {
    return await fetch(construirUrl(path, options.query), {
      method,
      headers,
      // Sin `include` la cookie de refresco (httpOnly) no viaja.
      credentials: 'include',
      body:
        options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
      signal: options.signal,
    });
  } catch (causa) {
    if (options.signal?.aborted === true) {
      throw new ApiError({
        status: 0,
        title: t('api.titulo.cancelado'),
        detail: t('api.error.cancelado'),
        cause: causa,
      });
    }
    throw new ApiError({
      status: 0,
      title: t('api.titulo.sinConexion'),
      detail: t('api.error.sinConexion'),
      cause: causa,
    });
  }
};

// --- Renovación de la sesión (deduplicada) ---------------------------------

let renovacionEnCurso: Promise<LoginResponse> | null = null;

/** Renueva la sesión con la cookie de refresco y guarda el token nuevo. */
export const refreshSession = (): Promise<LoginResponse> => {
  if (renovacionEnCurso !== null) return renovacionEnCurso;

  renovacionEnCurso = solicitar<LoginResponse>('POST', '/auth/refresh', {
    anonymous: true,
    skipRefresh: true,
  })
    .then((respuesta) => {
      setAccessToken(respuesta.accessToken);
      return respuesta;
    })
    .finally(() => {
      renovacionEnCurso = null;
    });

  return renovacionEnCurso;
};

const intentarRenovarSesion = async (): Promise<boolean> => {
  // Sin token en memoria no había sesión que renovar: el 401 es la respuesta.
  if (getAccessToken() === null) return false;
  try {
    await refreshSession();
    return true;
  } catch {
    return false;
  }
};

const solicitar = async <T>(
  method: string,
  path: string,
  options: RequestOptions = {},
): Promise<T> => {
  const response = await enviar(method, path, options);

  if (response.status === 401 && options.skipRefresh !== true && options.anonymous !== true) {
    const renovada = await intentarRenovarSesion();
    if (renovada) return interpretar<T>(await enviar(method, path, options));
    notificarSesionPerdida();
  }

  return interpretar<T>(response);
};

/** Atajos por método: `api.get`, `api.post`, `api.patch`. */
export const api = {
  get: <T>(path: string, options?: Omit<RequestOptions, 'body'>): Promise<T> =>
    solicitar<T>('GET', path, options),
  post: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'body'>): Promise<T> =>
    solicitar<T>('POST', path, { ...options, body }),
  patch: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'body'>): Promise<T> =>
    solicitar<T>('PATCH', path, { ...options, body }),
  delete: <T>(path: string, options?: Omit<RequestOptions, 'body'>): Promise<T> =>
    solicitar<T>('DELETE', path, options),
  /** Petición con el cuerpo crudo (multipart); mantiene 401 → refresco → reintento. */
  request: <T>(method: string, path: string, options?: RequestOptions): Promise<T> =>
    solicitar<T>(method, path, options),
};

/** Respuesta binaria autenticada (descarga de adjuntos). */
export const apiBinary = async (
  method: string,
  path: string,
  options: Omit<RequestOptions, 'body' | 'rawBody'> = {},
): Promise<Blob> => {
  const pedir = async (): Promise<Response> => {
    const headers = new Headers({ Accept: '*/*' });
    const token = getAccessToken();
    if (token !== null && options.anonymous !== true) {
      headers.set('Authorization', `Bearer ${token}`);
    }
    try {
      return await fetch(construirUrl(path, options.query), {
        method,
        headers,
        credentials: 'include',
        signal: options.signal,
      });
    } catch (causa) {
      if (options.signal?.aborted === true) {
        throw new ApiError({
          status: 0,
          title: t('api.titulo.cancelado'),
          detail: t('api.error.cancelado'),
          cause: causa,
        });
      }
      throw new ApiError({
        status: 0,
        title: t('api.titulo.sinConexion'),
        detail: t('api.error.sinConexion'),
        cause: causa,
      });
    }
  };

  let response = await pedir();

  if (response.status === 401 && options.skipRefresh !== true) {
    const renovada = await intentarRenovarSesion();
    if (renovada) response = await pedir();
    else notificarSesionPerdida();
  }

  if (!response.ok) throw aApiError(response.status, await leerCuerpo(response));
  return response.blob();
};
