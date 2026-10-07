export const HEALTH_STATUSES = ['ok', 'degraded', 'error'] as const;
export type HealthStatus = (typeof HEALTH_STATUSES)[number];

export interface HealthCheckResult {
  /** Nombre corto de la dependencia verificada (`database`, `queue`, `telegram`…). */
  name: string;
  status: 'ok' | 'error';
  latencyMs: number;
  /** Mensaje legible; nunca incluye credenciales ni cadenas de conexión. */
  message?: string;
  /**
   * Cifras de la dependencia, cuando tienen sentido: conexiones del pool (`total`,
   * `idle`, `waiting`, `max`), eventos sin publicar del outbox (`pendientes`,
   * `masAntiguoSegundos`)… Son **números y etiquetas**, nunca secretos, y los pinta el
   * panel de estado del administrador para ver *cuánto* falla, no solo *que* falla.
   *
   * Va aquí y no en un endpoint aparte porque así viaja con el `/ready` que ya existe:
   * el gateway consolida el estado de los nueve servicios en una sola consulta.
   */
  details?: Record<string, unknown>;
}

export interface HealthReport {
  service: string;
  version: string;
  status: HealthStatus;
  uptimeSeconds: number;
  timestamp: string;
  checks: HealthCheckResult[];
}

/** Cabecera del gateway dentro del estado consolidado (es quien pregunta). */
export interface SystemHealthGateway {
  service: string;
  version: string;
  status: HealthStatus;
  uptimeSeconds: number;
  timestamp: string;
}

/** Estado de **un** servicio interno, tal como lo vio el gateway. */
export interface SystemHealthService {
  name: string;
  url: string;
  /** El servicio contestó (aunque contestara «no estoy listo»). */
  reachable: boolean;
  status: HealthStatus;
  version: string | null;
  uptimeSeconds: number | null;
  /** Cuánto tardó en contestar su `/ready`, en milisegundos. */
  latencyMs: number;
  checks: HealthCheckResult[];
  /** Por qué no se pudo leer (solo cuando `reachable` es `false`). */
  error: string | null;
}

/**
 * Estado consolidado del sistema (`GET /api/v1/system/health/detailed`, solo admin).
 *
 * El gateway no tiene base de datos ni cola propias: lo que aporta es la **agregación**
 * —pregunta a los nueve servicios a la vez y junta sus informes con su latencia—, que es
 * justo lo que no se puede hacer desde fuera sin conocer los nueve puertos.
 */
export interface SystemHealthReport {
  gateway: SystemHealthGateway;
  services: SystemHealthService[];
  /** Totales para el encabezado del panel (`ok` incluye los `degraded`). */
  totals: {
    ok: number;
    error: number;
    /** Servicios configurados que no contestaron. */
    unreachable: number;
    conOutboxAtrasado: number;
    latenciaMediaMs: number;
  };
  checkedAt: string;
}

/**
 * `/health` responde siempre 200 mientras el proceso viva (sirve para que el
 * gestor de procesos reinicie); `/ready` responde 503 si una dependencia falla
 * (sirve para que el gateway deje de enviarle tráfico).
 */
export const readinessStatusCode = (report: HealthReport): 200 | 503 =>
  report.status === 'ok' ? 200 : 503;
