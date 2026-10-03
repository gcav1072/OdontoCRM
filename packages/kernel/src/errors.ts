import {
  PROBLEM_CONTENT_TYPE,
  type ProblemDetails,
  type ProblemFieldError,
} from '@odontocrm/contracts';

/** Error de aplicación con la información mínima para construir la respuesta. */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly errors: ProblemFieldError[];
  /** Miembros extra que viajan en el cuerpo RFC 7807 (p. ej. `existingPatientId`). */
  readonly extensions: Record<string, unknown>;
  /** `true` cuando el error se puede mostrar al usuario tal cual. */
  readonly expose: boolean;

  constructor(options: {
    status: number;
    code: string;
    message: string;
    errors?: ProblemFieldError[];
    extensions?: Record<string, unknown>;
    expose?: boolean;
    cause?: unknown;
  }) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.status = options.status;
    this.code = options.code;
    this.errors = options.errors ?? [];
    this.extensions = options.extensions ?? {};
    this.expose = options.expose ?? options.status < 500;
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Los datos enviados no son válidos', errors?: ProblemFieldError[]) {
    super({ status: 400, code: 'validation_error', message, ...(errors ? { errors } : {}) });
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Debes iniciar sesión para continuar') {
    super({ status: 401, code: 'unauthorized', message });
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'No tienes permiso para realizar esta acción') {
    super({ status: 403, code: 'forbidden', message });
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'El recurso solicitado no existe') {
    super({ status: 404, code: 'not_found', message });
  }
}

export class ConflictError extends AppError {
  constructor(
    message = 'La operación choca con el estado actual del recurso',
    options: { extensions?: Record<string, unknown> } = {},
  ) {
    super({
      status: 409,
      code: 'conflict',
      message,
      ...(options.extensions === undefined ? {} : { extensions: options.extensions }),
    });
  }
}

export class TooManyRequestsError extends AppError {
  constructor(message = 'Demasiadas solicitudes: espera un momento') {
    super({ status: 429, code: 'too_many_requests', message });
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message = 'El servicio no está disponible en este momento') {
    super({ status: 503, code: 'service_unavailable', message, expose: true });
  }
}

/** Quita cualquier credencial que pudiera venir dentro de un mensaje de error. */
export const sanitizeMessage = (message: string, maxLength = 300): string => {
  const withoutCredentials = message
    .replace(/\/\/[^@\s/]+@/g, '//***@')
    .replace(/\b(password|token|secret)\s*[=:]\s*\S+/gi, '$1=***');
  return withoutCredentials.length > maxLength
    ? `${withoutCredentials.slice(0, maxLength)}…`
    : withoutCredentials;
};

export interface ToProblemOptions {
  requestId?: string;
  instance?: string;
  /** En producción los errores 5xx nunca revelan el mensaje interno. */
  production?: boolean;
}

export const toProblemDetails = (
  error: unknown,
  options: ToProblemOptions = {},
): ProblemDetails => {
  const isProduction = options.production ?? false;

  if (error instanceof AppError) {
    const problem: ProblemDetails = {
      type: `https://odontocrm.local/errors/${error.code}`,
      title: httpStatusTitle(error.status),
      status: error.status,
      detail: error.expose ? sanitizeMessage(error.message) : httpStatusTitle(error.status),
    };
    if (options.requestId !== undefined) problem.requestId = options.requestId;
    if (options.instance !== undefined) problem.instance = options.instance;
    if (error.errors.length > 0) problem.errors = error.errors;
    Object.assign(problem, error.extensions);
    return problem;
  }

  const status = 500;
  const problem: ProblemDetails = {
    type: 'https://odontocrm.local/errors/internal_error',
    title: httpStatusTitle(status),
    status,
    detail: isProduction
      ? 'Ocurrió un error inesperado. El equipo técnico revisará los registros.'
      : sanitizeMessage(error instanceof Error ? error.message : String(error)),
  };
  if (options.requestId !== undefined) problem.requestId = options.requestId;
  if (options.instance !== undefined) problem.instance = options.instance;
  return problem;
};

const HTTP_TITLES: Readonly<Record<number, string>> = {
  400: 'Solicitud incorrecta',
  401: 'No autenticado',
  403: 'Acceso denegado',
  404: 'No encontrado',
  409: 'Conflicto',
  422: 'Entidad no procesable',
  429: 'Demasiadas solicitudes',
  500: 'Error interno del servidor',
  503: 'Servicio no disponible',
};

export const httpStatusTitle = (status: number): string =>
  HTTP_TITLES[status] ?? `Error ${String(status)}`;

export { PROBLEM_CONTENT_TYPE };
export type { ProblemDetails, ProblemFieldError };
