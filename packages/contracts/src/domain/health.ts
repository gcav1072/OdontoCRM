export const HEALTH_STATUSES = ['ok', 'degraded', 'error'] as const;
export type HealthStatus = (typeof HEALTH_STATUSES)[number];

export interface HealthCheckResult {
  /** Nombre corto de la dependencia verificada (`database`, `queue`, `telegram`…). */
  name: string;
  status: 'ok' | 'error';
  latencyMs: number;
  /** Mensaje legible; nunca incluye credenciales ni cadenas de conexión. */
  message?: string;
}

export interface HealthReport {
  service: string;
  version: string;
  status: HealthStatus;
  uptimeSeconds: number;
  timestamp: string;
  checks: HealthCheckResult[];
}

/**
 * `/health` responde siempre 200 mientras el proceso viva (sirve para que el
 * gestor de procesos reinicie); `/ready` responde 503 si una dependencia falla
 * (sirve para que el gateway deje de enviarle tráfico).
 */
export const readinessStatusCode = (report: HealthReport): 200 | 503 =>
  report.status === 'ok' ? 200 : 503;
